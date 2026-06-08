import type { HistoryEntry } from '../../shared/types'

/**
 * In-memory ring buffer for recent command history.
 * Stores the last N interactions and formats them for agent prompts.
 *
 * Agent decides relevance — we don't do any detection logic.
 * If the user says "再来一张", the agent sees the history and
 * understands it's a follow-up. If they say something unrelated,
 * the agent ignores the history.
 */
export class RecentHistory {
  private entries: HistoryEntry[] = []
  private readonly maxEntries: number

  constructor(maxEntries = 5) {
    this.maxEntries = maxEntries
  }

  add(entry: HistoryEntry): void {
    this.entries.push(entry)
    if (this.entries.length > this.maxEntries) {
      this.entries.shift()
    }
  }

  getAll(): readonly HistoryEntry[] {
    return this.entries
  }

  /**
   * Format as a markdown section for agent prompt injection.
   * Returns empty string if no history.
   */
  formatForPrompt(): string {
    if (this.entries.length === 0) return ''

    const lines = this.entries.map((e) => {
      const time = new Date(e.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
      const summary = e.resultSummary.slice(0, 120).replace(/\n/g, ' ')
      return `${time} | "${e.command}" → ${summary} (${e.sourceWindow}, ${e.mode})`
    })

    return `## Recent Actions (for follow-up context — ignore if unrelated to current command)\n${lines.map((l) => `- ${l}`).join('\n')}`
  }

  clear(): void {
    this.entries = []
  }
}
