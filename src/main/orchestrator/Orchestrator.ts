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

  // Permission system
  private permissionServer: PermissionServer | null = null

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

    // Mouse events — capture window BEFORE showing overlay
    this.mouse.on('longpress', async (e: { x: number; y: number }) => {
      if (this.isProcessing) return
      if (Date.now() - this.lastAbortTime < 200) return
      this.pendingPosition = { x: e.x, y: e.y }
      this.pendingAudio = null
      this.pendingWindow = null
      this.isRecording = true

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

    // IPC: ask answer (user clicked a button)
    ipcMain.handle('ask:answer', async (_e: any, optionLabel: string) => {
      this.handleAskAnswer(optionLabel)
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

    // All context was captured at longpress time — just assemble it
    const context: DesktopContext = this.collector.collect()
    console.log(`[pipeline] Context: window=${context.activeWindow?.processName || 'none'}, workdir=${context.workingDirectory}, selectedFiles=${context.selectedFiles?.length || 0}, selectedText=${context.selectedText ? `${context.selectedText.length} chars` : 'none'}, screenshot=${context.screenshot ? 'yes' : 'no'}, clipboard=${context.clipboard ? `${context.clipboard.length} chars` : 'none'}`)

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
        if (this.tryShowMediaPreview(result.output, context)) return
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

    // ASK was triggered — don't show result, wait for user answer
    if (result.output === '__ASK_PENDING__') {
      console.log('[pipeline] ASK pending — waiting for user answer')
      return
    }

    console.log(`[pipeline] Done: success=${result.success}, output=${result.output?.slice(0, 100)}, duration=${result.durationMs}ms`)

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

    let askTriggered = false
    let capturedSessionId = ''  // Track session ID from stream events (session is TDZ during onOutput)

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
                  // Check for ASK marker in the full accumulated text
                  const ask = extractAskMarker(b.text)
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
                    return  // Stop processing this chunk
                  }

                  // Normal text streaming (skip the ASK marker itself)
                  const displayText = b.text.replace(/\[ONHANDS_ASK:[\s\S]*?\]/, '').trim()
                  if (displayText) {
                    this.streamChunk(`[text] ${displayText.slice(0, 120)}`)
                  }
                }
                if (b.type === 'tool_use' && !askTriggered) {
                  const detail = JSON.stringify(b.input || {}).slice(0, 80)
                  this.streamChunk(`[tool] ${b.name}(${detail})`)
                }
              }
            } else if (type === 'result') {
              // Will be shown in result state
            } else if (type === 'system') {
              if (event.session_id) capturedSessionId = event.session_id
              this.streamChunk(`[system] session=${event.session_id?.slice(0, 8) || '?'}`)
            }
          } catch {
            if (!askTriggered) this.streamChunk(line.slice(0, 120))
          }
        }
      },
    })

    // If ASK was triggered, don't process the result — waiting for user answer
    if (askTriggered) {
      this.currentAgentProcess = null
      return { success: true, output: '__ASK_PENDING__', durationMs: session.durationMs }
    }

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

    parts.push(`## User Command`)
    parts.push(command)

    return parts.join('\n')
  }

  // ─── Helpers ───

  /**
   * Check output for [ONHANDS_MEDIA:type:path] marker and show preview if found.
   * Works for ANY execution mode — media pipeline or general agent.
   * Returns true if preview was shown.
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
      this.stt = createSTT(config.sttMode, config.aiApiKey, config.dataDir, config.whisperModel)
    }
    return this.stt.transcribe(base64Audio)
  }

  private sendState(state: UIState, data?: string): void {
    this.win.webContents.send('state-changed', state, data)
    if (!this.win.isVisible() && state !== 'hidden') {
      this.win.show()
    }
    if (state === 'hidden') {
      this.win.setIgnoreMouseEvents(true)
      this.win.hide()
      this.win.webContents.send('command-text', '')
    } else if (state === 'ask' || state === 'confirm') {
      // Ask/confirm need immediate interactivity — set in main process
      // (don't rely on renderer IPC round-trip which causes click-through delay)
      this.win.setIgnoreMouseEvents(false)
      this.win.focus()
      this.win.moveTop()
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
      let resumeSessionId = ''  // Track session ID from stream events (session is TDZ during onOutput)

      const session = await this.agent.resume(this.askSessionId, resumePrompt, {
        workingDirectory: this.askContext?.workingDirectory || process.cwd(),
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
                    const ask = extractAskMarker(b.text)
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
                    const displayText = b.text.replace(/\[ONHANDS_ASK:[\s\S]*?\]/, '').trim()
                    if (displayText) this.streamChunk(`[text] ${displayText.slice(0, 120)}`)
                  }
                  if (b.type === 'tool_use') {
                    const detail = JSON.stringify(b.input || {}).slice(0, 80)
                    this.streamChunk(`[tool] ${b.name}(${detail})`)
                  }
                }
              } else if (type === 'system') {
                if (event.session_id) resumeSessionId = event.session_id
              }
            } catch {
              this.streamChunk(line.slice(0, 120))
            }
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
    this.lastAbortTime = Date.now()
    this.sendState('hidden')
    console.log('[orchestrator] Abort complete — all state reset')
  }

  /** Full cleanup on app quit — kills all child processes */
  destroy(): void {
    this.permissionServer?.stop()
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
