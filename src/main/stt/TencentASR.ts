/**
 * 腾讯云实时语音识别 WebSocket 后端
 * 文档: https://cloud.tencent.com/document/product/1093/48982
 *
 * 流程:
 * 1. 将 base64 webm → PCM via ffmpeg
 * 2. 生成 HMAC-SHA1 签名，建立 WebSocket 连接
 * 3. 分片发送 PCM 音频流
 * 4. 收集识别结果（含中间结果 + 最终结果）
 */

import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { createHmac, randomUUID } from 'crypto'
import { execFileUtf8 } from '../utils/spawn-utf8'
import type { Config } from '../config'

interface ASRResult {
  code: number
  message: string
  voice_id?: string
  message_id?: string
  result?: string | ASRResultData
  final?: number   // 1=识别结束
}

interface ASRResultData {
  slice_type: number  // 0=start, 1=middle, 2=end (stable)
  index: number       // Sentence index — increments for each sentence
  voice_text_str: string
}

export class TencentASR {
  private secretId: string
  private secretKey: string
  private appId: string

  constructor(config: Config) {
    this.secretId = config.tencentSecretId
    this.secretKey = config.tencentSecretKey
    this.appId = config.tencentAppId
  }

  async transcribe(base64Audio: string): Promise<string> {
    if (!this.secretId || !this.secretKey || !this.appId) {
      throw new Error('腾讯云 ASR 配置不完整 (TENCENT_SECRET_ID / TENCENT_SECRET_KEY / TENCENT_APP_ID)')
    }

    // 1. Convert webm → 16kHz mono PCM (s16le)
    const pcmBuffer = await this.convertToPcm(base64Audio)

    // 2. Connect and stream
    return this.streamRecognize(pcmBuffer)
  }

  /**
   * Convert base64 webm audio to 16kHz mono s16le PCM buffer
   */
  private async convertToPcm(base64Audio: string): Promise<Buffer> {
    const tmpDir = os.tmpdir()
    const id = Date.now()
    const webmPath = path.join(tmpDir, `tencent_asr_${id}.webm`)
    const pcmPath = path.join(tmpDir, `tencent_asr_${id}.pcm`)

    try {
      const webmBuf = Buffer.from(base64Audio, 'base64')
      fs.writeFileSync(webmPath, webmBuf)
      console.log(`[tencent-asr] webm input: ${webmBuf.length} bytes`)

      const ffmpeg = require('ffmpeg-static') as string
      const { stdout, stderr } = await execFileUtf8(ffmpeg, [
        '-y',
        '-i', webmPath,
        '-ar', '16000',      // 16kHz
        '-ac', '1',           // mono
        '-f', 's16le',        // PCM signed 16-bit little-endian
        pcmPath,
      ], { timeout: 15_000 })

      if (stderr) {
        // ffmpeg outputs info to stderr — log first 500 chars for diagnostics
        const info = stderr.slice(0, 500).replace(/\n/g, ' | ')
        console.log(`[tencent-asr] ffmpeg: ${info}`)
      }

      const pcmBuf = fs.readFileSync(pcmPath)
      console.log(`[tencent-asr] PCM output: ${pcmBuf.length} bytes (${(pcmBuf.length / 32000).toFixed(2)}s)`)
      return pcmBuf
    } finally {
      try { fs.unlinkSync(webmPath) } catch {}
      try { fs.unlinkSync(pcmPath) } catch {}
    }
  }

  /**
   * Generate HMAC-SHA1 signature for Tencent ASR WebSocket
   */
  private generateSignature(params: Record<string, string>): string {
    const sortedKeys = Object.keys(params).sort()
    const queryString = sortedKeys.map(k => `${k}=${params[k]}`).join('&')
    const signStr = `asr.cloud.tencent.com/asr/v2/${this.appId}?${queryString}`

    const hmac = createHmac('sha1', this.secretKey)
    hmac.update(signStr)
    return hmac.digest('base64')
  }

  /**
   * Build authenticated WebSocket URL
   */
  private buildWsUrl(voiceId: string): string {
    const timestamp = Math.floor(Date.now() / 1000)
    const expired = timestamp + 86400
    const nonce = Math.floor(Math.random() * 1_000_000_000)

    const params: Record<string, string> = {
      secretid: this.secretId,
      timestamp: String(timestamp),
      expired: String(expired),
      nonce: String(nonce),
      engine_model_type: '16k_zh',     // 中文通用 16k
      voice_id: voiceId,
      voice_format: '1',                // PCM
      needvad: '1',                     // 开启 VAD
      filter_dirty: '1',
      filter_modal: '1',
      filter_punc: '1',
    }

    const signature = this.generateSignature(params)
    const encodedSig = encodeURIComponent(signature)

    const sortedKeys = Object.keys(params).sort()
    const queryString = sortedKeys.map(k => `${k}=${params[k]}`).join('&')

    return `wss://asr.cloud.tencent.com/asr/v2/${this.appId}?${queryString}&signature=${encodedSig}`
  }

