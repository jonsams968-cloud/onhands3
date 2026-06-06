/** Shared types for OnHands3 */

// ─── Input ───

export interface LongPressEvent {
  x: number
  y: number
  timestamp: number
}

export interface LongPressEndEvent {
  x: number
  y: number
  duration: number
}

// ─── Context ───

export interface DesktopContext {
  screenshot?: string            // base64 PNG
  activeWindow: {
    title: string
    processName: string
    pid: number
  } | null
  clipboard: string | null
  workingDirectory: string
}

// ─── AI / Execution ───

export type ExecutionMode = 'direct' | 'agent'

export interface ExecutionRequest {
  command: string                 // User's voice/text command
  context: DesktopContext         // Collected context
  mode: ExecutionMode             // Decided by Router
  resolution: string              // Screen resolution
}

export interface ExecutionResult {
  success: boolean
  output: string                  // The actual result text
  durationMs: number
  error?: string
}

// ─── Agent ───

export interface AgentInfo {
  name: string                    // e.g. "claude-code", "codex"
  displayName: string             // e.g. "Claude Code"
  binaryPath: string              // Resolved path to CLI binary
  available: boolean
}

export interface AgentSession {
  output: string
  error?: string
  exitCode: number | null
  durationMs: number
}

// ─── UI State ───

export type UIState = 'hidden' | 'recording' | 'processing' | 'result' | 'error' | 'confirm'

// ─── IPC ───

export interface RendererAPI {
  onStateChanged: (cb: (state: UIState, data?: string) => void) => () => void
  sendRecording: (base64Audio: string) => Promise<void>
  sendRecordingError: (error: string) => Promise<void>
  textCommand: (text: string) => Promise<void>
  abortAction: () => Promise<void>
  setInteractive: (interactive: boolean) => Promise<void>
}
