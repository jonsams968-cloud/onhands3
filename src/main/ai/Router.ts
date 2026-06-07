import type { ExecutionMode } from '../../shared/types'

/**
 * Routing strategy:
 * - IMAGE: generate/edit images via Agnes Image 2.1 Flash (handled by agent)
 * - VIDEO: generate videos via Agnes Video V2.0 (handled by agent)
 * - DIRECT: fast text-only tasks via lightweight AI (translation, chat, simple Q&A)
 * - AGENT: everything else — file ops, coding, desktop, data, and unknown commands
 *
 * Image/video commands are routed to the agent with specialized prompts
 * that include Agnes API documentation and credentials.
 */

const IMAGE_PATTERNS = [
  /生成.*图片/, /生成.*图(?!片)/, /画一张/, /画一个/, /做张图/, /做一张/,
  /创建图片/, /生成一张.*图/, /画出来/, /生成.*照片/,
]

const VIDEO_PATTERNS = [
  /生成.*视频/, /做.*段视频/, /制作视频/, /生成一段.*视频/,
  /创建视频/, /制作.*动画/,
]

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
    // Image generation (check before forceAgent)
    for (const p of IMAGE_PATTERNS) {
      if (p.test(command)) return 'image'
    }

    // Video generation (check before forceAgent)
    for (const p of VIDEO_PATTERNS) {
      if (p.test(command)) return 'video'
    }

    // If DirectAI is unreliable, force everything through the agent
    if (this.forceAgent) return 'agent'

    for (const p of DIRECT_PATTERNS) {
      if (p.test(command)) return 'direct'
    }
    return 'agent'
  }

  /** Parse video duration from command text (e.g. "8秒" → 8) */
  parseVideoDuration(command: string): number {
    const match = command.match(/(\d+)\s*秒/)
    if (match) {
      const secs = parseInt(match[1])
      if (secs >= 3 && secs <= 18) return secs
    }
    return 5  // default 5 seconds
  }
}
