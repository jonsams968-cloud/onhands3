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
  private apiKey: string
  private baseUrl: string
  private model: string
  private maxTokens: number

  constructor() {
    const cfg = loadConfig()
    this.apiKey = cfg.aiApiKey
    this.baseUrl = cfg.aiBaseUrl.replace(/\/$/, '')
    this.model = cfg.aiModel
    this.maxTokens = cfg.aiMaxTokens
  }

  async execute(command: string, context: DesktopContext, resolution: string, abortSignal?: AbortSignal): Promise<ExecutionResult> {
    const startTime = Date.now()

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
      model: this.model,
      max_tokens: this.maxTokens,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content },
      ],
    }

    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
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
      return { success: false, output: '', durationMs: Date.now() - startTime, error: err.message }
    }
  }

  private formatContext(ctx: DesktopContext): string {
    const parts: string[] = []
    if (ctx.activeWindow) parts.push(`Active window: ${ctx.activeWindow.processName} — "${ctx.activeWindow.title}"`)
    if (ctx.clipboard) parts.push(`Clipboard: ${ctx.clipboard.slice(0, 500)}`)
    return parts.length > 0 ? `Context:\n${parts.join('\n')}` : ''
  }
}