  /**
   * Stream PCM audio to Tencent ASR and collect results
   */
  private streamRecognize(pcmBuffer: Buffer): Promise<string> {
    return new Promise((resolve, reject) => {
      let settled = false
      const voiceId = randomUUID()
      const url = this.buildWsUrl(voiceId)

      console.log(`[tencent-asr] Connecting... voice_id=${voiceId}, PCM size=${pcmBuffer.length}`)

      const ws = new WebSocket(url)

      const timeout = setTimeout(() => {
        if (settled) return
        settled = true
        ws.close()
        reject(new Error('腾讯云 ASR 连接超时'))
      }, 30_000)

      let finalText = ''
      let intermediateText = ''
      let streaming = false
      // Accumulate stable slices (slice_type=2) by their sentence index
      const stableSlices = new Map<number, string>()
      let maxSliceIndex = -1

      ws.addEventListener('open', () => {
        console.log('[tencent-asr] WebSocket connected, waiting for handshake...')
      })

      const startStreaming = () => {
        if (streaming) return
        streaming = true
        console.log('[tencent-asr] Handshake confirmed, streaming audio...')

        // Stream audio in 3200-byte chunks (100ms of 16kHz 16-bit mono)
        const CHUNK_SIZE = 3200
        let offset = 0

        const sendNext = () => {
          if (settled) return
          if (offset >= pcmBuffer.length) {
            ws.send(JSON.stringify({ type: 'end' }))
            console.log('[tencent-asr] Audio stream complete, waiting for final result...')
            return
          }

          const end = Math.min(offset + CHUNK_SIZE, pcmBuffer.length)
          const chunk = pcmBuffer.subarray(offset, end)
          ws.send(chunk)
          offset = end

          // Pace sending at ~40ms intervals to avoid overwhelming
          setTimeout(sendNext, 40)
        }

        sendNext()
      }

      ws.addEventListener('message', (event: MessageEvent) => {
        if (settled) return
        // Raw message logging for diagnostics
        const raw = typeof event.data === 'string' ? event.data.slice(0, 300) : `[binary ${String(event.data).slice(0, 100)}]`
        console.log(`[tencent-asr] <- msg: ${raw}`)
        try {
          const data: ASRResult = JSON.parse(event.data as string)

          if (data.code !== 0) {
            console.error(`[tencent-asr] Error: code=${data.code}, message="${data.message}"`)
            settled = true
            clearTimeout(timeout)
            ws.close()
            reject(new Error(`腾讯云 ASR 错误: ${data.message}`))
            return
          }

          // First message is handshake confirmation — start streaming
          if (!streaming) {
            startStreaming()
          }

          // Collect results — result may be a string or an object { slice_type, voice_text_str }
          if (data.result) {
            const resultData = data.result as ASRResultData
            const text = typeof data.result === 'string'
              ? data.result
              : resultData.voice_text_str || ''

            const sliceType = resultData.slice_type ?? -1
            const sliceIndex = resultData.index ?? 0

            if (sliceType === 2) {
              // slice_type=2 = stable sentence result — accumulate by index
              stableSlices.set(sliceIndex, text)
              maxSliceIndex = Math.max(maxSliceIndex, sliceIndex)
              console.log(`[tencent-asr] Slice ${sliceIndex} stable: "${text}"`)
            } else if (text) {
              // slice_type=0/1 = intermediate (in-progress) — just track latest
              intermediateText = text
              console.log(`[tencent-asr] Intermediate: "${text.slice(0, 60)}"`)
            }
          }

          // final=1 means recognition complete
          if (data.final === 1) {
            // Assemble all stable slices in index order
            if (stableSlices.size > 0) {
              const parts: string[] = []
              for (let i = 0; i <= maxSliceIndex; i++) {
                if (stableSlices.has(i)) {
                  parts.push(stableSlices.get(i)!)
                }
              }
              finalText = parts.join('')
            }
            console.log(`[tencent-asr] Final: "${finalText || intermediateText}"`)
            settled = true
            clearTimeout(timeout)
            setTimeout(() => {
              ws.close()
              resolve(finalText || intermediateText || '')
            }, 200)
          }
        } catch (e) {
          console.warn('[tencent-asr] Failed to parse message:', e)
        }
      })

      ws.addEventListener('error', () => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        reject(new Error('腾讯云 ASR WebSocket 连接失败'))
      })

      ws.addEventListener('close', (event: CloseEvent) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        console.log(`[tencent-asr] WebSocket closed: code=${event.code}, reason="${event.reason || 'none'}"`)
        if (finalText || intermediateText) {
          resolve(finalText || intermediateText)
        } else {
          reject(new Error('腾讯云 ASR 连接关闭，未收到识别结果'))
        }
      })
    })
  }
}
