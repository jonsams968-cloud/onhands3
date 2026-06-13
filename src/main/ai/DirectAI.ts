import type { DesktopContext, ExecutionResult } from '../../shared/types'
import { loadConfig } from '../config'
import type { MemoryJudgment } from '../oh3/Oh3Store'

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
4. 补充缺失的标点符号（逗号、句号、问号），但保留原文已有标点，绝不要产生连续重复标点（如 ，，或 。。）
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
      let text = result.choices?.[0]?.message?.content?.trim() || rawText
      // Safety net: remove consecutive duplicate punctuation (AI or ASR artifact)
      text = text.replace(/([，。！？、；：])\1+/g, '$1')
      console.log(`[dictation] API response: "${text.slice(0, 100)}"`)

      return { success: true, output: text, durationMs: Date.now() - startTime }
    } catch (err: any) {
      console.warn(`[dictation] Cleanup failed: ${err.message || err}`)
      // Fallback: return raw text if AI cleanup fails (still clean duplicate punctuation)
      const cleaned = rawText.replace(/([，。！？、；：])\1+/g, '$1')
      return { success: true, output: cleaned, durationMs: Date.now() - startTime }
    }
  }

  /**
   * 判断用户输入是否包含值得长期记住的信息。
   *
   * 设计目标：
   * - 保守优先：宁可漏掉，也不要乱写
   * - 仅捕捉明确的规则 / 偏好 / 事实
   * - flash 模型 ~500ms 内完成
   *
   * @returns 判断结果（type + content），或 null（不写入）
   */
  async judgeMemory(userInput: string, abortSignal?: AbortSignal): Promise<MemoryJudgment | null> {
    const trimmedInput = userInput.trim().slice(0, 500)
    if (!trimmedInput) return null

    const startTime = Date.now()
    const { apiKey, baseUrl, model } = this.cfg()

    const body = {
      model,
      max_tokens: 200,
      temperature: 0,
      messages: [
        {
          role: 'system',
          content: `你是 OnHands 的记忆判断器。

任务：判断用户输入是否包含值得长期记住的信息（规则、偏好、事实）。

判定标准：
- rule（规则）：明确的禁止或要求。关键词：不要、禁止、必须、永远、永远不、don't、never、always
- preference（偏好）：个人喜好或习惯。关键词：我喜欢、我习惯、请用、我希望、prefer
- fact（事实）：项目静态信息。如"项目用 X"、"团队在 Y"、"技术栈是 Z"

不要写入的情况：
- 一般提问、翻译、计算、查询
- 修复 bug、执行任务、操作文件
- 闲聊、临时需求、感叹

输出严格的 JSON（只输出 JSON，不要任何其他文字）：
{"shouldWrite": true, "type": "rule", "content": "简洁陈述（不超过 80 字）"}
或
{"shouldWrite": false}

示例：
输入"不要碰 node_modules" → {"shouldWrite": true, "type": "rule", "content": "禁止修改 node_modules/"}
输入"translate this to English" → {"shouldWrite": false}
输入"我们项目用 TypeScript" → {"shouldWrite": true, "type": "fact", "content": "项目使用 TypeScript"}
输入"修复这个 bug" → {"shouldWrite": false}
输入"commit 信息请用中文" → {"shouldWrite": true, "type": "preference", "content": "commit message 用中文"}
输入"这个文件夹是用户数据，别动" → {"shouldWrite": true, "type": "rule", "content": "禁止修改此文件夹（用户数据）"}
输入"项目用 Electron 35 + React 18" → {"shouldWrite": true, "type": "fact", "content": "技术栈：Electron 35 + React 18"}`,
        },
        {
          role: 'user',
          content: trimmedInput,
        },
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
        console.warn(`[memory-judge] API ${response.status}`)
        return null
      }

      const result = await response.json() as { choices: Array<{ message: { content: string } }> }
      const text = result.choices?.[0]?.message?.content?.trim() || ''
      const durationMs = Date.now() - startTime

      // 解析 JSON（容忍前后多余文字）
      const jsonMatch = text.match(/\{[\s\S]*?\}/)
      if (!jsonMatch) {
        console.warn(`[memory-judge] No JSON in response: "${text.slice(0, 100)}" (${durationMs}ms)`)
        return null
      }

      let parsed: any
      try {
        parsed = JSON.parse(jsonMatch[0])
      } catch {
        console.warn(`[memory-judge] Invalid JSON: "${jsonMatch[0].slice(0, 100)}"`)
        return null
      }

      if (!parsed.shouldWrite) {
        console.log(`[memory-judge] Skip (${durationMs}ms): "${trimmedInput.slice(0, 50)}"`)
        return null
      }

      const type = parsed.type
      const content = typeof parsed.content === 'string' ? parsed.content.trim().slice(0, 200) : ''
      if (!type || !content) return null
      if (!['rule', 'preference', 'fact'].includes(type)) return null

      console.log(`[memory-judge] Write (${durationMs}ms): ${type} = "${content.slice(0, 50)}"`)
      return { type, content }
    } catch (err: any) {
      if (err.name === 'AbortError') return null
      console.warn(`[memory-judge] Failed: ${err.message || err}`)
      return null
    }
  }
}
