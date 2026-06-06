import type { ExecutionMode } from '../../shared/types'

/**
 * Routing strategy:
 * - DIRECT: clear text-only tasks (translate, chat, memory, simple questions)
 * - AGENT: everything else — file ops, coding, desktop, data, and unknown commands
 *
 * Default is AGENT (the powerful path). Only go DIRECT for obvious text-only tasks.
 */

const DIRECT_ONLY = [
  // Translation
  /翻译/, /translate/i,
  // Greetings / chat
  /你好/, /hello/i, /^hi\b/i,
  /谢谢/, /thank/i,
  /你是谁/, /who are you/i,
  // Memory
  /记住/, /忘记/, /提醒/, /remember/i, /forget/i, /remind/i,
  // Meta questions about OnHands itself
  /你能做什么/, /what can you do/i,
]

export class Router {
  decide(command: string): ExecutionMode {
    for (const p of DIRECT_ONLY) {
      if (p.test(command)) return 'direct'
    }
    // Default: agent — let Claude Code / Codex handle everything else
    return 'agent'
  }
}
