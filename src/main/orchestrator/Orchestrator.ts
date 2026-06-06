import { BrowserWindow, screen, ipcMain, globalShortcut } from 'electron'
import { ChildProcess } from 'child_process'
import { MouseMonitor } from '../input/MouseMonitor'
import { ContextCollector } from '../context/ContextCollector'
import { Router } from '../ai/Router'
import { DirectAI } from '../ai/DirectAI'
import { AgentDetector } from '../agents/AgentDetector'
import { ClaudeCodeAgent } from '../agents/ClaudeCodeAgent'
import type { Agent } from '../agents/types'
import { loadConfig } from '../config'
import type { DesktopContext, ExecutionResult, UIState } from '../../shared/types'

export class Orchestrator {
  private win: BrowserWindow
  private mouse: MouseMonitor
  private collector: ContextCollector
  private router: Router
  private directAI: DirectAI
  private agentDetector: AgentDetector
  private agent: Agent | null = null
  private isProcessing = false
  private isRecording = false           // Track if we're actively recording
  private lastAbortTime = 0             // Cooldown after abort
  private pendingAudio: string | null = null
  private pendingPosition = { x: 0, y: 0 }
  private pendingWindow: DesktopContext['activeWindow'] = null
  private stt: any = null
  private currentAgentProcess: ChildProcess | null = null

  // Double-ESC abort tracking
  private lastEscPress = 0
  private escRegistered = false

  constructor(win: BrowserWindow, mouse: MouseMonitor) {
    this.win = win
    this.mouse = mouse
    this.collector = new ContextCollector()
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

    // Mouse events — capture window BEFORE showing overlay
    this.mouse.on('longpress', async (e: { x: number; y: number }) => {
      if (this.isProcessing) return
      if (Date.now() - this.lastAbortTime < 1000) return  // 1s cooldown after abort
      this.pendingPosition = { x: e.x, y: e.y }
      this.pendingAudio = null
      this.pendingWindow = null
      this.isRecording = true

      // Hide overlay first to capture the REAL foreground window
      if (this.win.isVisible()) {
        this.win.hide()
        this.win.setIgnoreMouseEvents(true)
        await new Promise(r => setTimeout(r, 50))
      }

      // Snapshot the active window NOW
      try {
        this.pendingWindow = await this.collector.captureActiveWindow()
        console.log(`[input] Captured window: ${this.pendingWindow?.processName} — "${this.pendingWindow?.title?.slice(0, 40)}"`)
      } catch {}

      this.sendState('recording')
    })

    this.mouse.on('longpressend', () => {
      // Only transition away from recording if we ARE recording
      // Prevents re-triggering after result/error state
      if (!this.isProcessing && this.isRecording) {
        this.isRecording = false
        this.sendState('transcribed', '')
      }
    })

    // IPC: audio from renderer
    ipcMain.handle('voice:recording', async (_e: any, base64Audio: string) => {
      this.pendingAudio = base64Audio
      await this.processVoice()
    })

    ipcMain.handle('voice:error', async (_e: any, error: string) => {
      console.error(`[stt] Recording error: ${error}`)
      this.sendState('error', '麦克风不可用')
    })

    // IPC: text command
    ipcMain.handle('text:command', async (_e: any, text: string) => {
      await this.processText(text)
    })

    // IPC: abort
    ipcMain.handle('action:abort', async () => {
      this.abort()
    })

    console.log('[orchestrator] Ready')
  }

  async processText(text: string): Promise<void> {
    if (this.isProcessing) return
    this.isProcessing = true
    try {
      await this.executePipeline(text)
    } catch (err) {
      this.sendState('error', err instanceof Error ? err.message : 'Execution failed')
    } finally {
      this.isProcessing = false
    }
  }

  private async processVoice(): Promise<void> {
    if (!this.pendingAudio || this.isProcessing) {
      this.sendState('hidden')
      return
    }
    this.isProcessing = true
    try {
      // Show processing while transcribing
      this.sendState('processing')
      this.streamChunk('[system] 语音转文字中...')

      const text = await this.transcribe(this.pendingAudio)
      this.pendingAudio = null
      if (!text || text.trim().length === 0) {
        this.sendState('hidden')
        return
      }

      console.log(`[voice] "${text}"`)

      // Show transcribed text briefly
      this.sendState('transcribed', text)
      await new Promise(r => setTimeout(r, 1500))

      await this.executePipeline(text)
    } catch (err) {
      this.sendState('error', err instanceof Error ? err.message : 'Voice processing failed')
    } finally {
      this.isProcessing = false
    }
  }

