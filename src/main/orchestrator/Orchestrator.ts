import { BrowserWindow, screen, ipcMain, globalShortcut, app } from 'electron'
import { ChildProcess } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { MouseMonitor } from '../input/MouseMonitor'
import { ContextCollector } from '../context/ContextCollector'
import { Router } from '../ai/Router'
import { DirectAI } from '../ai/DirectAI'
import { AgentDetector } from '../agents/AgentDetector'
import { ClaudeCodeAgent } from '../agents/ClaudeCodeAgent'
import type { Agent } from '../agents/types'
import { loadConfig } from '../config'
import type { DesktopContext, ExecutionResult, UIState } from '../../shared/types'

// Regex to detect media marker in agent output
const MEDIA_MARKER_RE = /\[ONHANDS_MEDIA:(image|video):([^\]]+)\]/

export class Orchestrator {
  private win: BrowserWindow
  private mouse: MouseMonitor
  private collector: ContextCollector
  private router: Router
  private directAI: DirectAI
  private agentDetector: AgentDetector
  private agent: Agent | null = null
  private isProcessing = false
  private isRecording = false
  private lastAbortTime = 0
  private pendingAudio: string | null = null
  private pendingPosition = { x: 0, y: 0 }
  private pendingWindow: DesktopContext['activeWindow'] = null
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
      if (Date.now() - this.lastAbortTime < 1000) return
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

      try {
        this.pendingWindow = await this.collector.captureActiveWindow()
        console.log(`[input] Captured window: ${this.pendingWindow?.processName} — "${this.pendingWindow?.title?.slice(0, 40)}"`)
      } catch {}

