/**
 * 腾讯云实时语音识别 WebSocket API 测试
 * 文档: https://cloud.tencent.com/document/product/1093/48982
 *
 * 用法: node test-tencent-asr.mjs
 */

import { createHmac } from 'crypto'
import { randomUUID } from 'crypto'

// ─── 配置 ───
const SECRET_ID = process.env.TENCENT_SECRET_ID || ''
const SECRET_KEY = process.env.TENCENT_SECRET_KEY || ''
const APP_ID = process.env.TENCENT_APP_ID || ''

if (!SECRET_ID || !SECRET_KEY || !APP_ID) {
  console.error('❌ 请设置环境变量:')
  console.error('   TENCENT_SECRET_ID=xxx TENCENT_SECRET_KEY=xxx TENCENT_APP_ID=xxx node test-tencent-asr.mjs')
  process.exit(1)
}

// ─── 签名生成 ───
function generateSignature(params, secretKey) {
  // 1. 按 key 字典序排序，拼接 URL path + query
  const sortedKeys = Object.keys(params).sort()
  const queryString = sortedKeys.map(k => `${k}=${params[k]}`).join('&')
  const signStr = `asr.cloud.tencent.com/asr/v2/${APP_ID}?${queryString}`

  // 2. HMAC-SHA1 + Base64
  const hmac = createHmac('sha1', secretKey)
  hmac.update(signStr)
  const signature = hmac.digest('base64')

  return signature
}

// ─── 构建 WebSocket URL ───
function buildWsUrl() {
  const timestamp = Math.floor(Date.now() / 1000)
  const expired = timestamp + 86400  // 24 小时有效
  const nonce = Math.floor(Math.random() * 1000000000)
  const voiceId = randomUUID()

  const params = {
    secretid: SECRET_ID,
    timestamp: String(timestamp),
    expired: String(expired),
    nonce: String(nonce),
    engine_model_type: '16k_zh',    // 中文通用 16k
    voice_id: voiceId,
    voice_format: '1',              // PCM
    needvad: '1',                   // 开启 VAD
    filter_dirty: '1',
    filter_modal: '1',
    filter_punc: '1',
  }

  const signature = generateSignature(params, SECRET_KEY)
  const encodedSig = encodeURIComponent(signature)

  const sortedKeys = Object.keys(params).sort()
  const queryString = sortedKeys.map(k => `${k}=${params[k]}`).join('&')

  return `wss://asr.cloud.tencent.com/asr/v2/${APP_ID}?${queryString}&signature=${encodedSig}`
}

// ─── 测试连接 ───
async function testConnection() {
  const url = buildWsUrl()
  console.log('Connecting to Tencent ASR WebSocket...')
  console.log(`AppID: ${APP_ID}`)
  console.log(`SecretId: ${SECRET_ID.slice(0, 10)}...`)
  console.log(`Engine: 16k_zh (中文通用)`)
  console.log()

  // Node 22 has built-in WebSocket
  const ws = new WebSocket(url)

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.close()
      reject(new Error('Connection timeout (10s)'))
    }, 10000)

    ws.addEventListener('open', () => {
      console.log('✅ WebSocket connected! Handshake successful.')
      console.log('   Credentials are valid.')
    })

    ws.addEventListener('message', (event) => {
      const data = JSON.parse(event.data)
      console.log('📨 Message:', JSON.stringify(data, null, 2))

      if (data.code === 0) {
        console.log('✅ Recognition ready — waiting for audio data')
      } else {
        console.log(`❌ Error: code=${data.code}, message="${data.message}"`)
      }

      // Close after receiving the handshake response
      clearTimeout(timeout)
      setTimeout(() => {
        ws.send(JSON.stringify({ type: 'end' }))
        resolve(data)
      }, 500)
    })

    ws.addEventListener('error', (event) => {
      clearTimeout(timeout)
      console.error('❌ WebSocket error')
      reject(new Error('WebSocket error'))
    })

    ws.addEventListener('close', (event) => {
      clearTimeout(timeout)
      console.log(`WebSocket closed (code=${event.code}, reason=${event.reason || 'none'})`)
      resolve(null)
    })
  })
}

testConnection()
  .then((data) => {
    if (data && data.code === 0) {
      console.log('\n🎉 腾讯云 ASR 连接成功！签名和凭证有效。')
    } else if (data) {
      console.log('\n⚠️ 连接已建立但返回错误，请检查上方错误信息。')
    }
    process.exit(0)
  })
  .catch((err) => {
    console.error('\n💥 测试失败:', err.message)
    process.exit(1)
  })
