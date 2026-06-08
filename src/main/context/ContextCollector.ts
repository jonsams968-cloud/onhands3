import { screen, desktopCapturer } from 'electron'
import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { DesktopContext } from '../../shared/types'

// Lazy-loaded Win32 API (loaded on first use via dynamic import of koffi)
let _user32: any = null
let _getForegroundWindow: any = null
let _getForegroundWindowPtr: any = null
let _getWindowTextW: any = null
let _getWindowThreadProcessId: any = null
async function loadWin32(): Promise<void> {
  if (_user32) return
  const koffi = await import('koffi')
  _user32 = koffi.load('user32.dll')
  // Return HWND as void* for passing to other Win32 functions
  _getForegroundWindowPtr = _user32.func('GetForegroundWindow', 'void *', [])
  // Also return HWND as uint64 for numeric comparison with Shell COM HWND
  _getForegroundWindow = _user32.func('GetForegroundWindow', 'uint64', [])
  _getWindowTextW = _user32.func('GetWindowTextW', 'int', ['void *', 'void *', 'int'])
  _getWindowThreadProcessId = _user32.func('GetWindowThreadProcessId', 'uint32', ['void *', 'void *'])
}

/**
 * Collects desktop context: screenshot, active window, clipboard.
 *
 * Uses Win32 API (koffi) for window capture — much faster and more reliable
 * than PowerShell, no encoding issues with Chinese text.
 */
export class ContextCollector {
  private capturedWindow: DesktopContext['activeWindow'] = null
  private capturedWorkingDir: string | null = null
  private capturedSelectedFiles: string[] | null = null
  private capturedSelectedText: string | null = null
  private capturedScreenshot: string | undefined = undefined
  private capturedScreenshotPath: string | null = null
  private capturedClipboard: string | null = null
  private ownPid = process.pid

  /**
   * Capture the foreground window using Win32 API.
   * Also queries Shell COM for Explorer windows to get the real folder path.
   * Call this BEFORE showing overlay (which steals focus).
   */
  async captureActiveWindow(): Promise<DesktopContext['activeWindow']> {
    // Reset state
    this.capturedWorkingDir = null
    this.capturedSelectedFiles = null
    this.capturedSelectedText = null
    this.capturedScreenshot = undefined
    this.capturedScreenshotPath = null
    this.capturedClipboard = null

    try {
      await loadWin32()

      // Get HWND as void* for passing to other Win32 functions
      // Retry with increasing delays — foreground window may not switch immediately
      let hwndPtr: any = null
      for (let i = 0; i < 5; i++) {
        hwndPtr = _getForegroundWindowPtr()
        if (hwndPtr) break
        await new Promise(r => setTimeout(r, 50))
      }
      if (!hwndPtr) {
        console.log('[context] GetForegroundWindow returned null after retries')
        return null
      }

      // Get HWND as uint64 for numeric comparison (Shell COM matching)
      const hwndNum = _getForegroundWindow()

      // Get window title (Unicode)
      const titleBuf = Buffer.alloc(512 * 2) // 512 wchars
      const titleLen = _getWindowTextW(hwndPtr, titleBuf, 512)
      const title = titleLen > 0 ? titleBuf.toString('utf16le', 0, titleLen * 2) : ''

      // Get PID of the foreground window
      const pidBuf = Buffer.alloc(4)
      _getWindowThreadProcessId(hwndPtr, pidBuf)
      const pid = pidBuf.readUInt32LE(0)

      // Skip our own Electron process
      if (pid === this.ownPid) {
        console.log(`[context] Skipping own window (pid=${pid})`)
        return null
      }

      // Get process name via PID
      const processName = this.getProcessName(pid)

      if (!processName && !title) return null

      const result = { processName: processName || '', title, pid }
      console.log(`[context] Captured: ${processName} — "${title.slice(0, 60)}" (pid=${pid}, hwnd=${hwndNum})`)

      // Parse working directory from window title (synchronous, instant)
      if (processName?.toLowerCase() === 'windowsterminal' ||
          processName?.toLowerCase() === 'cmd' ||
          processName?.toLowerCase() === 'powershell') {
        const pathMatch = title.match(/[A-Z]:\\[^\s]*/i)
        if (pathMatch && fs.existsSync(pathMatch[0])) {
          this.capturedWorkingDir = pathMatch[0]
          console.log(`[context] Terminal working dir: ${pathMatch[0]}`)
        }
      }

      if (processName?.toLowerCase() === 'code') {
        const match = title.match(/[-–—]\s*([A-Z]:\\[^\s]+)/i)
        if (match && fs.existsSync(match[1])) {
          this.capturedWorkingDir = match[1]
          console.log(`[context] VSCode working dir: ${match[1]}`)
        }
      }

      // Run all I/O-bound captures in parallel (Explorer Shell COM, screenshot, clipboard)
      const [explorerCtx, screenshot, clipboardText] = await Promise.all([
        processName?.toLowerCase() === 'explorer'
          ? Promise.resolve(this.queryExplorerContext(hwndNum))
          : Promise.resolve(null as { dir: string | null, files: string[] | null } | null),
        this.captureWindowScreenshot(title).catch(() => undefined),
        this.readClipboard().catch(() => null),
      ])

      // Apply Explorer results
      if (explorerCtx) {
        if (explorerCtx.dir) {
          this.capturedWorkingDir = explorerCtx.dir
          console.log(`[context] Explorer working dir: ${explorerCtx.dir}`)
        } else {
          const parsedDir = this.parseExplorerTitle(title)
          if (parsedDir) {
            this.capturedWorkingDir = parsedDir
            console.log(`[context] Explorer title dir: ${parsedDir}`)
          }
        }
        if (explorerCtx.files && explorerCtx.files.length > 0) {
          this.capturedSelectedFiles = explorerCtx.files
          console.log(`[context] Selected files: ${explorerCtx.files.length} items — ${explorerCtx.files.slice(0, 3).map(f => path.basename(f)).join(', ')}${explorerCtx.files.length > 3 ? '...' : ''}`)
        }
      }
      this.capturedScreenshot = screenshot
      this.capturedClipboard = clipboardText
      if (screenshot) {
        // Save screenshot as temp PNG file for agent to Read on demand
        const screenshotPath = path.join(os.tmpdir(), 'onhands-screenshot.png')
        fs.writeFileSync(screenshotPath, Buffer.from(screenshot, 'base64'))
        this.capturedScreenshotPath = screenshotPath
        console.log(`[context] Screenshot saved: ${screenshotPath} (${Math.round(screenshot.length * 0.75 / 1024)}KB)`)
      }
      if (clipboardText) console.log(`[context] Clipboard captured (${clipboardText.length} chars)`)

      return result
    } catch (err) {
      console.error(`[context] Window capture failed: ${err}`)
      return null
    }
  }

