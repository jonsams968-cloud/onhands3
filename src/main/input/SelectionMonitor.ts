/**
 * Monitors text selection across all applications via a child process.
 *
 * WHY CHILD PROCESS:
 * selection-hook uses WH_MOUSE_LL (low-level mouse hook) to detect text
 * selections. This hook requires a standard Windows message pump. Electron's
 * Chromium message loop does NOT pump hook messages, so the callback never
 * fires in-process. Running in a separate Node.js process gives the hook
 * its own message loop.
 *
 * Architecture:
 *   SelectionMonitor (Electron main process)
 *     ↕ stdin/stdout JSON lines
 *   scripts/selection-worker.cjs (standalone Node.js process)
 *     ↕ WH_MOUSE_LL hook + UIA/IAccessible
 *   OS text selection events
 *
 * EVENT-BASED GATING:
 * The worker fires selection events for EVERY mouse action it interprets as
 * a selection — including false positives from single clicks (cursor
 * positioning). To filter these, SelectionMonitor emits a 'selection' event
 * rather than storing directly. The Orchestrator's state machine decides
 * whether to call storeSelection() based on mouse-action state.
 */

import { EventEmitter } from 'events'
import { spawn, type ChildProcess } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'

export interface CapturedSelection {
  text: string
  programName: string
  timestamp: number
}

const METHOD_NAMES: Record<number, string> = {
  1: 'UIA', 3: 'IAccessible', 11: 'AXAPI', 22: 'PRIMARY', 99: 'Clipboard'
}

export class SelectionMonitor extends EventEmitter {
  private worker: ChildProcess | null = null
  private latestSelection: CapturedSelection | null = null
  private running = false

  async start(): Promise<void> {
    if (this.running) return

    const workerPath = this.getWorkerPath()

    try {
      // Use the Electron binary (process.execPath) as the Node runtime.
      // In production, system 'node' is not available — the app bundles only Electron.
      // ELECTRON_RUN_AS_NODE=1 makes the Electron binary behave as pure Node.js.
      this.worker = spawn(process.execPath, [workerPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        windowsHide: true,
      })

      // Parse JSON lines from worker stdout
      let buffer = ''
      this.worker.stdout!.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8')
        const lines = buffer.split('\n')
        buffer = lines.pop()! // keep incomplete line

        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const msg = JSON.parse(line)
            this.handleWorkerMessage(msg)
          } catch {}
        }
      })

      this.worker.stderr!.on('data', (chunk: Buffer) => {
        console.error(`[selection:worker] ${chunk.toString('utf8').trim()}`)
      })

      this.worker.on('exit', (code) => {
        console.log(`[selection] Worker exited (code=${code})`)
        this.running = false
        this.worker = null
      })

      this.worker.on('error', (err) => {
        console.error(`[selection] Worker spawn failed: ${err.message}`)
        this.running = false
        this.worker = null
      })

      this.running = true
      console.log('[selection] Worker spawned — waiting for status...')
    } catch (err) {
      console.warn(`[selection] Failed to spawn worker: ${err instanceof Error ? err.message : err}`)
    }
  }

  /**
   * Resolve the selection-worker.cjs path.
   * - Production: packaged into resources/scripts/ via electron-builder extraResources
   * - Dev: scripts/ relative to project root (process.cwd())
   */
  private getWorkerPath(): string {
    const prodPath = path.join(process.resourcesPath || '', 'scripts', 'selection-worker.cjs')
    if (process.resourcesPath && fs.existsSync(prodPath)) {
      return prodPath
    }
    return path.join(process.cwd(), 'scripts', 'selection-worker.cjs')
  }

  private handleWorkerMessage(msg: any): void {
    if (msg.type === 'status') {
      if (msg.started) {
        console.log('[selection] Monitor started (UIA + IAccessible + Clipboard fallback)')
      } else {
        console.warn('[selection] Worker failed to start hook')
        this.running = false
      }
    } else if (msg.type === 'selection') {
      if (msg.text && msg.text.trim()) {
        const selection: CapturedSelection = {
          text: msg.text,
          programName: msg.programName || '',
          timestamp: Date.now(),
        }
        // Emit — Orchestrator's state machine decides whether to store.
        // For 'snapshot' results (msg.snapshot === true), also emit a
        // separate 'snapshot' event so the Orchestrator can store it
        // directly, bypassing the state machine (which would discard it
        // since snapshot is requested AFTER maction, when state is already
        // 'pending' but the passive-event timing window has passed).
        this.emit('selection', selection)
        if (msg.snapshot) {
          this.emit('snapshot', selection)
        }
        console.log(
          `[selection] ${msg.text.length} chars from ${msg.programName || '?'} ` +
          `(${METHOD_NAMES[msg.method] || msg.method})${msg.snapshot ? ' [snapshot]' : ''}`
        )
      }
    } else if (msg.type === 'snapshot-empty') {
      // Worker confirmed: no current selection. Emit so any pending
      // requestSnapshot() promise can resolve with null.
      this.emit('snapshot-empty')
    } else if (msg.type === 'error') {
      console.error(`[selection] Worker error: ${msg.message}`)
    }
  }

  /**
   * Store a selection manually. Called by the Orchestrator state machine
   * when a mouse-action pattern indicates a genuine selection (drag/dblclick/trplclick).
   */
  storeSelection(sel: CapturedSelection): void {
    this.latestSelection = sel
  }

  /**
   * Request an authoritative snapshot of the current selection from the worker.
   * Returns a Promise that resolves with the selection (or null if none).
   *
   * This is the fix for the timing race where passive 'text-selection' events
   * arrive DURING a drag (before the maction is classified), getting discarded
   * by the state machine. By the time maction fires, the selection is stable
   * and we can query it directly.
   */
  requestSnapshot(timeoutMs = 500): Promise<CapturedSelection | null> {
    return new Promise((resolve) => {
      if (!this.worker || !this.running) {
        resolve(null)
        return
      }

      let settled = false
      const finish = (result: CapturedSelection | null) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.off('snapshot', onSnapshot)
        this.off('snapshot-empty', onEmpty)
        resolve(result)
      }

      const onSnapshot = (sel: CapturedSelection) => finish(sel)
      const onEmpty = () => finish(null)

      this.once('snapshot', onSnapshot)
      this.once('snapshot-empty', onEmpty)

      const timer = setTimeout(() => finish(null), timeoutMs)

      try {
        this.worker.stdin!.write(JSON.stringify({ cmd: 'snapshot' }) + '\n')
      } catch {
        finish(null)
      }
    })
  }

  /**
   * Get the most recent text selection captured by the background worker.
   * Returns null if no selection exists or it's older than maxAgeMs.
   */
  getLatestSelection(maxAgeMs = 30_000): CapturedSelection | null {
    if (!this.latestSelection) return null

    const age = Date.now() - this.latestSelection.timestamp
    if (age > maxAgeMs) return null

    return this.latestSelection
  }

  /** Clear the stored selection (e.g. after consuming it) */
  clearSelection(): void {
    this.latestSelection = null
  }

  stop(): void {
    if (this.worker) {
      try {
        this.worker.stdin!.write(JSON.stringify({ cmd: 'stop' }) + '\n')
      } catch {}
      this.running = false
    }
  }

  destroy(): void {
    if (this.worker) {
      try {
        this.worker.stdin!.write(JSON.stringify({ cmd: 'stop' }) + '\n')
      } catch {}
      try { this.worker.kill() } catch {}
      this.worker = null
    }
    this.latestSelection = null
    this.running = false
  }
}
