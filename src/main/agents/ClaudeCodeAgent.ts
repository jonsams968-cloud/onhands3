import { spawn } from 'child_process'
import type { AgentInfo, AgentSession } from '../../shared/types'
import type { Agent, AgentExecOptions, PermissionRequest } from './types'

// Tools that are safe to auto-approve (read-only)
const SAFE_TOOLS = ['Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch']

// Tools that need user approval (destructive/side-effecting)
const DANGEROUS_TOOLS = ['Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit']

/**
 * Claude Code agent backend.
 *
 * Uses `claude -p` for non-interactive execution with stream-json output.
 * Safe tools are pre-approved via --allowedTools.
 * Dangerous tools trigger permission requests through the UI.
 */
export class ClaudeCodeAgent implements Agent {
  readonly info: AgentInfo

  constructor(info: AgentInfo) {
    this.info = info
  }

  async execute(prompt: string, opts?: AgentExecOptions): Promise<AgentSession> {
    const startTime = Date.now()
    const args = this.buildArgs(opts)
    const cwd = opts?.workingDirectory || process.cwd()

    console.log(`[agent] Spawning: ${this.info.binaryPath} ${args.join(' ')}`)
    console.log(`[agent] CWD: ${cwd}`)
    console.log(`[agent] Prompt length: ${prompt.length} chars`)

    return new Promise((resolve) => {
      let proc: any
      try {
        proc = spawn(this.info.binaryPath, args, {
          cwd,
          env: { ...process.env },
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
          shell: true,     // Required for .cmd files on Windows
        })

        // Notify caller so it can track the process for abort
        opts?.onProcessSpawn?.(proc as import('child_process').ChildProcess)
      } catch (err: any) {
        console.error(`[agent] Spawn failed: ${err.message}`)
        resolve({ output: '', error: `Spawn failed: ${err.message}`, exitCode: null, durationMs: Date.now() - startTime })
        return
      }

      let stdout = ''
      let stderr = ''
      let lastText = ''
      let eventCount = 0
      let permissionSeq = 0

      proc.stdout.on('data', (chunk: Buffer) => {
        const str = chunk.toString()
        stdout += str
        opts?.onOutput?.(str)

        for (const line of str.split('\n')) {
          if (!line.trim()) continue
          eventCount++
          try {
            const event = JSON.parse(line)
            const type = event.type || '?'

            if (type === 'assistant') {
              const blocks = event.message?.content || []
              for (const b of blocks) {
                if (b.type === 'text' && b.text) {
                  lastText = b.text
                  console.log(`[agent] Text: ${b.text.slice(0, 100)}...`)
                }
                if (b.type === 'tool_use') {
                  console.log(`[agent] Tool: ${b.name}(${JSON.stringify(b.input || {}).slice(0, 80)})`)

                  // Request permission for dangerous tools
                  if (DANGEROUS_TOOLS.includes(b.name) && opts?.onPermissionRequest) {
                    const reqId = `perm-${++permissionSeq}-${Date.now()}`
                    const req: PermissionRequest = {
                      id: reqId,
                      tool: b.name,
                      description: this.describeToolUse(b.name, b.input),
                      detail: JSON.stringify(b.input, null, 2).slice(0, 500),
                    }
                    // Fire-and-forget: send permission request to UI
                    // If denied, the agent process will be killed
                    opts.onPermissionRequest(req).then(approved => {
                      if (!approved) {
                        console.log(`[agent] Permission denied: ${b.name}, killing process`)
                        proc.kill('SIGTERM')
                      }
                    })
                  }
                }
              }
            } else if (type === 'result') {
              console.log(`[agent] Result: ${String(event.result || '').slice(0, 100)}`)
            } else if (type === 'system') {
              console.log(`[agent] System: session=${event.session_id || '?'}`)
            } else if (eventCount <= 3) {
              console.log(`[agent] Event #${eventCount}: type=${type}`)
            }
          } catch { /* not JSON */ }
        }
      })

      proc.stderr.on('data', (chunk: Buffer) => {
        const str = chunk.toString()
        stderr += str
        for (const line of str.split('\n')) {
          if (line.trim()) console.log(`[agent:stderr] ${line.slice(0, 200)}`)
        }
      })

      // Write prompt via stdin (plain text for -p mode)
      proc.stdin.write(prompt)
      proc.stdin.end()

      const timeout = setTimeout(() => {
        console.error(`[agent] Timeout after ${opts?.timeoutMs || 120000}ms`)
        proc.kill('SIGTERM')
        resolve({
          output: lastText || stdout || 'Agent timed out',
          error: 'Timeout',
          exitCode: null,
          durationMs: Date.now() - startTime,
        })
      }, opts?.timeoutMs || 120_000)

      proc.on('close', (code: number) => {
        clearTimeout(timeout)
        const result = lastText || this.extractPlainText(stdout)
        const durationMs = Date.now() - startTime
        console.log(`[agent] Exited: code=${code}, duration=${durationMs}ms, events=${eventCount}`)
        if (stderr) console.log(`[agent] stderr tail: ${stderr.slice(-300)}`)

        resolve({
          output: result || (stderr ? `Error: ${stderr.slice(0, 500)}` : 'No output'),
          error: code !== 0 ? stderr.slice(0, 500) : undefined,
          exitCode: code,
          durationMs,
        })
      })

      proc.on('error', (err: Error) => {
        clearTimeout(timeout)
        console.error(`[agent] Process error: ${err.message}`)
        resolve({
          output: '',
          error: err.message,
          exitCode: null,
          durationMs: Date.now() - startTime,
        })
      })
    })
  }

  private buildArgs(opts?: AgentExecOptions): string[] {
    const args = [
      '-p',                                   // Non-interactive print mode
      '--output-format', 'stream-json',       // Structured JSON on stdout
      '--verbose',                            // Show tool calls
    ]

    // Pre-approve safe tools so Claude Code doesn't block on them
    // Dangerous tools (Bash, Write, Edit) will be handled via permission UI
    if (opts?.onPermissionRequest) {
      args.push('--allowedTools', SAFE_TOOLS.join(','))
    } else {
      // No permission handler — allow all tools for backwards compatibility
      args.push('--dangerously-skip-permissions')
    }

    return args
  }

  private describeToolUse(name: string, input: any): string {
    switch (name) {
      case 'Bash':
        return `执行命令: ${(input?.command || '').slice(0, 100)}`
      case 'Write':
        return `写入文件: ${input?.file_path || '?'}`
      case 'Edit':
      case 'MultiEdit':
        return `编辑文件: ${input?.file_path || '?'}`
      default:
        return `使用工具: ${name}`
    }
  }

  private extractPlainText(stdout: string): string {
    let lastText = ''
    for (const line of stdout.split('\n')) {
      if (!line.trim()) continue
      try {
        const event = JSON.parse(line)
        if (event.type === 'result' && event.result) {
          lastText = event.result
        }
      } catch {}
    }
    return lastText
  }
}