  private async executePipeline(command: string): Promise<void> {
    const mode = this.router.decide(command)
    console.log(`[pipeline] "${command}" → mode: ${mode}`)

    // Show routing decision
    this.sendState('routing', mode)
    await new Promise(r => setTimeout(r, 600))

    // Use the window captured at longpress time
    this.collector.setCapturedWindow(this.pendingWindow)

    let context: DesktopContext
    try {
      context = await this.collector.collect(this.pendingPosition.x, this.pendingPosition.y)
      console.log(`[pipeline] Context: window=${context.activeWindow?.processName || 'none'}, workdir=${context.workingDirectory}`)
    } catch (err) {
      console.log(`[pipeline] Context collection failed: ${err}`)
      context = { activeWindow: null, clipboard: null, workingDirectory: process.cwd() }
    }

    const display = screen.getPrimaryDisplay()
    const resolution = `${display.size.width}x${display.size.height}`

    // Show processing state
    this.sendState('processing')
    this.streamChunk(`[system] 通过 ${mode === 'agent' ? 'Agent CLI' : 'AI'} 执行...`)

    let result: ExecutionResult
    console.log(`[pipeline] Executing via ${mode === 'agent' && this.agent ? 'agent CLI' : 'direct AI'}...`)

    if (mode === 'direct' || !this.agent) {
      result = await this.directAI.execute(command, context, resolution)
    } else {
      result = await this.executeViaAgent(command, context, resolution)
    }

    console.log(`[pipeline] Done: success=${result.success}, output=${result.output?.slice(0, 100)}, duration=${result.durationMs}ms`)

    if (result.success) {
      this.sendState('result', result.output)
    } else {
      this.sendState('error', result.error || result.output || 'Execution failed')
    }
  }

  private async executeViaAgent(command: string, context: DesktopContext, resolution: string): Promise<ExecutionResult> {
    if (!this.agent) {
      return { success: false, output: 'No agent available', durationMs: 0, error: 'No agent CLI detected' }
    }

    const prompt = this.buildAgentPrompt(command, context, resolution)
    console.log(`[pipeline] Agent prompt:\n${prompt.slice(0, 300)}...`)

    const session = await this.agent.execute(prompt, {
      workingDirectory: context.workingDirectory,
      timeoutMs: 300_000,
      onProcessSpawn: (proc) => {
        this.currentAgentProcess = proc
      },
      onOutput: (chunk) => {
        // Parse stream-json events and send human-readable lines to renderer
        for (const line of chunk.split('\n')) {
          if (!line.trim()) continue
          try {
            const event = JSON.parse(line)
            const type = event.type || '?'

            if (type === 'assistant') {
              const blocks = event.message?.content || []
              for (const b of blocks) {
                if (b.type === 'text' && b.text) {
                  this.streamChunk(`[text] ${b.text.slice(0, 120)}`)
                }
                if (b.type === 'tool_use') {
                  const detail = JSON.stringify(b.input || {}).slice(0, 80)
                  this.streamChunk(`[tool] ${b.name}(${detail})`)
                }
              }
            } else if (type === 'result') {
              // Will be shown in result state
            } else if (type === 'system') {
              this.streamChunk(`[system] session=${event.session_id?.slice(0, 8) || '?'}`)
            }
          } catch {
            // Not JSON — just forward as-is
            this.streamChunk(line.slice(0, 120))
          }
        }
      },
    })

    this.currentAgentProcess = null
    console.log(`[pipeline] Agent result: exitCode=${session.exitCode}, output=${session.output?.slice(0, 100)}`)

    return {
      success: session.exitCode === 0 && !!session.output,
      output: session.output,
      durationMs: session.durationMs,
      error: session.error,
    }
  }

