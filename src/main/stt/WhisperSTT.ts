import * as fs from 'fs'
import * as path from 'path'
import { execFileUtf8 } from '../utils/spawn-utf8'
import type { Config } from '../config'
import { TencentASR } from './TencentASR'

interface STTService {
  transcribe(base64Audio: string): Promise<string>
}

export function createSTT(mode: 'local' | 'cloud' | 'tencent', config: Config): STTService {
  // Tencent real-time ASR via WebSocket
  if (mode === 'tencent') {
    return new TencentASR(config)
  }

  // Cloud Whisper (OpenAI API)
  const openaiKey = process.env.OPENAI_API_KEY || config.aiApiKey
  if (mode === 'cloud' || (!config.aiApiKey && openaiKey)) {
    return new CloudWhisper(openaiKey)
  }

  // Local whisper.cpp
  return new LocalWhisper(config.dataDir, config.whisperModel)
}

class LocalWhisper implements STTService {
  private dataDir: string
  private model: string
  private ready = false

  constructor(dataDir: string, model: string) {
    this.dataDir = path.join(dataDir, 'whisper')
    this.model = model
  }

  async transcribe(base64Audio: string): Promise<string> {
    await this.ensureReady()

    const tmpDir = path.join(this.dataDir, 'tmp')
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true })

    const webmPath = path.join(tmpDir, `audio_${Date.now()}.webm`)
    const wavPath = path.join(tmpDir, `audio_${Date.now()}.wav`)

    try {
      // Write webm
      fs.writeFileSync(webmPath, Buffer.from(base64Audio, 'base64'))

      // Convert to wav via ffmpeg
      const ffmpeg = require('ffmpeg-static') as string
      await this.run(ffmpeg, ['-i', webmPath, '-ar', '16000', '-ac', '1', '-f', 'wav', wavPath])

      // Run whisper
      const exe = this.findExe()
      if (!exe) throw new Error('whisper.cpp binary not found')

      const modelPath = path.join(this.dataDir, `ggml-${this.model}.bin`)
      const output = await this.run(exe, ['-m', modelPath, '-f', wavPath, '-l', 'zh', '--no-timestamps', '-t', '4'])

      // Extract text from output (skip system lines)
      const lines = output.split('\n').filter(l => l.trim() && !l.startsWith('[') && !l.includes('whisper_'))
      return lines.join(' ').trim()
    } finally {
      try { fs.unlinkSync(webmPath) } catch {}
      try { fs.unlinkSync(wavPath) } catch {}
    }
  }

  private findExe(): string | null {
    const candidates = [
      path.join(this.dataDir, 'Release', 'whisper-cli.exe'),
      path.join(this.dataDir, 'main.exe'),
    ]
    return candidates.find(p => fs.existsSync(p)) || null
  }

  private async ensureReady(): Promise<void> {
    if (this.ready) return
    if (!fs.existsSync(this.dataDir)) fs.mkdirSync(this.dataDir, { recursive: true })
    this.ready = true
  }

  private async run(cmd: string, args: string[]): Promise<string> {
    const { stdout } = await execFileUtf8(cmd, args, { timeout: 30_000 })
    return stdout
  }
}

class CloudWhisper implements STTService {
  private apiKey: string

  constructor(apiKey: string) {
    this.apiKey = apiKey
  }

  async transcribe(base64Audio: string): Promise<string> {
    const buffer = Buffer.from(base64Audio, 'base64')
    const blob = new Blob([buffer], { type: 'audio/webm' })

    const form = new FormData()
    form.append('file', blob, 'audio.webm')
    form.append('model', 'whisper-1')
    form.append('language', 'zh')

    const resp = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${this.apiKey}` },
      body: form,
    })

    if (!resp.ok) throw new Error(`Whisper API error: ${resp.status}`)
    const data = await resp.json() as { text: string }
    return data.text || ''
  }
}