  /**
   * Assemble the captured context. All data was already collected at longpress time.
   * This is now synchronous — safe to call at any point after captureActiveWindow().
   */
  collect(): DesktopContext {
    return {
      screenshot: this.capturedScreenshot,
      screenshotPath: this.capturedScreenshotPath || undefined,
      activeWindow: this.capturedWindow,
      clipboard: this.capturedClipboard,
      workingDirectory: this.capturedWorkingDir || process.cwd(),
      selectedFiles: this.capturedSelectedFiles || undefined,
      selectedText: this.capturedSelectedText || undefined,
    }
  }

  setCapturedWindow(win: DesktopContext['activeWindow']): void {
    this.capturedWindow = win
  }

  formatForPrompt(ctx: DesktopContext): string {
    const parts: string[] = []

    if (ctx.activeWindow) {
      parts.push(`Active window: ${ctx.activeWindow.processName} — "${ctx.activeWindow.title}"`)
    }
    if (ctx.selectedFiles && ctx.selectedFiles.length > 0) {
      parts.push(`Selected files (user selected these in Explorer):\n${ctx.selectedFiles.map(f => `- ${f}`).join('\n')}`)
    }
    if (ctx.selectedText) {
      parts.push(`Selected text (HIGHEST PRIORITY — user selected this before activating):\n${ctx.selectedText.slice(0, 2000)}`)
    }
    if (ctx.clipboard) {
      const clipped = ctx.clipboard.length > 2000
        ? ctx.clipboard.slice(0, 2000) + '...[truncated]'
        : ctx.clipboard
      parts.push(`Clipboard content:\n${clipped}`)
    }
    parts.push(`Working directory: ${ctx.workingDirectory}`)

    return parts.join('\n\n')
  }

  // ---- Private helpers ----

  /**
   * Set selected text captured by SelectionMonitor (background accessibility API monitor).
   * Called by Orchestrator after captureActiveWindow() with the latest selection.
   */
  setSelectedText(text: string | null): void {
    this.capturedSelectedText = text
    if (text) {
      console.log(`[context] Selected text set (${text.length} chars): "${text.slice(0, 60)}..."`)
    }
  }

