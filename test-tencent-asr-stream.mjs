/**
 * 腾讯云实时语音识别 — 独立流式测试
 *
 * 流程: 麦克风录音 → PCM → WebSocket 流式发送 → 实时显示识别结果
 *
 * 用法:
 *   node test-tencent-asr-stream.mjs              # 默认录 5 秒
 *   node test-tencent-asr-stream.mjs 8            # 录 8 秒
 *   node test-tencent-asr-stream.mjs file.wav     # 用已有音频文件测试
 */

import { createHmac, randomUUID } from 'crypto'
import { execFileSync } from 'child_process'
import { readFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// ─── 配置 ───
const SECRET_ID  = process.env.TENCENT_SECRET_ID  || ''
const SECRET_KEY = process.env.TENCENT_SECRET_KEY || ''
const APP_ID     = process.env.TENCENT_APP_ID     || ''

if (!SECRET_ID || !SECRET_KEY || !APP_ID) {
  console.error('❌ 请设置环境变量:')
  console.error('   TENCENT_SECRET_ID=xxx TENCENT_SECRET_KEY=xxx TENCENT_APP_ID=xxx node test-tencent-asr-stream.mjs')
  process.exit(1)
}

const arg = process.argv[2] || '5'

// ─── Step 1: 获取 PCM 音频 ───
function preparePCM(inputFile, duration) {
  const id = Date.now()
  const pcmPath = join(tmpdir(), `test_tencent_${id}.pcm`)
  let cleanupFiles = [pcmPath]

  try {
    if (!inputFile) {
      // 录音模式
      console.log(`\n🎤 录音 ${duration} 秒，请说话...`)
      console.log('   ' + '─'.repeat(40))

      const deviceName = '麦克风 (Xmic Z4)'
      execFileSync('ffmpeg', [
        '-y', '-f', 'dshow', '-i', `audio=${deviceName}`,
        '-t', String(duration),
        '-ar', '16000', '-ac', '1', '-f', 's16le',
        pcmPath,
      ], { stdio: 'pipe', timeout: (duration + 5) * 1000 })
    } else {
      // 文件模式
      console.log(`\n📂 使用文件: ${inputFile}`)
      execFileSync('ffmpeg', [
        '-y', '-i', inputFile,
        '-ar', '16000', '-ac', '1', '-f', 's16le', pcmPath,
      ], { stdio: 'pipe' })
    }

    const pcmBuf = readFileSync(pcmPath)
    const pcmDuration = (pcmBuf.length / 32000).toFixed(2)
    console.log(`\n✅ PCM 就绪: ${pcmBuf.length} bytes (${pcmDuration}s)`)
    return pcmBuf
  } finally {
    for (const f of cleanupFiles) {
      try { unlinkSync(f) } catch {}
    }
  }
}

// ─── Step 2: 签名 + URL ───
function buildWsUrl(voiceId) {
  const timestamp = Math.floor(Date.now() / 1000)
  const expired = timestamp + 86400
  const nonce = Math.floor(Math.random() * 1_000_000_000)

  const params = {
    secretid: SECRET_ID,
    timestamp: String(timestamp),
    expired: String(expired),
    nonce: String(nonce),
    engine_model_type: '16k_zh',
    voice_id: voiceId,
    voice_format: '1',
    needvad: '1',
    filter_dirty: '1',
    filter_modal: '1',
    filter_punc: '1',
  }

  const sortedKeys = Object.keys(params).sort()
  const queryString = sortedKeys.map(k => `${k}=${params[k]}`).join('&')
  const signStr = `asr.cloud.tencent.com/asr/v2/${APP_ID}?${queryString}`
  const signature = createHmac('sha1', SECRET_KEY).update(signStr).digest('base64')

  return `wss://asr.cloud.tencent.com/asr/v2/${APP_ID}?${queryString}&signature=${encodeURIComponent(signature)}`
}

// ─── Step 3: 流式识别 ───
function streamRecognize(pcmBuffer) {
  return new Promise((resolve, reject) => {
    const voiceId = randomUUID()
    const url = buildWsUrl(voiceId)
    let settled = false
    let streaming = false
    let finalText = ''
    let intermediateText = ''

    console.log('\n🔌 连接腾讯云 ASR...')
    const ws = new WebSocket(url)

    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      ws.close()
      reject(new Error('超时 (30s)'))
    }, 30_000)

    ws.addEventListener('open', () => {
      console.log('   ✅ 已连接，等待握手...')
    })

    const startStreaming = () => {
      if (streaming) return
      streaming = true
      console.log('\n📤 开始流式发送音频...')
      console.log('   ' + '─'.repeat(40))

      const CHUNK_SIZE = 3200
      let offset = 0

      const sendNext = () => {
        if (settled) return
        if (offset >= pcmBuffer.length) {
          ws.send(JSON.stringify({ type: 'end' }))
          console.log('   ✅ 发送完毕，等待识别结果...\n')
          return
        }
        const end = Math.min(offset + CHUNK_SIZE, pcmBuffer.length)
        ws.send(pcmBuffer.subarray(offset, end))
        offset = end
        setTimeout(sendNext, 40)
      }
      sendNext()
    }

    ws.addEventListener('message', (event) => {
      if (settled) return
      try {
        const data = JSON.parse(event.data)

        if (data.code !== 0) {
          console.error(`   ❌ 错误: ${data.message}`)
          settled = true
          clearTimeout(timeout)
          ws.close()
          reject(new Error(data.message))
          return
        }

        if (!streaming) startStreaming()

        // 首条有 result 的消息打印 raw 结构
        if (data.result && !finalText && !intermediateText) {
          console.log(`   📎 raw result type: ${typeof data.result}`, JSON.stringify(data.result).slice(0, 200))
        }

        if (data.result) {
          // result 可能是字符串也可能是对象
          const text = typeof data.result === 'string'
            ? data.result
            : data.result.voice_text_str || JSON.stringify(data.result)
          if (data.final === 1) {
            finalText = text
          } else {
            intermediateText = text
            process.stdout.write(`   🔤 ${text}\r`)
          }
        }

        if (data.final === 1) {
          settled = true
          clearTimeout(timeout)
          // 清除中间结果的覆盖行
          if (intermediateText) process.stdout.write('   ' + ' '.repeat(intermediateText.length + 10) + '\r')
          setTimeout(() => { ws.close(); resolve(finalText || intermediateText || '') }, 200)
        }
      } catch (e) {
        console.warn('   ⚠️ 解析失败:', e.message)
      }
    })

    ws.addEventListener('error', () => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      reject(new Error('WebSocket 错误'))
    })

    ws.addEventListener('close', (event) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      console.log(`\n   🔌 连接关闭 (code=${event.code})`)
      if (finalText || intermediateText) {
        resolve(finalText || intermediateText)
      } else {
        reject(new Error('未收到识别结果'))
      }
    })
  })
}

// ─── Main ───
const isFile = arg && !/^\d+$/.test(arg)
const duration = isFile ? 5 : parseInt(arg) || 5
const pcmBuffer = preparePCM(isFile ? arg : null, duration)

streamRecognize(pcmBuffer)
  .then((text) => {
    console.log(`\n${'═'.repeat(40)}`)
    console.log(`  识别结果: "${text}"`)
    console.log(`${'═'.repeat(40)}\n`)
    process.exit(0)
  })
  .catch((err) => {
    console.error(`\n💥 失败: ${err.message}\n`)
    process.exit(1)
  })
