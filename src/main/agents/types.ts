import type { ChildProcess } from 'child_process'
import type { AgentInfo, AgentSession } from '../../shared/types'

/**
 * Base interface for all agent backends.
 * Each agent wraps a specific CLI (Claude Code, Codex, etc.)
 * and handles subprocess lifecycle + output streaming.
 */
export interface Agent {
  readonly info: AgentInfo
  execute(prompt: string, opts?: AgentExecOptions): Promise<AgentSession>
  resume(sessionId: string, prompt: string, opts?: AgentExecOptions): Promise<AgentSession>
}

export interface PermissionRequest {
  id: string
  tool: string
  description: string
  detail?: string
}

export interface AgentExecOptions {
  workingDirectory?: string
  timeoutMs?: number
  onOutput?: (chunk: string) => void
  /** Called when the agent needs permission to use a tool. Return true to approve. */
  onPermissionRequest?: (req: PermissionRequest) => Promise<boolean>
  /** Called when the agent subprocess is spawned, so callers can track it for abort. */
  onProcessSpawn?: (proc: ChildProcess) => void
}
