import { BrowserWindow, screen, ipcMain, globalShortcut, app } from 'electron'
import { ChildProcess } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { MouseMonitor } from '../input/MouseMonitor'
import { SelectionMonitor } from '../input/SelectionMonitor'
import { injectText } from '../input/ClipboardInjector'
import { ContextCollector } from '../context/ContextCollector'
import { RecentHistory } from '../history/RecentHistory'
import { Router } from '../ai/Router'
import { DirectAI } from '../ai/DirectAI'
import { AgentDetector } from '../agents/AgentDetector'
import { ClaudeCodeAgent } from '../agents/ClaudeCodeAgent'
import type { Agent, AgentEvent } from '../agents/types'
import { loadConfig } from '../config'
import { PermissionServer } from '../permission/PermissionServer'
import type { DesktopContext, ExecutionResult, UIState } from '../../shared/types'
import type { AskRequest } from '../../shared/types'

// Regex to detect media marker in agent output
const MEDIA_MARKER_RE = /\[ONHANDS_MEDIA:(image|video):([^\]]+)\]/

// Bracket-counting parser for [ONHANDS_ASK:json] marker
// Handles nested JSON objects/arrays without false matches
function extractAskMarker(text: string): AskRequest | null {
  const marker = '[ONHANDS_ASK:'
  const start = text.indexOf(marker)
  if (start === -1) return null

  const jsonStart = text.indexOf('{', start + marker.length)
  if (jsonStart === -1) return null

  let depth = 0
  let inString = false
  let escape = false

  for (let i = jsonStart; i < text.length; i++) {
    const ch = text[i]

    if (escape) { escape = false; continue }
    if (ch === '\\' && inString) { escape = true; continue }
    if (ch === '"') { inString = !inString; continue }
    if (inString) continue

    if (ch === '{' || ch === '[') depth++
    else if (ch === '}' || ch === ']') {
      depth--
      if (depth === 0 && ch === '}') {
        // Check that marker closes with ] right after
        if (i + 1 < text.length && text[i + 1] === ']') {
          try {
            return JSON.parse(text.slice(jsonStart, i + 1))
          } catch {
            return null
          }
        }
      }
    }
  }
  return null  // Marker not yet complete
}

// Task queue snapshot — saves FULL context at queue time for later execution
interface QueuedTask {
  id: number
  command: string
  window: DesktopContext['activeWindow'] | null
  position: { x: number; y: number }
  selectedText: string | null
  // Full context snapshot (preserved independently from subsequent captures)
  screenshotPath: string | null
  clipboard: string | null
  selectedFiles: string[] | null
  workingDirectory: string | null
}

export class Orchestrator {
  private win: BrowserWindow
  private mouse: MouseMonitor
  private collector: ContextCollector
  private selectionMonitor: SelectionMonitor
  private router: Router
  private directAI: DirectAI
  private agentDetector: AgentDetector
  private agent: Agent | null = null
  private isProcessing = false
  private taskQueue: QueuedTask[] = []
  private taskQueueId = 0
  private pendingSelectedText: string | null = null
  private isQueuingRecording = false
  private isRecording = false
  private lastAbortTime = 0
  private pendingAudio: string | null = null
  private pendingPosition = { x: 0, y: 0 }
  private pendingWindow: DesktopContext['activeWindow'] = null
  private pendingDictation = false
  private stt: any = null
  private currentAgentProcess: ChildProcess | null = null
  private misfireTimer: ReturnType<typeof setTimeout> | null = null
  private aborted = false
  private fetchController: AbortController | null = null

  // ESC handler: long-press (5s) → force kill
  private escRegistered = false
  private escHoldStart = 0
  private escLastEvent = 0

  // Media regenerate support
  private lastMediaCommand = ''
  private lastMediaContext: DesktopContext | null = null
  private mediaTempDir = path.join(os.tmpdir(), 'onhands-media')

  // Permission system
  private permissionServer: PermissionServer | null = null

  // Phase 1: Recent history + processing timeout
  private history = new RecentHistory()
  private processingTimer: ReturnType<typeof setTimeout> | null = null

  // Ask protocol state
  private askDepth = 0                  // Max 2 nested ASK rounds
  private askSessionId: string | null = null  // Session to resume after user answers
  private askContext: DesktopContext | null = null  // Context to reuse on resume
  private askResolution = ''
  private askTimer: ReturnType<typeof setTimeout> | null = null

  constructor(win: BrowserWindow, mouse: MouseMonitor) {
    this.win = win
    this.mouse = mouse
    this.collector = new ContextCollector()
    this.selectionMonitor = new SelectionMonitor()
    this.router = new Router()
    this.directAI = new DirectAI()
    this.agentDetector = new AgentDetector()
  }

  async initialize(): Promise<void> {
    const config = loadConfig()

    // Detect available agents
    const preferred = await this.agentDetector.getPreferred()
    if (preferred) {
      this.agent = new ClaudeCodeAgent(preferred)
      console.log(`[orchestrator] Agent: ${preferred.displayName}`)
    } else {
      console.log('[orchestrator] No agent CLI detected — direct AI mode only')
    }

    // Start permission server
    if (config.defaultPermissionAction === 'ask') {
      this.permissionServer = new PermissionServer(
        this.win,
        config.permissionTimeout,
        config.permissionPort,
      )
      const started = await this.permissionServer.start()
      if (!started) {
        this.permissionServer = null
        console.warn('[orchestrator] Permission server failed — running without permission checks')
      }
    } else {
      console.log(`[orchestrator] Permission: default="${config.defaultPermissionAction}" — server not started`)
    }

    // Start selection monitor (background — captures text selections via accessibility APIs)
    try {
      await this.selectionMonitor.start()
    } catch (err) {
      console.warn(`[orchestrator] Selection monitor failed: ${err}`)
    }

    // Mouse events — capture window BEFORE showing overlay
    this.mouse.on('longpress', async (e: { x: number; y: number; isIBeam?: boolean }) => {
      if (Date.now() - this.lastAbortTime < 200) return
      this.pendingPosition = { x: e.x, y: e.y }
      this.pendingAudio = null
      this.pendingWindow = null
      this.pendingSelectedText = null
      this.isRecording = true

      // ─── Task already running → lightweight queue recording ───
      // Don't change overlay state — keep processing UI visible.
      // Just show a small recording indicator on top.
      if (this.isProcessing) {
        try {
          this.pendingWindow = await this.collector.captureActiveWindow()
          const sel = this.selectionMonitor.getLatestSelection()
          // Pass any selection as context to the agent
          if (sel) {
            this.collector.setSelectedText(sel.text)
            this.pendingSelectedText = sel.text
          }
          this.selectionMonitor.clearSelection()
          // For dictation routing, only very recent selections (< 5s) should prevent
          // dictation mode — older selections are likely from different apps/interactions
          if (e.isIBeam) {
            const recentSel = sel && (Date.now() - sel.timestamp < 5000) ? sel : null
            this.pendingDictation = !recentSel?.text
          } else {
            this.pendingDictation = false
          }
        } catch {
          this.pendingDictation = !!e.isIBeam
        }
        // Show recording indicator on top of current processing UI
        this.isQueuingRecording = true
        this.win.webContents.send('recording-queue', true)
        console.log('[input] Queue recording started — overlay unchanged')
        return
      }

      // ─── Normal path — no task running ───
      // Hide overlay first to capture the REAL foreground window
      if (this.win.isVisible()) {
        this.win.hide()
        this.win.setIgnoreMouseEvents(true, { forward: true })
      }

      // Always wait before capture — OS needs time to settle foreground window
      // even when overlay was already hidden (e.g. after abort)
      await new Promise(r => setTimeout(r, 80))

      try {
        this.pendingWindow = await this.collector.captureActiveWindow()
        console.log(`[input] Captured window: ${this.pendingWindow?.processName} — "${this.pendingWindow?.title?.slice(0, 40)}"`)

        // Get latest selection from background worker (captured via UIA/IAccessible in child process)
        const sel = this.selectionMonitor.getLatestSelection()
        // Pass any selection as context to the agent
        if (sel) {
          this.collector.setSelectedText(sel.text)
          this.pendingSelectedText = sel.text
        }
        this.selectionMonitor.clearSelection()

        // I-beam in text field + RECENT selected text → Agent mode (voice = instruction, selection = context)
        // I-beam in text field + NO recent selection → dictation mode (voice → text injection)
        // Only selections within 5s are considered "intentional" — older ones are likely
        // from different apps/interactions and should not block dictation mode
        if (e.isIBeam) {
          const recentSel = sel && (Date.now() - sel.timestamp < 5000) ? sel : null
          this.pendingDictation = !recentSel?.text
          console.log(`[input] I-beam cursor → ${this.pendingDictation ? 'dictation mode' : 'agent mode (selected text as context)'}${recentSel ? '' : sel ? ' (stale selection ignored)' : ''}`)
        } else {
          this.pendingDictation = false
        }
      } catch {
        this.pendingDictation = !!e.isIBeam
      }

      this.sendState('recording')
    })

    this.mouse.on('longpressend', () => {
      // Queuing recording ended — hide indicator, keep processing UI
      if (this.isQueuingRecording) {
        this.isQueuingRecording = false
        this.isRecording = false
        this.win.webContents.send('recording-queue', false)
        // Misfire timer: if no audio within 3s, silently ignore
        this.misfireTimer = setTimeout(() => {
          if (!this.pendingAudio) {
            console.log('[input] Queue recording misfire — no audio')
          }
          this.misfireTimer = null
        }, 3000)
        return
      }

      if (this.isRecording) {
        this.isRecording = false
        this.sendState('processing')
        this.streamChunk('[system] 正在处理录音...')

        this.misfireTimer = setTimeout(() => {
          if (!this.pendingAudio) {
            console.log('[input] Misfire — no audio received, hiding')
            this.sendState('hidden')
          }
          this.misfireTimer = null
        }, 3000)
      }
    })

    // IPC: audio from renderer
    ipcMain.handle('voice:recording', async (_e: any, base64Audio: string) => {
      if (this.misfireTimer) { clearTimeout(this.misfireTimer); this.misfireTimer = null }
      // Clear queue recording indicator
      if (this.isQueuingRecording) {
        this.isQueuingRecording = false
        this.win.webContents.send('recording-queue', false)
      }
      this.pendingAudio = base64Audio
      await this.processVoice()
    })

    ipcMain.handle('voice:error', async (_e: any, error: string) => {
      if (this.misfireTimer) { clearTimeout(this.misfireTimer); this.misfireTimer = null }

      // Queue recording error — don't disrupt current task
      if (this.isQueuingRecording) {
        this.isQueuingRecording = false
        this.isRecording = false
        this.win.webContents.send('recording-queue', false)
        console.log(`[voice] Queue recording error: ${error}`)
        return
      }

      if (error === 'silence') {
        console.log('[voice] No speech detected — silence')
        this.isProcessing = false
        this.isRecording = false
        this.sendState('result', '没听到声音，请重试')
        setTimeout(() => {
          if (!this.isProcessing) this.sendState('hidden')
        }, 3000)
      } else {
        console.error(`[stt] Recording error: ${error}`)
        this.isProcessing = false
        this.isRecording = false
        this.sendState('error', '麦克风不可用')
      }
    })

    // IPC: text command
    ipcMain.handle('text:command', async (_e: any, text: string) => {
      await this.processText(text)
    })

    // IPC: abort
    ipcMain.handle('action:abort', async () => {
      this.abort()
    })

    // IPC: ask answer (user clicked a button)
    ipcMain.handle('ask:answer', async (_e: any, optionLabel: string) => {
      this.handleAskAnswer(optionLabel)
    })

    // IPC: cancel a queued task
    ipcMain.handle('queue:cancel', async (_e: any, id: number) => {
      const idx = this.taskQueue.findIndex(t => t.id === id)
      if (idx !== -1) {
        const removed = this.taskQueue.splice(idx, 1)[0]
        console.log(`[queue] Cancelled task id=${id}: "${removed.command.slice(0, 50)}"`)
        this.sendQueueUpdate()
      }
    })

    console.log('[orchestrator] Ready')
  }

