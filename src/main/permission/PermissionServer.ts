import * as http from 'http'
import { BrowserWindow } from 'electron'

export interface PermissionRequestBody {
  tool: string
  description: string
  detail?: string
}

interface PendingRequest {
  resolve: (result: { approved: boolean; reason?: string }) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * Lightweight HTTP permission server for OnHands3.
 *
 * Listens on localhost:PORT. Agent (Claude Code) sends POST /permission
 * before dangerous operations. Server forwards to Renderer UI via IPC,
 * blocks the HTTP response until user responds or timeout.
 *
 * Graceful degradation: if port is busy, returns false from start()
 * and the entire permission system is silently skipped.
 */
export class PermissionServer {
  private server: http.Server | null = null
  private pending = new Map<string, PendingRequest>()
  private win: BrowserWindow
  private timeout: number
  public readonly port: number
  public running = false

  constructor(win: BrowserWindow, timeout: number, port: number) {
    this.win = win
    this.timeout = timeout
    this.port = port
  }

  async start(): Promise<boolean> {
    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

        if (req.method === 'OPTIONS') {
          res.writeHead(204)
          res.end()
          return
        }

        if (req.method === 'POST' && req.url === '/permission') {
          this.handlePermissionRequest(req, res)
          return
        }

        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Not found' }))
      })

      this.server.on('error', (err: any) => {
        if (err.code === 'EADDRINUSE') {
          console.warn(`[permission] Port ${this.port} busy — permission system disabled`)
        } else {
          console.error(`[permission] Server error: ${err.message}`)
        }
        this.server = null
        resolve(false)
      })

      this.server.listen(this.port, '127.0.0.1', () => {
        this.running = true
        console.log(`[permission] Server listening on 127.0.0.1:${this.port}`)
        resolve(true)
      })
    })
  }

  private handlePermissionRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    req.on('end', () => {
      // Explicitly decode as UTF-8 — Windows bash/curl may send in GBK
      const body = Buffer.concat(chunks).toString('utf-8')
      let parsed: PermissionRequestBody
      try {
        parsed = JSON.parse(body)
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ approved: false, error: 'Invalid JSON' }))
        return
      }

      if (!parsed.tool || !parsed.description) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ approved: false, error: 'Missing tool or description' }))
        return
      }

      const id = `perm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

      console.log(`[permission] Request ${id}: ${parsed.tool} — ${parsed.description}`)

      // Send to renderer via IPC
      if (!this.win.isDestroyed()) {
        this.win.webContents.send('permission-request', {
          id,
          tool: parsed.tool,
          description: parsed.description,
          detail: parsed.detail,
        })
      }

      // Block HTTP response until user decides or timeout
      const timer = setTimeout(() => {
        this.pending.delete(id)
        console.log(`[permission] Timeout: ${id}`)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ approved: false, reason: 'timeout' }))
      }, this.timeout)

      this.pending.set(id, {
        resolve: (result) => {
          console.log(`[permission] Resolved: ${id} → ${result.approved ? 'approved' : 'denied'}`)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(result))
        },
        timer,
      })
    })
  }

  /** Called from IPC handler when renderer sends user decision */
  resolveRequest(id: string, approved: boolean): void {
    const pending = this.pending.get(id)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pending.delete(id)
    pending.resolve({ approved })
  }

  /** Reject all pending requests (called during abort) */
  rejectAll(): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.resolve({ approved: false, reason: 'aborted' })
    }
    this.pending.clear()
  }

  /** Stop the HTTP server */
  stop(): void {
    this.rejectAll()
    if (this.server) {
      this.server.close()
      this.server = null
      this.running = false
      console.log('[permission] Server stopped')
    }
  }
}