  private buildAgentPrompt(command: string, context: DesktopContext, resolution: string): string {
    const parts: string[] = []

    parts.push(`You are OnHands, a desktop AI assistant running on Windows 11.`)
    parts.push(`Always respond in Simplified Chinese (简体中文).`)
    parts.push(``)
    parts.push(`## Rules (CRITICAL)`)
    parts.push(`1. ALL file/system operations MUST use PowerShell. Format: powershell.exe -NoProfile -Command "..."`)
    parts.push(`2. EVERY PowerShell command MUST start with the UTF-8 prefix:`)
    parts.push(`   $OutputEncoding=[Console]::InputEncoding=[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding;`)
    parts.push(`   This sets all three encoding variables (pipe output, console output, console input) to UTF-8.`)
    parts.push(`   NEVER use chcp 65001 inside PowerShell — it is ineffective (.NET caches encoding at startup).`)
    parts.push(`3. NEVER use bash commands (ls, mv, cp, rm, cat, mkdir). Use PowerShell equivalents (Get-ChildItem, Move-Item, Copy-Item, Remove-Item, Get-Content, New-Item).`)
    parts.push(`4. Paths with non-ASCII characters MUST be wrapped in single quotes: 'C:\\Users\\Decory\\Desktop\\新建文件夹'`)
    parts.push(`5. Use -LiteralPath instead of -Path for any path containing brackets, spaces, or non-ASCII characters.`)
    parts.push(`6. When writing .ps1 scripts or text files, ALWAYS use UTF-8 with BOM: [System.IO.File]::WriteAllText($path, $content, [System.Text.UTF8Encoding]::new($true))`)
    parts.push(`7. Execute DIRECTLY. Do NOT ask for permission or explain what you will do.`)
    parts.push(`8. After executing, verify the result is correct, then respond with the final outcome in Chinese.`)
    parts.push(``)

    if (context.activeWindow) {
      parts.push(`## Current Environment`)
      parts.push(`- Active window: ${context.activeWindow.processName} — "${context.activeWindow.title}"`)
      parts.push(`- Working directory: ${context.workingDirectory}`)
      parts.push(`- Screen resolution: ${resolution}`)
      parts.push(``)
    }

    if (context.clipboard) {
      parts.push(`## Clipboard / Selected Content`)
      parts.push(context.clipboard.slice(0, 4000))
      parts.push(``)
    }

    parts.push(`## User Command`)
    parts.push(command)

    return parts.join('\n')
  }

  private async transcribe(base64Audio: string): Promise<string> {
    if (!this.stt) {
      const { createSTT } = await import('../stt/WhisperSTT')
      const config = loadConfig()
      this.stt = createSTT(config.sttMode, config.aiApiKey, config.dataDir, config.whisperModel)
    }
    return this.stt.transcribe(base64Audio)
  }

  private sendState(state: UIState, data?: string): void {
    this.win.webContents.send('state-changed', state, data)
    if (!this.win.isVisible() && state !== 'hidden') {
      this.win.show()
      this.win.setIgnoreMouseEvents(false)
    }
    if (state === 'hidden') {
      this.win.setIgnoreMouseEvents(true)
      this.win.hide()
    }

    // ESC abort: register when active, unregister when idle
    const activeStates: UIState[] = ['recording', 'transcribed', 'routing', 'processing', 'confirm', 'input']
    if (activeStates.includes(state)) {
      this.registerEscAbort()
    } else {
      this.unregisterEscAbort()
    }
  }

  private streamChunk(chunk: string): void {
    this.win.webContents.send('stream-chunk', chunk)
  }

  /** Handle permission answer from renderer (reserved for future use) */
  handlePermissionAnswer(_id: string, _approved: boolean): void {
    // Placeholder — permission system can be enhanced later
  }

  /** Register ESC as global shortcut for double-press abort */
  private registerEscAbort(): void {
    if (this.escRegistered) return
    this.escRegistered = true
    try {
      globalShortcut.register('Escape', () => {
        const now = Date.now()
        if (now - this.lastEscPress < 500) {
          // Double ESC — abort everything
          this.lastEscPress = 0
          this.abort()
        } else {
          this.lastEscPress = now
        }
      })
    } catch { /* may fail if already registered */ }
  }

  /** Unregister ESC shortcut */
  private unregisterEscAbort(): void {
    if (!this.escRegistered) return
    this.escRegistered = false
    this.lastEscPress = 0
    try { globalShortcut.unregister('Escape') } catch {}
  }

  /** Abort the current agent/processing operation — kills entire process tree */
  abort(): void {
    this.unregisterEscAbort()
    if (this.currentAgentProcess) {
      const pid = this.currentAgentProcess.pid
      console.log(`[orchestrator] Aborting agent process tree (pid=${pid})`)
      try {
        if (process.platform === 'win32' && pid) {
          // Windows: taskkill /T kills the entire process tree, /F forces
          require('child_process').execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore' })
        } else {
          this.currentAgentProcess.kill('SIGTERM')
        }
      } catch {}
      this.currentAgentProcess = null
    }
    this.isProcessing = false
    this.isRecording = false
    this.pendingAudio = null
    this.lastAbortTime = Date.now()
    this.sendState('hidden')
    console.log('[orchestrator] Abort complete — all state reset')
  }
}
