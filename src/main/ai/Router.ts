import type { ExecutionMode } from '../../shared/types'

/**
 * Routing strategy:
 * - DIRECT: fast text-only tasks via lightweight AI (translation, chat, simple Q&A)
 * - AGENT: everything else — file ops, coding, desktop, data, and unknown commands
 *
 * NOTE: Direct mode requires a reliable AI API. If DirectAI is unavailable or
 * returning garbage, set FORCE_AGENT=true in .env to route everything through
 * the agent (Claude Code), which is slower but more reliable.
 */

const DIRECT_PATTERNS = [
  // Translation
  /翻译/, /translate/i,
  // Greetings / chat
  /你好/, /hello/i, /^hi\b/i,
  /谢谢/, /thank/i,
  /你是谁/, /who are you/i,
  // Simple questions
  /什么是/, /解释/, /explain/i,
  /记忆/, /记住/, /忘记/, /提醒/,
  // Meta
  /你能做什么/, /what can you do/i,
]

export class Router {
  private forceAgent: boolean

  constructor() {
    this.forceAgent = (process.env.FORCE_AGENT || '').toLowerCase() === 'true'
  }

  decide(command: string): ExecutionMode {
    // If DirectAI is unreliable, force everything through the agent
    if (this.forceAgent) return 'agent'

    for (const p of DIRECT_PATTERNS) {
      if (p.test(command)) return 'direct'
    }
    return 'agent'
  }
}
