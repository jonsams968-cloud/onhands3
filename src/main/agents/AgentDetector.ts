import { execFileSync } from 'child_process'
import type { AgentInfo } from '../../shared/types'

/**
 * Detects which agent CLIs are available on this system.
 * Resolves full binary path so spawn() can find it.
 */
export class AgentDetector {
  private cache: AgentInfo[] | null = null

  async detectAll(): Promise<AgentInfo[]> {
    if (this.cache) return this.cache

    const agents: AgentInfo[] = [
      { name: 'claude-code', displayName: 'Claude Code', binaryPath: 'claude', available: false },
      { name: 'codex',      displayName: 'Codex',        binaryPath: 'codex',  available: false },
      { name: 'opencode',   displayName: 'OpenCode',     binaryPath: 'opencode', available: false },
    ]

    for (const agent of agents) {
      const resolved = this.resolvePath(agent.binaryPath)
      if (resolved) {
        agent.available = true
        agent.binaryPath = resolved
        console.log(`[agent] Detected: ${agent.displayName} at ${resolved}`)
      }
    }

    this.cache = agents
    return agents
  }

  async getAvailable(): Promise<AgentInfo[]> {
    const all = await this.detectAll()
    return all.filter(a => a.available)
  }

  async getPreferred(): Promise<AgentInfo | null> {
    const available = await this.getAvailable()
    const order = ['claude-code', 'codex', 'opencode']
    for (const name of order) {
      const found = available.find(a => a.name === name)
      if (found) return found
    }
    return null
  }

  private resolvePath(name: string): string | null {
    try {
      const envKey = `ONHANDS_${name.replace(/-/g, '_').toUpperCase()}_PATH`
      const envPath = process.env[envKey]
      if (envPath) return envPath

      // `where` on Windows returns full path(s)
      // Use 'buffer' encoding to avoid GBK→UTF-8 mojibake on Chinese Windows,
      // then manually decode as UTF-8 (where.exe outputs ASCII paths when found)
      const buf = execFileSync('where', [name], {
        timeout: 3000,
        encoding: 'buffer',
        stdio: ['pipe', 'pipe', 'pipe'],   // Fully pipe to prevent GBK leaking to console
        windowsHide: true,
      }) as Buffer

      const result = buf.toString('utf-8').trim()
      if (!result) return null

      // Take first result, prefer .cmd on Windows
      const lines = result.split('\n').map(l => l.trim()).filter(Boolean)
      const cmdPath = lines.find(l => l.endsWith('.cmd'))
      return cmdPath || lines[0] || null
    } catch {
      return null
    }
  }
}