  async processText(text: string): Promise<void> {
    if (this.isProcessing) {
      this.enqueueTask(text)
      console.log(`[queue] Text task queued (#${this.taskQueue.length}): "${text.slice(0, 50)}"`)
      return
    }
    this.isProcessing = true
    this.aborted = false
    this.sendCommandText(text)
    this.startProcessingTimeout()
    try {
      await this.executePipeline(text)
    } catch (err) {
      if (!this.aborted) {
        this.sendState('error', err instanceof Error ? err.message : 'Execution failed')
      }
    } finally {
      this.isProcessing = false
      this.clearProcessingTimeout()
      // Show result briefly before starting next queue task
      if (this.taskQueue.length > 0 && !this.aborted) {
        await new Promise(r => setTimeout(r, 3000))
      }
      this.processQueue()
    }
  }

  /** Re-run last media generation command */
  async regenerateMedia(): Promise<void> {
    if (!this.lastMediaCommand || !this.lastMediaContext) return
    if (this.isProcessing) return
    this.isProcessing = true
    this.aborted = false
    this.sendCommandText(this.lastMediaCommand)
    try {
      await this.executePipeline(this.lastMediaCommand, true)
    } catch (err) {
      if (!this.aborted) {
        this.sendState('error', err instanceof Error ? err.message : 'Execution failed')
      }
    } finally {
      this.isProcessing = false
      this.processQueue()
    }
  }

