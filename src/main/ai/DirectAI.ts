import type { DesktopContext, ExecutionResult } from '../../shared/types'
import { loadConfig } from '../config'

const SYSTEM_PROMPT = `You are OnHands, a desktop AI assistant.
IMPORTANT: Always respond in Simplified Chinese (简体中文).

CORE RULE — Put the ACTUAL result in your answer:
- Translation → the translated text, not a description
- Calculation → the answer, not the formula
- Question → the direct answer
NEVER describe what the user asked. ALWAYS provide the actual result.

If you receive screen context (window info, clipboard), use it to give better answers.
For text tasks (translate, calculate, explain, chat), respond directly.`

export class DirectAI {
  /** Read config fresh on each call — ensures settings changes take effect immediately */
  private cfg() {
    const c = loadConfig()
    return { apiKey: c.aiApiKey, baseUrl: c.aiBaseUrl.replace(/\/$/, ''), model: c.aiModel, maxTokens: c.aiMaxTokens }
  }

  async execute(command: string, context: DesktopContext, resolution: string, abortSignal?: AbortSignal): Promise<ExecutionResult> {
    const startTime = Date.now()
    const { apiKey, baseUrl, model, maxTokens } = this.cfg()

    const content: unknown[] = []
    if (context.screenshot) {
      content.push({ type: 'image_url', image_url: { url: `data:image/png;base64,${context.screenshot}` } })
    }

    const contextStr = this.formatContext(context)
    content.push({
      type: 'text',
      text: `Command: "${command}"\nScreen: ${resolution}\n${contextStr}`,
    })

    const body = {
      model,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content },
      ],
    }

    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: abortSignal,
      })

      if (!response.ok) {
        const err = await response.text()
        return { success: false, output: '', durationMs: Date.now() - startTime, error: `AI API error: ${response.status} ${err}` }
      }

      const result = await response.json() as { choices: Array<{ message: { content: string } }> }
      const text = result.choices?.[0]?.message?.content || 'No response'

      return { success: true, output: text, durationMs: Date.now() - startTime }
    } catch (err: any) {
      if (err.name === 'AbortError') {
        return { success: false, output: '', durationMs: Date.now() - startTime, error: 'Aborted' }
      }
      const code = err.cause?.code
      const msg = code === 'ENOTFOUND' || code === 'ECONNREFUSED'
        ? '网络不可用，请检查网络连接'
        : code === 'ETIMEDOUT'
          ? '请求超时，请稍后重试'
          : `AI API 错误: ${err.message}`
      return { success: false, output: '', durationMs: Date.now() - startTime, error: msg }
    }
  }

  private formatContext(ctx: DesktopContext): string {
    const parts: string[] = []
    if (ctx.activeWindow) parts.push(`Active window: ${ctx.activeWindow.processName} — "${ctx.activeWindow.title}"`)
    if (ctx.clipboard) parts.push(`Clipboard: ${ctx.clipboard.slice(0, 500)}`)
    return parts.length > 0 ? `Context:\n${parts.join('\n')}` : ''
  }

  /**
   * Clean up raw ASR dictation text:
   * - Remove filler words (嗯, 额, 那个, emm, like, etc.)
   * - Apply self-corrections ("15号...不对16号" → "16号")
   * - Add proper punctuation
   * - Keep original meaning and tone
   */
  async cleanDictation(rawText: string, abortSignal?: AbortSignal): Promise<ExecutionResult> {
    const startTime = Date.now()
    const { apiKey, baseUrl, model } = this.cfg()

    const body = {
      model,
      max_tokens: 512,
      temperature: 0.1,
      messages: [
        {
          role: 'system',
          content: `你是语音听写清洗器。将 ASR 原始文本转为干净的书面文字，直接输出结果文字，不要任何解释或前缀。

规则：
1. 去除语气词和口癖：嗯、额、那个、就是、然后、emm、like、you know
2. 处理自我修正："15号...不对16号" → "16号"，"下周...不这周" → "这周"
3. 去除重复词："我我我觉得" → "我觉得"
4. 添加标点符号（逗号、句号、问号）
5. 保持口语自然感，不要过度书面化
6. 只输出清洗后的文字，不要任何额外内容`,
        },
        {
          role: 'user',
          content: rawText,
        },
      ],
    }

    try {
      console.log(`[dictation] Cleaning via ${baseUrl} model=${model}`)
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: abortSignal,
      })

      if (!response.ok) {
        const errText = await response.text().catch(() => '')
        console.warn(`[dictation] API error: ${response.status} ${errText.slice(0, 200)}`)
        return { success: false, output: rawText, durationMs: Date.now() - startTime, error: `Dictation cleanup failed: ${response.status}` }
      }

      const result = await response.json() as { choices: Array<{ message: { content: string } }> }
      const text = result.choices?.[0]?.message?.content?.trim() || rawText
      console.log(`[dictation] API response: "${text.slice(0, 100)}"`)

      return { success: true, output: text, durationMs: Date.now() - startTime }
    } catch (err: any) {
      console.warn(`[dictation] Cleanup failed: ${err.message || err}`)
      // Fallback: return raw text if AI cleanup fails
      return { success: true, output: rawText, durationMs: Date.now() - startTime }
    }
  }
}
