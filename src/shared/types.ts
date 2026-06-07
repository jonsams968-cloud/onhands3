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
  screenshotPath?: string        // temp PNG file path for agent to Read on demand
  activeWindow: {
    title: string
    processName: string
    pid: number
  } | null
  clipboard: string | null
  workingDirectory: string
  selectedFiles?: string[]       // Files selected in Explorer (full paths)
  selectedText?: string          // Auto-captured selected text (via Ctrl+C simulation)
}

// ─── AI / Execution ───

export type ExecutionMode = 'direct' | 'agent' | 'image' | 'video'

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

// ─── UI State Machine ───
// hidden → recording → transcribed → routing → processing → result → hidden
//                                                  ↓          ↑
//                                                confirm ──────┘
//                                                  ↓
//                                                error → hidden

export type UIState =
  | 'hidden'       // Window invisible
  | 'recording'    // Recording voice input
  | 'transcribed'  // Showing recognized text (brief)
  | 'routing'      // Showing route decision (brief)
  | 'processing'   // Agent is executing, streaming output
  | 'confirm'      // Permission request, awaiting user action
  | 'result'       // Show successful result
  | 'error'        // Show error message
  | 'input'        // Text input mode
  | 'preview'      // Media preview (image/video with save/regenerate/close)

// ─── Permission System ───

export interface PermissionRequest {
  id: string
  tool: string           // e.g. "Bash", "Write", "Edit"
  description: string    // Human-readable description
  detail?: string        // e.g. the command to run
}

export type PermissionPolicy = 'ask' | 'allow' | 'deny'

export interface PermissionConfig {
  // Tool-level policies: tool name → policy
  [tool: string]: PermissionPolicy
}

// ─── IPC ───

export interface RendererAPI {
  onStateChanged: (cb: (state: UIState, data?: string) => void) => () => void
  onStreamChunk: (cb: (chunk: string) => void) => () => void
  onPermissionRequest: (cb: (req: PermissionRequest) => void) => () => void
  sendRecording: (base64Audio: string) => Promise<void>
  sendRecordingError: (error: string) => Promise<void>
  textCommand: (text: string) => Promise<void>
  abortAction: () => Promise<void>
  setInteractive: (interactive: boolean) => Promise<void>
  hideWindow: () => Promise<void>
  answerPermission: (id: string, approved: boolean) => Promise<void>
  resizeWindow: (height: number) => Promise<void>
  openInFolder: (filePath: string) => Promise<void>
  regenerateMedia: () => Promise<void>
  saveMedia: (sourcePath: string, targetDir: string) => Promise<string | null>
}
