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
  private misfireTimer: ReturnType<typeof setTimeout> | null = null
  private aborted = false               // Flag to stop pipeline mid-flight
  private fetchController: AbortController | null = null  // For DirectAI cancellation

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
      // Only handle if we're still in recording state (not processing/aborted)
      if (!this.isProcessing && this.isRecording) {
        this.isRecording = false
        // Immediately transition to 'processing' — this triggers the VoiceRecorder
        // to stop recording (useEffect detects state change from 'recording').
        // The recorder's onstop callback will send audio via IPC.
        // UI stays visible — no flicker between recording → processing.
        this.sendState('processing')
        this.streamChunk('[system] 正在处理录音...')

        // Safety: if no audio arrives within 3s (recorder failed), hide
        this.misfireTimer = setTimeout(() => {
          if (!this.isProcessing && !this.pendingAudio) {
            console.log('[input] Misfire — no audio received, hiding')
            this.sendState('hidden')
          }
          this.misfireTimer = null
        }, 3000)
      }
    })

    // IPC: audio from renderer
    ipcMain.handle('voice:recording', async (_e: any, base64Audio: string) => {
      // Clear misfire timer — voice data arrived
      if (this.misfireTimer) { clearTimeout(this.misfireTimer); this.misfireTimer = null }
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
    this.aborted = false
    this.sendCommandText(text)
    try {
      await this.executePipeline(text)
    } catch (err) {
      if (!this.aborted) {
        this.sendState('error', err instanceof Error ? err.message : 'Execution failed')
      }
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
    this.aborted = false
    try {
      // Already in 'processing' state (set by longpressend)
      // Just update the stream text
      this.streamChunk('[system] 语音转文字中...')

      const text = await this.transcribe(this.pendingAudio)
      this.pendingAudio = null

      // Check if aborted during transcription
      if (this.aborted) return

      if (!text || text.trim().length === 0) {
        console.log('[voice] Empty transcription — hiding')
        this.sendState('hidden')
        return
      }

      console.log(`[voice] "${text}"`)

      // Send command text to renderer for persistent display
      this.sendCommandText(text)

      // Show recognized text briefly as a stream line (no state change, no flicker)
      this.streamChunk(`[system] 识别结果: "${text}"`)

      await this.executePipeline(text)
    } catch (err) {
      if (!this.aborted) {
        this.sendState('error', err instanceof Error ? err.message : 'Voice processing failed')
      }
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

    if (this.aborted) return

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

    if (this.aborted) return

    const display = screen.getPrimaryDisplay()
    const resolution = `${display.size.width}x${display.size.height}`

    // Show processing state
    this.sendState('processing')
    this.streamChunk(`[system] 通过 ${mode === 'agent' ? 'Agent CLI' : 'AI'} 执行...`)

    let result: ExecutionResult
    console.log(`[pipeline] Executing via ${mode === 'agent' && this.agent ? 'agent CLI' : 'direct AI'}...`)

    if (mode === 'direct' || !this.agent) {
      // Create AbortController for DirectAI fetch
      this.fetchController = new AbortController()
      result = await this.directAI.execute(command, context, resolution, this.fetchController.signal)
      this.fetchController = null
    } else {
      result = await this.executeViaAgent(command, context, resolution)
    }

    if (this.aborted) return

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

    // If the "result" is just a thinking fragment (not the final answer), use lastText from output stream
    let output = session.output
    if (!output || output.length < 10) {
      // Fallback: try to extract last meaningful text from stdout
      output = session.output || session.error || 'No output'
    }

    return {
      success: session.exitCode === 0 && !!output,
      output,
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
    parts.push(`1. Commands run through bash. Bash eats $variables. You MUST wrap PowerShell commands in SINGLE quotes to prevent bash from interpreting $:`)
    parts.push(`   CORRECT: powershell.exe -NoProfile -Command 'Get-ChildItem | Where-Object { $_.Name -match "pattern" }'`)
    parts.push(`   WRONG:   powershell.exe -NoProfile -Command "Get-ChildItem | Where-Object { $_.Name }"  ← bash eats $_`)
    parts.push(`2. EVERY PowerShell command MUST include this UTF-8 prefix (inside the single quotes):`)
    parts.push(`   $OutputEncoding=[Console]::InputEncoding=[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding;`)
    parts.push(`3. Use double quotes for paths INSIDE the single-quoted command: powershell.exe -NoProfile -Command '... "C:\\path\\中文" ...'`)
    parts.push(`4. ALWAYS use -LiteralPath (not -Path) for rename/move/copy with Chinese names.`)
    parts.push(`5. NEVER write .ps1 script files. NEVER use the Write tool for scripts. Always use inline one-liners.`)
    parts.push(`6. Execute DIRECTLY. Do NOT ask for permission.`)
    parts.push(`7. After executing, verify the result, then respond in Chinese.`)
    parts.push(``)
    parts.push(`## Correct Examples`)
    parts.push(`List files:  powershell.exe -NoProfile -Command '$OutputEncoding=[Console]::InputEncoding=[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding; Get-ChildItem | Select-Object Name'`)
    parts.push(`Rename:      powershell.exe -NoProfile -Command '$OutputEncoding=[Console]::InputEncoding=[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding; Get-ChildItem -LiteralPath "." | ForEach-Object { $n = "01_" + $_.Name; Rename-Item -LiteralPath $_.FullName -NewName $n }'`)
    parts.push(`Delete:      powershell.exe -NoProfile -Command '$OutputEncoding=[Console]::InputEncoding=[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding; Remove-Item -LiteralPath "file.txt" -Force'`)
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
      // Clear command text when hiding
      this.win.webContents.send('command-text', '')
    }

    // ESC abort: register when active, unregister when idle
    const activeStates: UIState[] = ['recording', 'transcribed', 'routing', 'processing', 'confirm', 'input']
    if (activeStates.includes(state)) {
      this.registerEscAbort()
    } else {
      this.unregisterEscAbort()
    }
  }

  private sendCommandText(text: string): void {
    this.win.webContents.send('command-text', text)
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
    console.log('[orchestrator] Abort triggered')
    this.unregisterEscAbort()
    this.aborted = true

    // Kill agent process tree
    if (this.currentAgentProcess) {
      const pid = this.currentAgentProcess.pid
      console.log(`[orchestrator] Killing agent process tree (pid=${pid})`)
      try {
        if (process.platform === 'win32' && pid) {
          // Use powershell to avoid bash path conversion issues with /T /F flags
          require('child_process').execFileSync(
            'taskkill.exe', ['/pid', String(pid), '/T', '/F'],
            { stdio: 'ignore', windowsHide: true },
          )
        } else {
          this.currentAgentProcess.kill('SIGTERM')
        }
      } catch (err) {
        console.log(`[orchestrator] taskkill failed (process may have exited): ${err}`)
      }
      this.currentAgentProcess = null
    }

    // Cancel DirectAI fetch
    if (this.fetchController) {
      this.fetchController.abort()
      this.fetchController = null
    }

    // Clear misfire timer
    if (this.misfireTimer) { clearTimeout(this.misfireTimer); this.misfireTimer = null }

    this.isProcessing = false
    this.isRecording = false
    this.pendingAudio = null
    this.lastAbortTime = Date.now()
    this.sendState('hidden')
    console.log('[orchestrator] Abort complete — all state reset')
  }
}
