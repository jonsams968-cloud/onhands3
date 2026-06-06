import type { AgentInfo, AgentSession } from '../../shared/types'

/**
 * Base interface for all agent backends.
 * Each agent wraps a specific CLI (Claude Code, Codex, etc.)
 * and handles subprocess lifecycle + output streaming.
 */
export interface Agent {
  readonly info: AgentInfo
  execute(prompt: string, opts?: AgentExecOptions): Promise<AgentSession>
}

export interface AgentExecOptions {
  workingDirectory?: string
  timeoutMs?: number
  onOutput?: (chunk: string) => void
}