  /**
   * Get Explorer's current folder via Shell COM automation.
   * Uses exact HWND matching to find the correct Explorer window.
   */
  /**
   * Query Explorer folder path AND selected files in a single PowerShell call.
   * Returns { dir: string | null, files: string[] | null }
   */
  private queryExplorerContext(hwndNum: number | bigint): { dir: string | null, files: string[] | null } {
    const empty = { dir: null as string | null, files: null as string[] | null }
    try {
      const hwndStr = typeof hwndNum === 'bigint' ? hwndNum.toString() : String(hwndNum)

      // Single PowerShell call: get both folder path and selected files
      // Output format: DIR:<base64path> then FILE:<base64path> per selected file
      const output = execFileSync('powershell', [
        '-NoProfile', '-Command',
        `$targetHwnd = ${hwndStr}; ` +
        `$shell = New-Object -ComObject Shell.Application; ` +
        `$wins = $shell.Windows(); ` +
        `foreach ($w in $wins) { ` +
        `  try { ` +
        `    if ($w.HWND -eq $targetHwnd) { ` +
        `      $url = $w.LocationURL; ` +
        `      if ($url -and $url.StartsWith('file:')) { ` +
        `        $uri = New-Object System.Uri($url); ` +
        `        $decoded = [System.Uri]::UnescapeDataString($uri.AbsoluteUri); ` +
        `        $pUri = New-Object System.Uri($decoded); ` +
        `        $localPath = $pUri.LocalPath; ` +
        `        if ($localPath -and (Test-Path $localPath)) { ` +
        `          $b64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($localPath)); ` +
        `          Write-Output "DIR:$b64"; ` +
        `        } ` +
        `      } ` +
        `      $items = $w.Document.SelectedItems(); ` +
        `      foreach ($item in $items) { ` +
        `        $p = $item.Path; ` +
        `        if ($p) { ` +
        `          $b64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($p)); ` +
        `          Write-Output "FILE:$b64"; ` +
        `        } ` +
        `      } ` +
        `      break; ` +
        `    } ` +
        `  } catch {} ` +
        `}`,
      ], { encoding: 'utf-8', timeout: 8000 }).trim()

      if (!output) {
        console.log(`[context] Shell COM: no match for HWND=${hwndStr}`)
        return empty
      }

      let dir: string | null = null
      const files: string[] = []

      for (const line of output.split('\n')) {
        const trimmed = line.trim()
        if (trimmed.startsWith('DIR:')) {
          try {
            const decoded = Buffer.from(trimmed.slice(4), 'base64').toString('utf-8')
            if (decoded && fs.existsSync(decoded)) dir = decoded
          } catch {}
        } else if (trimmed.startsWith('FILE:')) {
          try {
            const decoded = Buffer.from(trimmed.slice(5), 'base64').toString('utf-8')
            if (decoded && fs.existsSync(decoded)) files.push(decoded)
          } catch {}
        }
      }

      return { dir, files: files.length > 0 ? files : null }
    } catch (err) {
      console.error(`[context] Shell COM failed: ${err}`)
      return empty
    }
  }

  /**
   * Parse Explorer window title to extract a folder path.
   * Only works when the title contains a full drive path.
   */
  private parseExplorerTitle(title: string): string | null {
    // Try to match a drive path in the title
    const driveMatch = title.match(/[A-Z]:\\[^\n"<>|?]*/i)
    if (driveMatch) {
      const dir = driveMatch[0]
      if (fs.existsSync(dir)) return dir
    }

    // Clean " - 资源管理器" suffix and try as full path
    const cleanTitle = title.replace(/\s*[-–—]\s*(资源管理器|File Explorer|Explorer)\s*$/i, '').trim()
    if (cleanTitle.includes(':') && fs.existsSync(cleanTitle)) {
      return cleanTitle
    }

    return null
  }

  /**
   * Capture screenshot of the active window (not full screen).
   * Uses desktopCapturer with 'window' type, matching by title.
   * Falls back to full screen if window capture fails.
   */
  private async captureWindowScreenshot(title: string): Promise<string | undefined> {
    // Try window-specific capture first
    try {
      const sources = await desktopCapturer.getSources({
        types: ['window'],
        thumbnailSize: { width: 1920, height: 1080 },
      })
      // Match by title (partial match for long titles)
      const match = sources.find(s =>
        s.name && title && (title.includes(s.name) || s.name.includes(title))
      )
      if (match && match.thumbnail && !match.thumbnail.isEmpty()) {
        return match.thumbnail.toPNG().toString('base64')
      }
    } catch (err) {
      console.log(`[context] Window screenshot failed, trying full screen: ${err}`)
    }

    // Fallback: full screen
    return this.captureScreen()
  }

  private async captureScreen(): Promise<string | undefined> {
    const primary = screen.getPrimaryDisplay()
    const { width, height, scaleFactor } = primary
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: Math.round(width * scaleFactor), height: Math.round(height * scaleFactor) },
    })
    return sources[0]?.thumbnail.toPNG().toString('base64') || undefined
  }

  private async readClipboard(): Promise<string | null> {
    const text = execFileSync('powershell', [
      '-NoProfile', '-Command',
      '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Get-Clipboard',
    ], { encoding: 'utf-8', timeout: 5000 }).trim()
    return text || null
  }

  /**
   * Get process name from PID using Windows tasklist.
   */
  private getProcessName(pid: number): string | null {
    try {
      const result = execFileSync('tasklist', [
        '/FI', `PID eq ${pid}`,
        '/FO', 'CSV',
        '/NH',
      ], { encoding: 'utf-8', timeout: 3000 }).trim()

      // Parse CSV output: "explorer.exe","12345","Console","1","123,456 K"
      const match = result.match(/"([^"]+\.\w+)"/)
      if (match) {
        return match[1].replace(/\.exe$/i, '')
      }
      return null
    } catch {
      return null
    }
  }
}