  /** Copy media from temp to user's target directory */
  saveMedia(sourcePath: string, targetDir: string): string {
    const fileName = path.basename(sourcePath)
    let targetPath = path.join(targetDir, fileName)

    // Avoid overwriting existing files
    let counter = 1
    while (fs.existsSync(targetPath)) {
      const ext = path.extname(fileName)
      const base = path.basename(fileName, ext)
      targetPath = path.join(targetDir, `${base}_${counter}${ext}`)
      counter++
    }

    // Ensure target directory exists
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true })
    }

    fs.copyFileSync(sourcePath, targetPath)
    console.log(`[media] Saved: ${sourcePath} → ${targetPath}`)
    return targetPath
  }

  private async processVoice(): Promise<void> {
    if (!this.pendingAudio) {
      this.sendState('hidden')
      return
    }

    // ─── Another task is running → transcribe and queue (no UI change) ───
    if (this.isProcessing) {
      try {
        const text = await this.transcribe(this.pendingAudio)
        this.pendingAudio = null

        if (!text || text.trim().length === 0) {
          console.log('[voice] Empty queue transcription')
          return
        }

        console.log(`[voice] Queued: "${text}"`)

        // Dictation is quick — execute immediately even during processing (silent mode)
        if (this.pendingDictation) {
          this.pendingDictation = false
          await this.executeDictation(text, true)
          return
        }

        this.enqueueTask(text)
        this.streamChunk(`[system] ✓ 已排队: "${text.slice(0, 30)}"`)
      } catch (err) {
        console.error('[voice] Queue transcription failed:', err)
      }
      return
    }

    // ─── Normal path — no task running ───
    this.isProcessing = true
    this.aborted = false
    this.startProcessingTimeout()
    try {
      this.streamChunk('[system] 语音转文字中...')

      const text = await this.transcribe(this.pendingAudio)
      this.pendingAudio = null

      if (this.aborted) return

      if (!text || text.trim().length === 0) {
        console.log('[voice] Empty transcription — hiding')
        this.sendState('hidden')
        return
      }

      console.log(`[voice] "${text}"`)

      // ─── Dictation mode: clean up text and inject into input field ───
      if (this.pendingDictation) {
        await this.executeDictation(text)
        return
      }

      // ─── Normal command mode ───
      this.sendCommandText(text)
      this.streamChunk(`[system] 识别结果: "${text}"`)

      await this.executePipeline(text)
    } catch (err) {
      if (!this.aborted) {
        this.sendState('error', err instanceof Error ? err.message : 'Voice processing failed')
      }
    } finally {
      this.isProcessing = false
      this.pendingDictation = false
      this.clearProcessingTimeout()
      // Show result briefly before starting next queue task
      if (this.taskQueue.length > 0 && !this.aborted) {
        await new Promise(r => setTimeout(r, 3000))
      }
      this.processQueue()
    }
  }

  /**
   * Dictation mode: clean up ASR text and inject into the input field.
   *
   * Flow: raw ASR → DirectAI cleanup (remove filler words, apply corrections)
   * → clipboard inject via Ctrl+V → brief toast → auto-hide.
   *
   * @param silent When true (called during processing), don't change overlay state
   *               or stream chunks — just inject text transparently.
   */
  private async executeDictation(rawText: string, silent = false): Promise<void> {
    console.log(`[dictation] Raw: "${rawText}"${silent ? ' (silent)' : ''}`)

    if (!silent) {
      this.sendState('processing')
      this.streamChunk('[system] ✨ 整理听写内容...')
    }

    try {
      // Clean up dictation text via DirectAI
      this.fetchController = new AbortController()
      const result = await this.directAI.cleanDictation(rawText, this.fetchController.signal)
      this.fetchController = null
      const cleanText = result.output || rawText

      if (this.aborted) return

      console.log(`[dictation] Clean: "${cleanText}"`)

      if (silent) {
        // Silent mode: inject without touching overlay.
        // During processing the overlay is showInactive(), so the target window
        // is still the foreground window — SendInput goes to the right place.
        const injected = await injectText(cleanText)
        if (injected) {
          this.streamChunk(`[system] 📝 已听写: "${cleanText.slice(0, 30)}"`)
          console.log('[dictation] Silent injection successful')
        } else {
          this.streamChunk(`[system] 📝 听写完成 (请手动粘贴)`)
        }
        this.history.add({
          timestamp: Date.now(),
          command: `[dictation] ${rawText}`,
          resultSummary: cleanText.slice(0, 200),
          sourceWindow: this.pendingWindow?.processName || 'unknown',
          mode: 'dictation',
        })
        return
      }

      // CRITICAL: Hide overlay before injection so target window regains focus.
      // SendInput sends keystrokes to the foreground window — if overlay is
      // visible it would receive the characters instead of the input field.
      this.win.hide()
      this.win.setIgnoreMouseEvents(true, { forward: true })
      await new Promise(r => setTimeout(r, 100))  // Wait for target app to regain foreground

      const injected = await injectText(cleanText)

      if (this.aborted) return

      if (injected) {
        this.sendState('result', `📝 ${cleanText}`)
        this.history.add({
          timestamp: Date.now(),
          command: `[dictation] ${rawText}`,
          resultSummary: cleanText.slice(0, 200),
          sourceWindow: this.pendingWindow?.processName || 'unknown',
          mode: 'dictation',
        })
        console.log('[dictation] Text injected successfully')
      } else {
        // Fallback: show text in overlay for manual copy
        this.sendState('result', cleanText)
      }
    } catch (err) {
      console.warn('[dictation] Failed:', err)
      if (!silent) {
        this.sendState('result', rawText)
      }
    }
  }

  private async executePipeline(command: string, isRegenerate = false): Promise<void> {
    // Route FIRST — Router only handles obvious cases, agent handles ambiguity
    const mode = this.router.decide(command)
    console.log(`[pipeline] "${command}" → mode: ${mode}`)

    // Use the window captured at longpress time
    this.collector.setCapturedWindow(this.pendingWindow)

    // All context was captured at longpress time — just assemble it
    const context: DesktopContext = this.collector.collect()
    console.log(`[pipeline] Context: window=${context.activeWindow?.processName || 'none'}, workdir=${context.workingDirectory}, selectedFiles=${context.selectedFiles?.length || 0}, selectedText=${context.selectedText ? `${context.selectedText.length} chars` : 'none'}, screenshot=${context.screenshot ? 'yes' : 'no'}, clipboard=${context.clipboard ? `${context.clipboard.length} chars` : 'none'}`)

    if (this.aborted) return

    // ─── Media generation (image / video) → route to agent with API docs ───
    if (mode === 'image' || mode === 'video') {
      // Extend timeout for media generation (video polling can take minutes)
      this.startProcessingTimeout(true)

      // Save for regenerate
      if (!isRegenerate) {
        this.lastMediaCommand = command
        this.lastMediaContext = context
      }

      this.sendState('routing', mode)
      await new Promise(r => setTimeout(r, 400))
      if (this.aborted) return

      this.sendState('processing')
      this.streamChunk(`[system] 正在通过 Agent 生成${mode === 'image' ? '图片' : '视频'}...`)

      const result = await this.executeMediaViaAgent(command, context, mode)

      if (this.aborted) return

      // Check if agent output contains a media marker
      if (result.success && result.output) {
        if (this.tryShowMediaPreview(result.output, context)) {
          this.history.add({ timestamp: Date.now(), command, resultSummary: `${mode} generated successfully`, sourceWindow: context.activeWindow?.processName || 'unknown', mode })
          return
        }
      }

      // No media marker found — show as regular result
      this.history.add({ timestamp: Date.now(), command, resultSummary: (result.success ? result.output : result.error || 'Failed').slice(0, 200), sourceWindow: context.activeWindow?.processName || 'unknown', mode })
      if (result.success) {
        this.sendState('result', result.output)
      } else {
        this.sendState('error', result.error || result.output || `${mode === 'image' ? '图片' : '视频'}生成失败`)
      }
      return
    }

    // ─── Text pipeline (direct / agent) ───

    // Show routing decision
    this.sendState('routing', mode)
    await new Promise(r => setTimeout(r, 600))

    if (this.aborted) return

    const display = screen.getPrimaryDisplay()
    const resolution = `${display.size.width}x${display.size.height}`

    // Show processing state
    this.sendState('processing')
    this.streamChunk(`[system] 通过 ${mode === 'agent' ? 'Agent CLI' : 'AI'} 执行...`)

    let result: ExecutionResult
    console.log(`[pipeline] Executing via ${mode === 'agent' && this.agent ? 'agent CLI' : 'direct AI'}...`)

    if (mode === 'direct' || !this.agent) {
      this.fetchController = new AbortController()
      result = await this.directAI.execute(command, context, resolution, this.fetchController.signal)
      this.fetchController = null
    } else {
      result = await this.executeViaAgent(command, context, resolution)
    }

    if (this.aborted) return

    // ASK was triggered — don't show result, wait for user answer
    if (result.output === '__ASK_PENDING__') {
      console.log('[pipeline] ASK pending — waiting for user answer')
      return
    }

    console.log(`[pipeline] Done: success=${result.success}, output=${result.output?.slice(0, 100)}, duration=${result.durationMs}ms`)

    // Record to history (for follow-up context in future commands)
    this.history.add({
      timestamp: Date.now(),
      command,
      resultSummary: (result.success ? result.output : result.error || 'Failed').slice(0, 200),
      sourceWindow: context.activeWindow?.processName || 'unknown',
      mode,
    })

    // Check for media marker in any mode — agent might generate images on its own
    if (result.success && result.output && this.tryShowMediaPreview(result.output, context)) return

    if (result.success) {
      this.sendState('result', result.output)
    } else {
      this.sendState('error', result.error || result.output || 'Execution failed')
    }
  }

  /**
   * Execute media generation via agent with specialized prompt.
   * The agent receives Agnes API docs + credentials and handles everything.
   */
  private async executeMediaViaAgent(
    command: string,
    context: DesktopContext,
    mode: 'image' | 'video',
  ): Promise<ExecutionResult> {
    if (!this.agent) {
      return { success: false, output: 'No agent available', durationMs: 0, error: 'No agent CLI detected' }
    }

    const config = loadConfig()
    const prompt = this.buildMediaPrompt(command, context, mode, config.aiApiKey, config.aiBaseUrl)
    console.log(`[pipeline] Media agent prompt length: ${prompt.length} chars, tempDir: ${this.mediaTempDir}`)

    // Ensure temp directory exists
    if (!fs.existsSync(this.mediaTempDir)) {
      fs.mkdirSync(this.mediaTempDir, { recursive: true })
    }

    // Increase timeout for media generation (video can take minutes)
    const session = await this.agent.execute(prompt, {
      workingDirectory: context.workingDirectory,
      timeoutMs: 600_000,
      onProcessSpawn: (proc) => {
        this.currentAgentProcess = proc
      },
      onEvent: (ev: AgentEvent) => {
        if (ev.type === 'text') this.streamChunk(`[text] ${ev.text.slice(0, 120)}`)
        else if (ev.type === 'tool_use') this.streamChunk(`[tool] ${ev.name}`)
      },
    })

    this.currentAgentProcess = null
    console.log(`[pipeline] Media agent done: exitCode=${session.exitCode}`)

    let output = session.output
    if (!output || output.length < 10) {
      output = session.output || session.error || 'No output'
    }

    return {
      success: session.exitCode === 0 && !!output,
      output,
      durationMs: session.durationMs,
      error: session.error,
    }
  }

  private async executeViaAgent(command: string, context: DesktopContext, resolution: string): Promise<ExecutionResult> {
    if (!this.agent) {
      return { success: false, output: 'No agent available', durationMs: 0, error: 'No agent CLI detected' }
    }

    const prompt = this.buildAgentPrompt(command, context, resolution)
    console.log(`[pipeline] Agent prompt:\n${prompt.slice(0, 300)}...`)

    let askTriggered = false
    let capturedSessionId = ''  // Track session ID from stream events (session is TDZ during onEvent)

    const session = await this.agent.execute(prompt, {
      workingDirectory: context.workingDirectory,
      timeoutMs: 300_000,
      onProcessSpawn: (proc) => {
        this.currentAgentProcess = proc
      },
      onEvent: (ev: AgentEvent) => {
        if (askTriggered) return

        if (ev.type === 'text') {
          // Check for ASK marker in the text
          const ask = extractAskMarker(ev.text)
          if (ask && ask.options?.length > 0 && this.askDepth < 2) {
            console.log(`[ask] Detected: "${ask.question}" (${ask.options.length} options)`)
            askTriggered = true

            // Save state for resume — use capturedSessionId, NOT session (which is TDZ here)
            this.askSessionId = capturedSessionId || null
            this.askContext = context
            this.askResolution = resolution
            this.askDepth++

            // Show ask UI — send ask data as state-changed data (single IPC = atomic)
            this.sendState('ask', JSON.stringify(ask))

            // Set 30s timeout
            if (this.askTimer) clearTimeout(this.askTimer)
            this.askTimer = setTimeout(() => {
              console.log('[ask] Timeout — aborting')
              this.abort()
            }, 30_000)

            // Kill the agent process — will resume after user answers
            if (this.currentAgentProcess) {
              try {
                require('child_process').execFileSync(
                  'taskkill.exe', ['/pid', String(this.currentAgentProcess.pid), '/T', '/F'],
                  { stdio: 'ignore', windowsHide: true },
                )
              } catch {}
              this.currentAgentProcess = null
            }
            return
          }

          // Normal text streaming (skip the ASK marker itself)
          const displayText = ev.text.replace(/\[ONHANDS_ASK:[\s\S]*?\]/, '').trim()
          if (displayText) {
            this.streamChunk(`[text] ${displayText.slice(0, 120)}`)
          }
        } else if (ev.type === 'tool_use') {
          const detail = JSON.stringify(ev.input || {}).slice(0, 80)
          this.streamChunk(`[tool] ${ev.name}(${detail})`)
        } else if (ev.type === 'system') {
          if (ev.sessionId) capturedSessionId = ev.sessionId
        }
        // 'result' type: will be shown in result state — no action here
      },
    })

    // If ASK was triggered, don't process the result — waiting for user answer
    if (askTriggered) {
      this.currentAgentProcess = null
      return { success: true, output: '__ASK_PENDING__', durationMs: session.durationMs }
    }

    this.currentAgentProcess = null
    console.log(`[pipeline] Agent result: exitCode=${session.exitCode}, output=${session.output?.slice(0, 100)}`)

    // Crash detection: non-zero exit with no meaningful output
    if (session.exitCode !== 0 && session.exitCode !== null) {
      const crashMsg = session.error || `Agent 进程异常退出 (code=${session.exitCode})`
      console.warn(`[pipeline] Agent crash: ${crashMsg}`)
      return { success: false, output: crashMsg, durationMs: session.durationMs, error: crashMsg }
    }

    let output = session.output
    if (!output || output.length < 10) {
      output = session.output || session.error || 'No output'
    }

    return {
      success: session.exitCode === 0 && !!output,
      output,
      durationMs: session.durationMs,
      error: session.error,
    }
  }

  // ─── Prompt builders ───

  /**
   * Build a specialized agent prompt for media generation.
   * Includes Agnes API documentation, credentials, and context.
   */
  private buildMediaPrompt(
    command: string,
    context: DesktopContext,
    mode: 'image' | 'video',
    apiKey: string,
    baseUrl: string,
  ): string {
    const parts: string[] = []
    const isImage = mode === 'image'

    parts.push(`You are OnHands, a desktop AI assistant. The user wants to generate a ${isImage ? 'image' : 'video'}.`)
    parts.push(`Always respond in Simplified Chinese (简体中文).`)
    parts.push(``)
    parts.push(`## Task`)
    parts.push(`1. Determine the best prompt based on context priority: selected text > voice command > clipboard`)
    parts.push(`2. Call the Agnes API using a Node.js script (NOT PowerShell)`)
    parts.push(`3. Save the ${isImage ? 'image' : 'video'} to the temp directory`)
    parts.push(`4. After saving, include this EXACT marker on its own line in your final response:`)
    parts.push(`   [ONHANDS_MEDIA:${mode}:FULL_FILE_PATH]`)
    parts.push(`   Replace FULL_FILE_PATH with the actual saved file path.`)
    parts.push(``)
    parts.push(`## API Information`)
    parts.push(`- Base URL: ${baseUrl}`)
    parts.push(`- API Key: ${apiKey}`)
    parts.push(``)
    parts.push(`## CRITICAL: Use Node.js, NOT PowerShell`)
    parts.push(`PowerShell has encoding issues on Chinese Windows. ALWAYS use Node.js instead:`)
    parts.push(`  1. Write tool → save script to "${this.mediaTempDir}/_gen.js"`)
    parts.push(`  2. Bash tool → node "${this.mediaTempDir}/_gen.js"`)
    parts.push(`  3. Bash tool → del "${this.mediaTempDir}/_gen.js"`)
    parts.push(`NEVER use powershell.exe for API calls!`)
    parts.push(``)

    if (isImage) {
      const isImageFile = (f: string) => /\.(png|jpe?g|webp|bmp|gif)$/i.test(f)
      const selectedImages = context.selectedFiles?.filter(isImageFile) || []
      const isImg2Img = selectedImages.length > 0

      if (isImg2Img) {
        // Image-to-Image mode — editing an existing image
        parts.push(`## Image Editing API — IMAGE-TO-IMAGE MODE (agnes-image-2.1-flash)`)
        parts.push(`CRITICAL: The user selected an existing image to EDIT. You MUST use image-to-image, NOT text-to-image from scratch.`)
        parts.push(`Endpoint: POST ${baseUrl}/images/generations`)
        parts.push(`Headers: Authorization: Bearer ${apiKey}, Content-Type: application/json`)
        parts.push(``)
        parts.push(`Body for image-to-image:`)
        parts.push(`{`)
        parts.push(`  "model": "agnes-image-2.1-flash",`)
        parts.push(`  "prompt": "EDIT_INSTRUCTION + ' while preserving the original composition'",`)
        parts.push(`  "size": "1024x768",`)
        parts.push(`  "extra_body": {`)
        parts.push(`    "image": ["data:image/png;base64,BASE64_OF_SOURCE_IMAGE"],`)
        parts.push(`    "response_format": "b64_json"`)
        parts.push(`  }`)
        parts.push(`}`)
        parts.push(``)
        parts.push(`Source image to edit (read as base64 → put in extra_body.image):`)
        for (const f of selectedImages) {
          parts.push(`- ${f}`)
        }
        parts.push(``)
        parts.push(`### Node.js script template for img2img:`)
        parts.push(`const https = require('https'); const http = require('http'); const fs = require('fs');`)
        parts.push(`const url = new URL('${baseUrl}/images/generations');`)
        parts.push(`const srcB64 = fs.readFileSync('SOURCE_IMAGE_PATH').toString('base64');`)
        parts.push(`const body = JSON.stringify({model:'agnes-image-2.1-flash', prompt:'YOUR_EDIT_INSTRUCTION while preserving the original composition', size:'1024x768', extra_body:{image:['data:image/png;base64,'+srcB64], response_format:'b64_json'}});`)
        parts.push(`const req = (url.protocol === 'https:' ? https : http).request({hostname:url.hostname, port:url.port, path:url.pathname, method:'POST', headers:{'Authorization':'Bearer ${apiKey}','Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}}, res => {`)
        parts.push(`  let data=''; res.on('data',c=>data+=c); res.on('end',()=>{`)
        parts.push(`    const r=JSON.parse(data); const b64=r.data[0].b64_json||r.data[0].url;`)
        parts.push(`    if(b64&&b64.startsWith('http')){ http.get(b64,f=>{const s=fs.createWriteStream('SAVE_PATH');f.pipe(s);s.on('finish',()=>console.log('OK'))}); }`)
        parts.push(`    else if(b64){ fs.writeFileSync('SAVE_PATH',Buffer.from(b64,'base64')); console.log('OK'); }`)
        parts.push(`    else { console.error('No image data in response'); console.error(JSON.stringify(r).slice(0,500)); }`)
        parts.push(`  });`)
        parts.push(`});`)
        parts.push(`req.on('error',e=>console.error(e.message)); req.write(body); req.end();`)
        parts.push(``)
        parts.push(`IMPORTANT: Always pass source image in extra_body.image. NEVER generate from scratch when editing.`)
        parts.push(`Prompt MUST include "while preserving the original composition" to maintain image structure.`)
        parts.push(``)
      } else {
        // Text-to-Image mode — generating from scratch
        parts.push(`## Image Generation API (agnes-image-2.1-flash)`)
        parts.push(`Endpoint: POST ${baseUrl}/images/generations`)
        parts.push(`Headers: Authorization: Bearer ${apiKey}, Content-Type: application/json`)
        parts.push(`Body: { "model": "agnes-image-2.1-flash", "prompt": "...", "size": "1024x768", "return_base64": true }`)
        parts.push(`Response: { "data": [{ "b64_json": "..." }] }`)
        parts.push(``)
        parts.push(`### Node.js script template:`)
        parts.push(`const https = require('https'); const http = require('http'); const fs = require('fs');`)
        parts.push(`const url = new URL('${baseUrl}/images/generations');`)
        parts.push(`const body = JSON.stringify({model:'agnes-image-2.1-flash', prompt:'YOUR_PROMPT', size:'1024x768', return_base64:true});`)
        parts.push(`const req = (url.protocol === 'https:' ? https : http).request({hostname:url.hostname, port:url.port, path:url.pathname, method:'POST', headers:{'Authorization':'Bearer ${apiKey}','Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}}, res => {`)
        parts.push(`  let data=''; res.on('data',c=>data+=c); res.on('end',()=>{`)
        parts.push(`    const r=JSON.parse(data); const b64=r.data[0].b64_json||r.data[0].url;`)
        parts.push(`    if(b64.startsWith('http')){ http.get(b64,f=>{const s=fs.createWriteStream('SAVE_PATH');f.pipe(s);s.on('finish',()=>console.log('OK'))}); }`)
        parts.push(`    else{ fs.writeFileSync('SAVE_PATH',Buffer.from(b64,'base64')); console.log('OK'); }`)
        parts.push(`  });`)
        parts.push(`});`)
        parts.push(`req.on('error',e=>console.error(e.message)); req.write(body); req.end();`)
        parts.push(``)
      }
    } else {
      const duration = this.router.parseVideoDuration(command)
      const frameRate = 24
      const rawFrames = duration * frameRate
      const n = Math.round((rawFrames - 1) / 8)
      const numFrames = Math.min(n * 8 + 1, 441)

      // Check if user selected images → Image-to-Video mode
      const isImageFile = (f: string) => /\.(png|jpe?g|webp|bmp|gif)$/i.test(f)
      const selectedImages = context.selectedFiles?.filter(isImageFile) || []
      const hasImages = selectedImages.length > 0

      if (hasImages) {
        parts.push(`## Video Generation — IMAGE-TO-VIDEO MODE (agnes-video-v2.0)`)
        parts.push(`CRITICAL: The user selected image(s). You MUST use image-to-video mode, NOT text-to-video.`)
        parts.push(`The "image" parameter accepts a data URI (data:image/png;base64,...). Read the local image file as base64 and construct a data URI.`)
        parts.push(``)
        parts.push(`### Create video task with image`)
        parts.push(`POST ${baseUrl}/videos`)
        parts.push(`Headers: Authorization: Bearer ${apiKey}, Content-Type: application/json`)
        parts.push(`Body: { "model": "agnes-video-v2.0", "prompt": "MOTION_DESCRIPTION", "image": "data:image/png;base64,BASE64_OF_IMAGE", "num_frames": ${numFrames}, "frame_rate": ${frameRate} }`)
        parts.push(`Response: { "id": "task_xxx", "video_id": "video_xxx", "status": "queued" }`)
        parts.push(``)
        parts.push(`### Source images (MUST use at least one):`)
        for (const f of selectedImages) {
          parts.push(`- ${f}`)
        }
        parts.push(``)
      } else {
        parts.push(`## Video Generation — TEXT-TO-VIDEO MODE (agnes-video-v2.0)`)
        parts.push(`POST ${baseUrl}/videos`)
        parts.push(`Headers: Authorization: Bearer ${apiKey}, Content-Type: application/json`)
        parts.push(`Body: { "model": "agnes-video-v2.0", "prompt": "...", "width": 1152, "height": 768, "num_frames": ${numFrames}, "frame_rate": ${frameRate} }`)
        parts.push(`Response: { "id": "task_xxx", "video_id": "video_xxx", "status": "queued" }`)
        parts.push(``)
      }

      parts.push(`### Polling (CRITICAL — follow exactly)`)
      parts.push(`1. After task creation, save the "video_id" from the response`)
      parts.push(`2. Poll: GET ${baseUrl.split('/v1')[0]}/agnesapi?video_id=VIDEO_ID`)
      parts.push(`   Header: Authorization: Bearer ${apiKey}`)
      parts.push(`3. Poll every 10 seconds. Status values: "queued", "in_progress", "completed", "failed"`)
      parts.push(`4. When status === "completed", the video URL is in field "remixed_from_video_id" (NOT "video_url")`)
      parts.push(`5. When status === "failed", print error and exit with code 1`)
      parts.push(``)
      parts.push(`### Video duration: ${duration} seconds (${numFrames} frames at ${frameRate}fps)`)
      parts.push(`num_frames rule: must be 8n+1, max 441. Allowed: 81, 121, 161, 241, 441.`)
      parts.push(``)
      parts.push(`### Node.js script template (copy and adapt):`)
      parts.push(`const https = require('https'); const http = require('http'); const fs = require('fs');`)
      parts.push(`const baseUrl = '${baseUrl}'; const apiKey = '${apiKey}';`)
      parts.push(`function request(method, path, body) {`)
      parts.push(`  return new Promise((resolve, reject) => {`)
      parts.push(`    const url = new URL(path.startsWith('http') ? path : baseUrl + path);`)
      parts.push(`    const opts = { hostname: url.hostname, port: url.port, path: url.pathname + url.search, method, headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' } };`)
      parts.push(`    if (body) opts.headers['Content-Length'] = Buffer.byteLength(JSON.stringify(body));`)
      parts.push(`    const req = (url.protocol === 'https:' ? https : http).request(opts, res => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>{ try { resolve(JSON.parse(d)); } catch(e) { reject('Parse error: '+d.slice(0,200)); } }); });`)
      parts.push(`    req.on('error', reject); if (body) req.write(JSON.stringify(body)); req.end();`)
      parts.push(`  });`)
      parts.push(`}`)
      parts.push(`async function main() {`)
      parts.push(`  // 1. Create task`)
      parts.push(`  const task = await request('POST', '/v1/videos', { model: 'agnes-video-v2.0', prompt: 'YOUR_PROMPT'${hasImages ? `, image: 'IMAGE_URL'` : ', width: 1152, height: 768'}, num_frames: ${numFrames}, frame_rate: ${frameRate} });`)
      parts.push(`  console.log('Task created:', task.video_id, task.status);`)
      parts.push(`  if (task.status === 'failed') { console.error('Failed:', task.error); process.exit(1); }`)
      parts.push(`  // 2. Poll with video_id`)
      parts.push(`  const pollBase = '${baseUrl.split('/v1')[0]}/agnesapi';`)
      parts.push(`  for (let i = 0; i < 120; i++) {`)
      parts.push(`    await new Promise(r => setTimeout(r, 10000));`)
      parts.push(`    const r = await request('GET', pollBase + '?video_id=' + task.video_id);`)
      parts.push(`    console.log('Poll:', r.status, r.progress + '%');`)
      parts.push(`    if (r.status === 'completed') {`)
      parts.push(`      const videoUrl = r.remixed_from_video_id;`)
      parts.push(`      console.log('Downloading:', videoUrl);`)
      parts.push(`      const savePath = '${this.mediaTempDir}/agnes_video_' + Date.now() + '.mp4';`)
      parts.push(`      await new Promise((res, rej) => { http.get(videoUrl, resp => { const s = fs.createWriteStream(savePath); resp.pipe(s); s.on('finish', () => { console.log('SAVED:', savePath); res(); }); }).on('error', rej); });`)
      parts.push(`      return;`)
      parts.push(`    }`)
      parts.push(`    if (r.status === 'failed') { console.error('Failed:', r.error); process.exit(1); }`)
      parts.push(`  }`)
      parts.push(`  console.error('Timeout after 20min'); process.exit(1);`)
      parts.push(`}`)
      parts.push(`main().catch(e => { console.error(e); process.exit(1); });`)
      parts.push(``)
    }

    parts.push(`## File naming`)
    parts.push(`Save as: agnes_${mode}_YYYYMMDD_HHmmss.${isImage ? 'png' : 'mp4'}`)
    parts.push(`Save to: ${this.mediaTempDir}`)
    parts.push(``)

    // Context — priority order matters!
    if (context.selectedText) {
      parts.push(`## Selected Text (HIGHEST PRIORITY — use this as the generation prompt or combine with voice command)`)
      parts.push(context.selectedText.slice(0, 2000))
      parts.push(``)
    }

    if (context.selectedFiles && context.selectedFiles.length > 0) {
      const isImageFile = (f: string) => /\.(png|jpe?g|webp|bmp|gif)$/i.test(f)
      const imgFiles = context.selectedFiles.filter(isImageFile)
      if (isImage && imgFiles.length > 0) {
        parts.push(`## Source Images for Editing (USE THESE — do NOT ignore)`)
        parts.push(`You MUST read these files as base64 and pass them in extra_body.image for image-to-image editing.`)
        for (const f of imgFiles) {
          parts.push(`- ${f}`)
        }
        parts.push(``)
      } else {
        parts.push(`## Selected Files`)
        for (const f of context.selectedFiles) {
          parts.push(`- ${f}`)
        }
        parts.push(``)
      }
    }

    if (context.clipboard) {
      parts.push(`## Clipboard (background reference ONLY — ignore unless user explicitly asks about clipboard)`)
      parts.push(context.clipboard.slice(0, 1000))
      parts.push(``)
    }

    // Inject permission protocol if server is running
    if (this.permissionServer?.running) {
      parts.push(`## 危险操作权限协议 (MANDATORY)`)
      parts.push(`在执行以下操作前，必须先请求用户许可：`)
      parts.push(`- 文件删除（rm、Remove-Item、del）`)
      parts.push(`- 文件移动/重命名（mv、Move-Item、Rename-Item）`)
      parts.push(`- 强制 Git 操作（git push --force、git reset --hard）`)
      parts.push(`- 批量文件操作（影响5个以上文件）`)
      parts.push(`- 注册表/系统配置修改（reg、netsh、bcdedit）`)
      parts.push(`- 进程管理（taskkill、Stop-Process）`)
      parts.push(``)
      parts.push(`请求方法（用 node，支持中文，无转义问题）：`)
      parts.push(`  node -e "fetch('http://127.0.0.1:${this.permissionServer.port}/permission',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({tool:'工具名',description:'简短描述',detail:'完整命令'})}).then(r=>r.json()).then(d=>console.log(d.approved))"`)
      parts.push(`  返回 true 表示允许，false 表示拒绝（停止并告知用户）`)
      parts.push(`  注意：直接复制模板，只替换 tool/description/detail 的值，中文没问题`)
      parts.push(``)
    }

    // Inject recent history (for follow-up context like "再生成一张")
    const mediaHistory = this.history.formatForPrompt()
    if (mediaHistory) {
      parts.push(mediaHistory)
      parts.push(``)
    }

    parts.push(`## User Command`)
    parts.push(command)

    return parts.join('\n')
  }

  private buildAgentPrompt(command: string, context: DesktopContext, resolution: string): string {
    const parts: string[] = []
    const config = loadConfig()

    parts.push(`You are OnHands, a desktop AI assistant running on Windows 11.`)
    parts.push(`Always respond in Simplified Chinese (简体中文).`)
    parts.push(``)
    parts.push(`## SAFETY RULES (MANDATORY — NEVER VIOLATE)`)
    parts.push(`1. If the user explicitly says "delete", "remove", "move", "rename" — DO IT. The voice command IS the permission.`)
    parts.push(`2. NEVER overwrite existing files. Always use numbered suffixes (file_1.ext, file_2.ext).`)
    parts.push(`3. Before BATCH operations affecting 5+ files, LIST what you will do first.`)
    parts.push(`4. If a file operation fails, STOP and report — do NOT retry with force flags.`)
    parts.push(``)
    parts.push(`## Technical Rules`)
    parts.push(`1. Commands run through bash. Bash eats $variables. You MUST wrap PowerShell commands in SINGLE quotes to prevent bash from interpreting $:`)
    parts.push(`   CORRECT: powershell.exe -NoProfile -Command 'Get-ChildItem | Where-Object { $_.Name -match "pattern" }'`)
    parts.push(`   WRONG:   powershell.exe -NoProfile -Command "Get-ChildItem | Where-Object { $_.Name }"  ← bash eats $_`)
    parts.push(`2. EVERY PowerShell command MUST include this UTF-8 prefix (inside the single quotes):`)
    parts.push(`   $OutputEncoding=[Console]::InputEncoding=[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding;`)
    parts.push(`3. Use double quotes for paths INSIDE the single-quoted command: powershell.exe -NoProfile -Command '... "C:\\path\\中文" ...'`)
    parts.push(`4. Use -LiteralPath for Move-Item, Copy-Item, Rename-Item, Remove-Item with Chinese names.`)
    parts.push(`5. NEVER write .ps1 script files. ALWAYS use inline one-liners.`)
    parts.push(`6. ALWAYS provide the ACTUAL result — not a description of what you did or will do.`)
    parts.push(`7. If a command fails TWICE in a row, STOP and try a different method.`)
    parts.push(``)
    parts.push(`## Communication Protocol`)
    parts.push(`When you genuinely cannot determine the user's intent and MUST ask a question, output this EXACT marker:`)
    parts.push(`[ONHANDS_ASK:{"question":"你的问题","options":[{"label":"选项1","value":"opt1"},{"label":"选项2","value":"opt2"}]}]`)
    parts.push(`Rules:`)
    parts.push(`- If command + selectedText uniquely identifies intent → execute directly, NEVER ask`)
    parts.push(`- If command + selectedFiles uniquely identifies target → execute directly, NEVER ask`)
    parts.push(`- If command itself is clear enough → execute directly, NEVER ask`)
    parts.push(`- ONLY ask when genuinely ambiguous (e.g. no selectedText and "translate" — translate what?)`)
    parts.push(`- Keep 2-4 options, label < 20 chars, use Chinese for question and labels`)
    parts.push(`- NEVER ask in plain text — the user CANNOT respond to free-form questions`)
    parts.push(``)

    // Image generation — progressive disclosure
    const isImageFile = (f: string) => /\.(png|jpe?g|webp|bmp|gif)$/i.test(f)
    const selectedImages = context.selectedFiles?.filter(isImageFile) || []
    const hasSelectedImages = selectedImages.length > 0

    if (hasSelectedImages) {
      // User selected image files → inject full img2img API details
      parts.push(`## Image Editing Capability — IMAGE-TO-IMAGE MODE`)
      parts.push(`The user selected image(s) to edit. You MUST use image-to-image, NOT generate from scratch.`)
      parts.push(`Write a Node.js script to "${this.mediaTempDir}/_gen.js", then: node "${this.mediaTempDir}/_gen.js"`)
      parts.push(`API: POST ${config.aiBaseUrl}/images/generations`)
      parts.push(`Headers: Authorization: Bearer ${config.aiApiKey}, Content-Type: application/json`)
      parts.push(`Body: { "model": "agnes-image-2.1-flash", "prompt": "EDIT_INSTRUCTION while preserving the original composition", "size": "1024x768", "extra_body": { "image": ["data:image/png;base64,BASE64_OF_SOURCE"], "response_format": "b64_json" } }`)
      parts.push(`Read source image as base64: const b64 = fs.readFileSync('SOURCE_PATH').toString('base64')`)
      parts.push(`Response: { "data": [{ "b64_json": "..." }] } or { "data": [{ "url": "https://..." }] }`)
      parts.push(`Save to: ${this.mediaTempDir}/agnes_image_TIMESTAMP.png`)
      parts.push(`After saving, include: [ONHANDS_MEDIA:image:FULL_FILE_PATH]`)
      parts.push(`NEVER use PowerShell for API calls — use Node.js instead.`)
      parts.push(``)
    } else {
      // No image context → just a brief hint
      parts.push(`## Image Generation (available on demand)`)
      parts.push(`If user wants to generate/edit an image: API POST ${config.aiBaseUrl}/images/generations, model "agnes-image-2.1-flash", key ${config.aiApiKey}. Use Node.js script, save to "${this.mediaTempDir}/agnes_image_TIMESTAMP.png", include marker [ONHANDS_MEDIA:image:FULL_FILE_PATH].`)
      parts.push(``)
    }

    if (context.activeWindow) {
      parts.push(`## Current Environment`)
      parts.push(`- Active window: ${context.activeWindow.processName} — "${context.activeWindow.title}"`)
      parts.push(`- Working directory: ${context.workingDirectory}`)
      parts.push(`- Screen resolution: ${resolution}`)
      if (context.screenshotPath) {
        parts.push(`- Window screenshot: ${context.screenshotPath} (Read this file if you need to see what's on screen)`)
      }
      parts.push(``)
    }

    if (context.selectedFiles && context.selectedFiles.length > 0) {
      if (hasSelectedImages) {
        parts.push(`## Selected Images (source for img2img)`)
        for (const f of selectedImages) {
          parts.push(`- ${f}`)
        }
        parts.push(``)
      } else {
        parts.push(`## Selected Files`)
        for (const f of context.selectedFiles) {
          parts.push(`- ${f}`)
        }
        parts.push(``)
      }
    }

    if (context.selectedText) {
      parts.push(`## Selected Text`)
      parts.push(context.selectedText.slice(0, 2000))
      parts.push(``)
    }

    if (context.clipboard) {
      parts.push(`## Clipboard (background reference ONLY — ignore unless user explicitly asks about clipboard)`)
      parts.push(context.clipboard.slice(0, 4000))
      parts.push(``)
    }

    // Inject permission protocol if server is running
    if (this.permissionServer?.running) {
      parts.push(`## 危险操作权限协议 (MANDATORY)`)
      parts.push(`在执行以下操作前，必须先请求用户许可：`)
      parts.push(`- 文件删除（rm、Remove-Item、del）`)
      parts.push(`- 文件移动/重命名（mv、Move-Item、Rename-Item）`)
      parts.push(`- 强制 Git 操作（git push --force、git reset --hard）`)
      parts.push(`- 批量文件操作（影响5个以上文件）`)
      parts.push(`- 注册表/系统配置修改（reg、netsh、bcdedit）`)
      parts.push(`- 进程管理（taskkill、Stop-Process）`)
      parts.push(``)
      parts.push(`请求方法（用 node，支持中文，无转义问题）：`)
      parts.push(`  node -e "fetch('http://127.0.0.1:${this.permissionServer.port}/permission',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({tool:'工具名',description:'简短描述',detail:'完整命令'})}).then(r=>r.json()).then(d=>console.log(d.approved))"`)
      parts.push(`  返回 true 表示允许，false 表示拒绝（停止并告知用户）`)
      parts.push(`  注意：直接复制模板，只替换 tool/description/detail 的值，中文没问题`)
      parts.push(``)
    }

    // Inject recent history (for follow-up context)
    const historySection = this.history.formatForPrompt()
    if (historySection) {
      parts.push(historySection)
      parts.push(``)
    }

    parts.push(`## User Command`)
    parts.push(command)

    return parts.join('\n')
  }

  // ─── Task Queue ───

  private enqueueTask(command: string): void {
    const id = ++this.taskQueueId

    // Snapshot the current context from the collector
    const ctx = this.collector.collect()

    // Copy screenshot to a unique file so subsequent captures don't overwrite it
    let uniqueScreenshotPath: string | null = null
    if (ctx.screenshotPath && fs.existsSync(ctx.screenshotPath)) {
      uniqueScreenshotPath = path.join(os.tmpdir(), `onhands-screenshot-${id}.png`)
      try {
        fs.copyFileSync(ctx.screenshotPath, uniqueScreenshotPath)
      } catch {
        uniqueScreenshotPath = null
      }
    }

    this.taskQueue.push({
      id,
      command,
      window: this.pendingWindow,
      position: { ...this.pendingPosition },
      selectedText: this.pendingSelectedText,
      screenshotPath: uniqueScreenshotPath,
      clipboard: ctx.clipboard || null,
      selectedFiles: ctx.selectedFiles || null,
      workingDirectory: ctx.workingDirectory || null,
    })
    console.log(`[queue] Task queued (#${this.taskQueue.length}, id=${id}): "${command.slice(0, 50)}"`)
    this.sendQueueUpdate()
  }

  private sendQueueUpdate(): void {
    const items = this.taskQueue.map(t => ({ id: t.id, command: t.command }))
    this.win.webContents.send('queue-update', items)
  }

  private async processQueue(): Promise<void> {
    if (this.taskQueue.length === 0 || this.isProcessing) return
    const task = this.taskQueue.shift()!
    console.log(`[queue] Dequeuing task (${this.taskQueue.length} remaining): "${task.command.slice(0, 50)}"`)
    this.sendQueueUpdate()

    // Restore FULL context snapshot from queue time
    this.pendingWindow = task.window
    this.pendingPosition = task.position
    this.collector.setCapturedWindow(task.window)
    if (task.selectedText) this.collector.setSelectedText(task.selectedText)
    this.collector.restoreSnapshot({
      screenshotPath: task.screenshotPath,
      clipboard: task.clipboard,
      selectedFiles: task.selectedFiles,
      workingDirectory: task.workingDirectory,
    })

    // Clean up unique screenshot file after context is restored
    if (task.screenshotPath) {
      try { fs.unlinkSync(task.screenshotPath) } catch {}
    }

    this.isProcessing = true
    this.aborted = false
    this.startProcessingTimeout()
    this.sendCommandText(task.command)
    this.sendState('processing')
    this.streamChunk(`[system] 队列执行: "${task.command.slice(0, 30)}"`)

    try {
      await this.executePipeline(task.command)
    } catch (err) {
      if (!this.aborted) {
        this.sendState('error', err instanceof Error ? err.message : 'Execution failed')
      }
    } finally {
      this.isProcessing = false
      this.clearProcessingTimeout()
      // Show result briefly before starting next queue task
      if (this.taskQueue.length > 0 && !this.aborted) {
        await new Promise(r => setTimeout(r, 3000))
      }
      this.processQueue()
    }
  }

  // ─── Helpers ───

  /**
   * Check output for [ONHANDS_MEDIA:type:path] marker and show preview if found.
   * Works for ANY execution mode — media pipeline or general agent.
   *
   * When queue has pending tasks, auto-saves media to working directory instead
   * of showing interactive preview (preview would be immediately replaced anyway).
   * Returns true if media was handled.
   */
  private tryShowMediaPreview(output: string, context: DesktopContext): boolean {
    const match = output.match(MEDIA_MARKER_RE)
    if (!match) return false

    const mediaType = match[1] as 'image' | 'video'
    const filePath = match[2]
    console.log(`[pipeline] Media marker found: ${mediaType} at ${filePath}`)

    if (!fs.existsSync(filePath)) return false

    // Determine target save directory: user folder or Desktop
    const appDir = path.resolve(process.cwd())
    let targetDir = context.workingDirectory
    if (!targetDir || path.resolve(targetDir) === appDir) {
      targetDir = app.getPath('desktop')
    }

    // Queue has pending tasks → auto-save instead of interactive preview
    if (this.taskQueue.length > 0) {
      try {
        const savedPath = this.saveMedia(filePath, targetDir)
        const label = mediaType === 'image' ? '图片' : '视频'
        this.sendState('result', `${label}已保存到: ${path.basename(savedPath)}`)
        console.log(`[media] Auto-saved (queue active): ${savedPath}`)
      } catch (err) {
        console.error('[media] Auto-save failed:', err)
        this.sendState('result', `${mediaType}已生成: ${path.basename(filePath)}`)
      }
      return true
    }

    // No queue — show interactive preview
    const encodedPath = encodeURIComponent(filePath)
    this.win.webContents.send('state-changed', 'preview', JSON.stringify({
      type: mediaType,
      path: filePath,
      url: `onhands-media://${encodedPath}`,
      saveDir: targetDir,
    }))
    return true
  }

  private async transcribe(base64Audio: string): Promise<string> {
    if (!this.stt) {
      const { createSTT } = await import('../stt/WhisperSTT')
      const config = loadConfig()
      this.stt = createSTT(config.sttMode, config)
    }
    try {
      return await this.stt.transcribe(base64Audio)
    } catch (err: any) {
      // Cloud/Tencent STT failed — try local whisper as fallback
      const config = loadConfig()
      if (config.sttMode !== 'local') {
        console.warn(`[stt] ${config.sttMode} failed: ${err.message} — trying local whisper`)
        try {
          const { createSTT } = await import('../stt/WhisperSTT')
          const localSTT = createSTT('local', config)
          const result = await localSTT.transcribe(base64Audio)
          if (result.trim()) return result
        } catch (localErr: any) {
          console.error(`[stt] Local fallback also failed: ${localErr.message}`)
        }
      }
      throw err
    }
  }

  /** Start processing timeout to prevent permanent hangs. Default 5min, media mode 10min. */
  private startProcessingTimeout(mediaMode = false): void {
    this.clearProcessingTimeout()
    const timeoutMs = mediaMode ? 10 * 60 * 1000 : 5 * 60 * 1000
    this.processingTimer = setTimeout(() => {
      console.warn(`[orchestrator] Processing timeout (${timeoutMs / 60000}min) — auto-resetting`)
      this.sendState('error', '操作超时，已自动终止')
      this.abort()
    }, timeoutMs)
  }

  private clearProcessingTimeout(): void {
    if (this.processingTimer) { clearTimeout(this.processingTimer); this.processingTimer = null }
  }

  private sendState(state: UIState, data?: string): void {
    this.win.webContents.send('state-changed', state, data)
    if (state === 'hidden') {
      this.win.setIgnoreMouseEvents(true)
      this.win.hide()
      this.win.webContents.send('command-text', '')
    } else if (state === 'ask' || state === 'confirm' || state === 'preview') {
      // Ask/confirm/preview need immediate interactivity — activate window
      if (!this.win.isVisible()) this.win.show()
      this.win.setIgnoreMouseEvents(false)
      this.win.focus()
      this.win.moveTop()
    } else if (!this.win.isVisible()) {
      // Recording/processing/result/etc — show WITHOUT stealing focus
      // so target app stays in foreground (critical for SendInput injection)
      this.win.showInactive()
    }

    // ESC handler: register for active states (long-press 5s → force kill)
    // NOT for preview — renderer handles ESC for close via keydown event
    const escStates: UIState[] = ['recording', 'transcribed', 'routing', 'processing', 'confirm', 'input', 'ask']
    if (escStates.includes(state)) {
      this.registerEscHandler()
    } else {
      this.unregisterEscHandler()
    }
  }

  /** Handle user's answer to an ASK prompt — resume agent session */
  private async handleAskAnswer(optionLabel: string): Promise<void> {
    if (this.askTimer) { clearTimeout(this.askTimer); this.askTimer = null }
    if (!this.askSessionId || !this.agent) {
      console.log('[ask] No session to resume — aborting')
      this.resetAskState()
      this.sendState('hidden')
      return
    }

    console.log(`[ask] User chose: "${optionLabel}" — resuming session ${this.askSessionId.slice(0, 8)}...`)

    const resumePrompt = `用户选择了: "${optionLabel}"。请根据用户的选择继续执行。`
    this.sendState('processing')
    this.streamChunk(`[system] 用户选择了: ${optionLabel}`)

    try {
      let resumeSessionId = ''  // Track session ID from stream events (session is TDZ during onEvent)

      const session = await this.agent.resume(this.askSessionId, resumePrompt, {
        workingDirectory: this.askContext?.workingDirectory || process.cwd(),
        timeoutMs: 300_000,
        onProcessSpawn: (proc) => {
          this.currentAgentProcess = proc
        },
        onEvent: (ev: AgentEvent) => {
          if (ev.type === 'text') {
            const ask = extractAskMarker(ev.text)
            if (ask && ask.options?.length > 0 && this.askDepth < 2) {
              console.log(`[ask] Nested ask detected: "${ask.question}"`)
              this.askSessionId = resumeSessionId || this.askSessionId
              this.askDepth++

              this.sendState('ask', JSON.stringify(ask))

              if (this.askTimer) clearTimeout(this.askTimer)
              this.askTimer = setTimeout(() => {
                console.log('[ask] Timeout — aborting')
                this.abort()
              }, 30_000)

              if (this.currentAgentProcess) {
                try {
                  require('child_process').execFileSync(
                    'taskkill.exe', ['/pid', String(this.currentAgentProcess.pid), '/T', '/F'],
                    { stdio: 'ignore', windowsHide: true },
                  )
                } catch {}
                this.currentAgentProcess = null
              }
              return
            }
            const displayText = ev.text.replace(/\[ONHANDS_ASK:[\s\S]*?\]/, '').trim()
            if (displayText) this.streamChunk(`[text] ${displayText.slice(0, 120)}`)
          } else if (ev.type === 'tool_use') {
            const detail = JSON.stringify(ev.input || {}).slice(0, 80)
            this.streamChunk(`[tool] ${ev.name}(${detail})`)
          } else if (ev.type === 'system') {
            if (ev.sessionId) resumeSessionId = ev.sessionId
          }
        },
      })

      this.currentAgentProcess = null
      this.resetAskState()

      // Process result same as executePipeline
      let output = session.output
      if (!output || output.length < 10) {
        output = session.output || session.error || 'No output'
      }

      if (!this.tryShowMediaPreview(output, this.askContext || this.collector.collect())) {
        if (session.exitCode === 0 && output) {
          this.sendState('result', output)
        } else {
          this.sendState('error', output)
        }
      }

      setTimeout(() => {
        if (!this.isProcessing) this.sendState('hidden')
      }, 12000)
    } catch (err) {
      this.resetAskState()
      this.sendState('error', err instanceof Error ? err.message : 'Resume failed')
    } finally {
      this.isProcessing = false
      this.processQueue()
    }
  }

  private resetAskState(): void {
    if (this.askTimer) { clearTimeout(this.askTimer); this.askTimer = null }
    this.askDepth = 0
    this.askSessionId = null
    this.askContext = null
    this.askResolution = ''
  }

  private sendCommandText(text: string): void {
    this.win.webContents.send('command-text', text)
  }

  private streamChunk(chunk: string): void {
    this.win.webContents.send('stream-chunk', chunk)
  }

  handlePermissionAnswer(id: string, approved: boolean): void {
    this.permissionServer?.resolveRequest(id, approved)
  }

  /**
   * Register global ESC handler for long-press force kill.
   * Tracks auto-repeat events: if ESC is held continuously for 5s → force exit.
   * Single/double press does nothing (abort via UI button only).
   */
  private registerEscHandler(): void {
    if (this.escRegistered) return
    this.escRegistered = true
    this.escHoldStart = 0
    this.escLastEvent = 0
    try {
      globalShortcut.register('Escape', () => {
        const now = Date.now()

        // Auto-repeat fires every ~30-50ms when holding a key.
        // If gap between events < 150ms → still holding.
        if (this.escHoldStart && now - this.escLastEvent < 150) {
          // Held long enough? → force kill
          if (now - this.escHoldStart >= 5000) {
            this.forceKill()
            return
          }
        } else {
          // New press sequence (or released and re-pressed)
          this.escHoldStart = now
        }

        this.escLastEvent = now
      })
    } catch {}
  }

  private unregisterEscHandler(): void {
    if (!this.escRegistered) return
    this.escRegistered = false
    this.escHoldStart = 0
    this.escLastEvent = 0
    try { globalShortcut.unregister('Escape') } catch {}
  }

  /** Force kill — long-press ESC for 5 seconds */
  private forceKill(): void {
    console.log('[orchestrator] Force kill — ESC held for 5 seconds')
    // Kill agent process tree
    if (this.currentAgentProcess?.pid) {
      try {
        require('child_process').execFileSync(
          'taskkill.exe', ['/pid', String(this.currentAgentProcess.pid), '/T', '/F'],
          { stdio: 'ignore', windowsHide: true },
        )
      } catch {}
    }
    // Immediate exit — no cleanup
    process.exit(0)
  }

  abort(): void {
    console.log('[orchestrator] Abort triggered')
    this.permissionServer?.rejectAll()
    this.unregisterEscHandler()
    this.clearProcessingTimeout()
    this.aborted = true

    if (this.currentAgentProcess) {
      const pid = this.currentAgentProcess.pid
      console.log(`[orchestrator] Killing agent process tree (pid=${pid})`)
      try {
        if (process.platform === 'win32' && pid) {
          require('child_process').execFileSync(
            'taskkill.exe', ['/pid', String(pid), '/T', '/F'],
            { stdio: 'ignore', windowsHide: true },
          )
        } else {
          this.currentAgentProcess.kill('SIGTERM')
        }
      } catch (err) {
        console.log(`[orchestrator] taskkill failed: ${err}`)
      }
      this.currentAgentProcess = null
    }

    if (this.fetchController) {
      this.fetchController.abort()
      this.fetchController = null
    }

    if (this.misfireTimer) { clearTimeout(this.misfireTimer); this.misfireTimer = null }

    // Clear ask state if active
    this.resetAskState()

    this.isProcessing = false
    this.isRecording = false
    this.pendingAudio = null

    // Clean up queued task screenshot files before clearing
    for (const task of this.taskQueue) {
      if (task.screenshotPath) {
        try { fs.unlinkSync(task.screenshotPath) } catch {}
      }
    }
    this.taskQueue = []
    this.sendQueueUpdate()
    this.lastAbortTime = Date.now()
    this.sendState('hidden')
    console.log('[orchestrator] Abort complete — all state reset')
  }

  /** Full cleanup on app quit — kills all child processes */
  destroy(): void {
    this.permissionServer?.stop()
    this.selectionMonitor.destroy()
    this.clearProcessingTimeout()
    this.unregisterEscHandler()
    if (this.currentAgentProcess) {
      const pid = this.currentAgentProcess.pid
      console.log(`[orchestrator] Destroy: killing agent process tree (pid=${pid})`)
      try {
        if (process.platform === 'win32' && pid) {
          require('child_process').execFileSync(
            'taskkill.exe', ['/pid', String(pid), '/T', '/F'],
            { stdio: 'ignore', windowsHide: true },
          )
        } else {
          this.currentAgentProcess.kill('SIGKILL')
        }
      } catch {}
      this.currentAgentProcess = null
    }
    if (this.fetchController) {
      this.fetchController.abort()
      this.fetchController = null
    }
    if (this.misfireTimer) { clearTimeout(this.misfireTimer); this.misfireTimer = null }
  }
}
