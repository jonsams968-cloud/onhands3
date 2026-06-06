import { BrowserWindow, screen, ipcMain } from 'electron'
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
  private pendingAudio: string | null = null
  private pendingPosition = { x: 0, y: 0 }
  private pendingWindow: DesktopContext['activeWindow'] = null
  private stt: any = null

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
      this.pendingPosition = { x: e.x, y: e.y }
      this.pendingAudio = null
      this.pendingWindow = null

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
      // Don't send processing here — wait for voice recording to complete
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
      // TODO: kill running agent process
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
      timeoutMs: 120_000,
      onPermissionRequest: async (req) => {
        return this.requestPermission(req)
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

    parts.push(`You are OnHands, a desktop AI assistant. Execute the user's command.`)
    parts.push(`IMPORTANT: Always respond in Simplified Chinese (简体中文).`)
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
    parts.push(``)
    parts.push(`Execute this command. Use PowerShell for file/system operations. Respond with the RESULT, not a description.`)

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
  }

  private streamChunk(chunk: string): void {
    this.win.webContents.send('stream-chunk', chunk)
  }

  /**
   * Request permission from the user via the renderer UI.
   * Returns true if approved, false if denied or timed out.
   */
  private pendingPermissions = new Map<string, {
    resolve: (approved: boolean) => void
    timer: ReturnType<typeof setTimeout>
  }>()

  private requestPermission(req: import('../agents/types').PermissionRequest): Promise<boolean> {
    return new Promise((resolve) => {
      // 15-second timeout — auto-deny if user doesn't respond
      const timer = setTimeout(() => {
        this.pendingPermissions.delete(req.id)
        console.log(`[permission] Timeout: ${req.tool} — auto-denied`)
        resolve(false)
      }, 15_000)

      this.pendingPermissions.set(req.id, { resolve, timer })

      // Send permission request to renderer
      this.win.webContents.send('permission-request', {
        id: req.id,
        tool: req.tool,
        description: req.description,
        detail: req.detail,
      })

      console.log(`[permission] Requested: ${req.tool} — ${req.description}`)
    })
  }

  /** Handle permission answer from renderer */
  handlePermissionAnswer(id: string, approved: boolean): void {
    const pending = this.pendingPermissions.get(id)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pendingPermissions.delete(id)
    console.log(`[permission] ${id}: ${approved ? 'approved' : 'denied'}`)
    pending.resolve(approved)
  }
}