      this.sendState('recording')
    })

    this.mouse.on('longpressend', () => {
      if (!this.isProcessing && this.isRecording) {
        this.isRecording = false
        this.sendState('processing')
        this.streamChunk('[system] 正在处理录音...')

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
      if (this.misfireTimer) { clearTimeout(this.misfireTimer); this.misfireTimer = null }
      this.pendingAudio = base64Audio
      await this.processVoice()
    })

    ipcMain.handle('voice:error', async (_e: any, error: string) => {
      if (this.misfireTimer) { clearTimeout(this.misfireTimer); this.misfireTimer = null }

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
    if (!this.pendingAudio || this.isProcessing) {
      this.sendState('hidden')
      return
    }
    this.isProcessing = true
    this.aborted = false
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
      this.sendCommandText(text)
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

  private async executePipeline(command: string, isRegenerate = false): Promise<void> {
    // Route FIRST — Router only handles obvious cases, agent handles ambiguity
    const mode = this.router.decide(command)
    console.log(`[pipeline] "${command}" → mode: ${mode}`)

    // Use the window captured at longpress time
    this.collector.setCapturedWindow(this.pendingWindow)

    let context: DesktopContext
    try {
      context = await this.collector.collect(this.pendingPosition.x, this.pendingPosition.y)
      console.log(`[pipeline] Context: window=${context.activeWindow?.processName || 'none'}, workdir=${context.workingDirectory}, selectedFiles=${context.selectedFiles?.length || 0}, selectedText=${context.selectedText ? `${context.selectedText.length} chars` : 'none'}`)
    } catch (err) {
      console.log(`[pipeline] Context collection failed: ${err}`)
      context = { activeWindow: null, clipboard: null, workingDirectory: process.cwd() }
    }

    if (this.aborted) return

    // ─── Media generation (image / video) → route to agent with API docs ───
    if (mode === 'image' || mode === 'video') {
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
        const match = result.output.match(MEDIA_MARKER_RE)
        if (match) {
          const mediaType = match[1] as 'image' | 'video'
          const filePath = match[2]
          console.log(`[pipeline] Media generated: ${mediaType} at ${filePath}`)

          if (fs.existsSync(filePath)) {
            // Determine target save directory: user folder or Desktop
            const appDir = path.resolve(process.cwd())
            let targetDir = context.workingDirectory
            if (!targetDir || path.resolve(targetDir) === appDir) {
              targetDir = app.getPath('desktop')
            }

            const encodedPath = encodeURIComponent(filePath)
            this.win.webContents.send('state-changed', 'preview', JSON.stringify({
              type: mediaType,
              path: filePath,
              url: `onhands-media://${encodedPath}`,
              saveDir: targetDir,
            }))
            return
          }
        }
      }

      // No media marker found — show as regular result
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

    console.log(`[pipeline] Done: success=${result.success}, output=${result.output?.slice(0, 100)}, duration=${result.durationMs}ms`)

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
      onOutput: (chunk) => {
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
                  this.streamChunk(`[tool] ${b.name}`)
                }
              }
            }
          } catch {}
        }
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

    const session = await this.agent.execute(prompt, {
      workingDirectory: context.workingDirectory,
      timeoutMs: 300_000,
      onProcessSpawn: (proc) => {
        this.currentAgentProcess = proc
      },
      onOutput: (chunk) => {
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
            this.streamChunk(line.slice(0, 120))
          }
        }
      },
    })

    this.currentAgentProcess = null
    console.log(`[pipeline] Agent result: exitCode=${session.exitCode}, output=${session.output?.slice(0, 100)}`)

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
    } else {
      const duration = this.router.parseVideoDuration(command)
      const frameRate = 24
      const rawFrames = duration * frameRate
      const n = Math.round((rawFrames - 1) / 8)
      const numFrames = Math.min(n * 8 + 1, 441)

      parts.push(`## Video Generation API (agnes-video-v2.0)`)
      parts.push(`Endpoint: POST ${baseUrl}/videos (create task) + GET ${baseUrl}/videos/{task_id} (poll)`)
      parts.push(`Headers: Authorization: Bearer ${apiKey}, Content-Type: application/json`)
      parts.push(``)
      parts.push(`### Flow (use Node.js fetch, NOT PowerShell):`)
      parts.push(`1. Write .js script: create task → poll every 10s → download video → save`)
      parts.push(`2. Create task: POST body { "model": "agnes-video-v2.0", "prompt": "...", "width": 1152, "height": 768, "num_frames": ${numFrames}, "frame_rate": ${frameRate} }`)
      parts.push(`   num_frames rule: must be 8n+1, max 441. Allowed: 81, 121, 161, 241, 441.`)
      parts.push(`   Response: { "id": "task_xxx", "status": "queued" }`)
      parts.push(`3. Poll: GET ${baseUrl}/videos/task_xxx every 10 seconds until status is "completed"`)
      parts.push(`   Response: { "status": "completed", "video_url": "https://..." } or { "status": "processing", "progress": 50 }`)
      parts.push(`4. Download: use http.get(videoUrl).pipe(fs.createWriteStream('SAVE_PATH'))`)
      parts.push(``)
      parts.push(`### Video duration: ${duration} seconds (${numFrames} frames at ${frameRate}fps)`)
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
      parts.push(`## Selected Files`)
      for (const f of context.selectedFiles) {
        parts.push(`- ${f}`)
      }
      parts.push(``)
    }

    if (context.clipboard) {
      parts.push(`## Clipboard (use as fallback if no selected text and voice command is vague)`)
      parts.push(context.clipboard.slice(0, 1000))
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
    parts.push(`## Rules (CRITICAL)`)
    parts.push(`1. Commands run through bash. Bash eats $variables. You MUST wrap PowerShell commands in SINGLE quotes to prevent bash from interpreting $:`)
    parts.push(`   CORRECT: powershell.exe -NoProfile -Command 'Get-ChildItem | Where-Object { $_.Name -match "pattern" }'`)
    parts.push(`   WRONG:   powershell.exe -NoProfile -Command "Get-ChildItem | Where-Object { $_.Name }"  ← bash eats $_`)
    parts.push(`2. EVERY PowerShell command MUST include this UTF-8 prefix (inside the single quotes):`)
    parts.push(`   $OutputEncoding=[Console]::InputEncoding=[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding;`)
    parts.push(`3. Use double quotes for paths INSIDE the single-quoted command: powershell.exe -NoProfile -Command '... "C:\\path\\中文" ...'`)
    parts.push(`4. Use -LiteralPath for Move-Item, Copy-Item, Rename-Item, Remove-Item with Chinese names.`)
    parts.push(`5. NEVER write .ps1 script files. ALWAYS use inline one-liners.`)
    parts.push(`6. Execute DIRECTLY. Do NOT ask for permission.`)
    parts.push(`7. ALWAYS provide the ACTUAL result — not a description of what you did or will do.`)
    parts.push(`8. If a command fails TWICE in a row, STOP and try a different method.`)
    parts.push(``)

    // Image generation capability — agent decides when to use it
    const isImageFile = (f: string) => /\.(png|jpe?g|webp|bmp|gif)$/i.test(f)
    const hasImageContext = (context.selectedFiles?.some(isImageFile)) || context.selectedText

    if (hasImageContext || true) {  // Always include so agent can handle any image request
      parts.push(`## Image Generation Capability`)
      parts.push(`If you determine the user wants to generate, edit, or modify an image, use the Agnes Image API via a Node.js script:`)
      parts.push(`1. Write tool → save to "${this.mediaTempDir}/_gen.js"`)
      parts.push(`2. The script should use Node.js https/http module to call the API`)
      parts.push(`3. Bash tool → node "${this.mediaTempDir}/_gen.js"`)
      parts.push(`4. Bash tool → rm -f "${this.mediaTempDir}/_gen.js"`)
      parts.push(`API: POST ${config.aiBaseUrl}/images/generations`)
      parts.push(`Headers: Authorization: Bearer ${config.aiApiKey}, Content-Type: application/json`)
      parts.push(`Body: { "model": "agnes-image-2.1-flash", "prompt": "ENGLISH_PROMPT", "size": "1024x768", "return_base64": true }`)
      parts.push(`Response: { "data": [{ "b64_json": "..." }] }`)
      parts.push(`Save to: ${this.mediaTempDir}/agnes_image_TIMESTAMP.png`)
      parts.push(`After saving, include this EXACT marker: [ONHANDS_MEDIA:image:FULL_FILE_PATH]`)
      parts.push(`NEVER use PowerShell for API calls — use Node.js instead (avoids encoding issues).`)
      parts.push(``)
    }

    if (context.activeWindow) {
      parts.push(`## Current Environment`)
      parts.push(`- Active window: ${context.activeWindow.processName} — "${context.activeWindow.title}"`)
      parts.push(`- Working directory: ${context.workingDirectory}`)
      parts.push(`- Screen resolution: ${resolution}`)
      parts.push(``)
    }

    if (context.selectedFiles && context.selectedFiles.length > 0) {
      parts.push(`## User Selected Files (IMPORTANT)`)
      for (const f of context.selectedFiles) {
        parts.push(`- ${f}`)
      }
      parts.push(``)
    }

    if (context.selectedText) {
      parts.push(`## Selected Text`)
      parts.push(context.selectedText.slice(0, 2000))
      parts.push(``)
    }

    if (context.clipboard) {
      parts.push(`## Clipboard`)
      parts.push(context.clipboard.slice(0, 4000))
      parts.push(``)
    }

    parts.push(`## User Command`)
    parts.push(command)

    return parts.join('\n')
  }

  // ─── Helpers ───

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
      this.win.webContents.send('command-text', '')
    }

    // ESC handler: register for active states (long-press 5s → force kill)
    // NOT for preview — renderer handles ESC for close via keydown event
    const escStates: UIState[] = ['recording', 'transcribed', 'routing', 'processing', 'confirm', 'input']
    if (escStates.includes(state)) {
      this.registerEscHandler()
    } else {
      this.unregisterEscHandler()
    }
  }

  private sendCommandText(text: string): void {
    this.win.webContents.send('command-text', text)
  }

  private streamChunk(chunk: string): void {
    this.win.webContents.send('stream-chunk', chunk)
  }

  handlePermissionAnswer(_id: string, _approved: boolean): void {
    // Placeholder
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
    this.unregisterEscHandler()
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

    this.isProcessing = false
    this.isRecording = false
    this.pendingAudio = null
    this.lastAbortTime = Date.now()
    this.sendState('hidden')
    console.log('[orchestrator] Abort complete — all state reset')
  }

  /** Full cleanup on app quit — kills all child processes */
  destroy(): void {
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
