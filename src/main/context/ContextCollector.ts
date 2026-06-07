import { screen, desktopCapturer, clipboard } from 'electron'
import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import type { DesktopContext } from '../../shared/types'

// Lazy-loaded Win32 API (loaded on first use via dynamic import of koffi)
let _user32: any = null
let _getForegroundWindow: any = null
let _getForegroundWindowPtr: any = null
let _getWindowTextW: any = null
let _getWindowThreadProcessId: any = null
let _keybdEvent: any = null

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
  _keybdEvent = _user32.func('keybd_event', 'void', ['uint8', 'uint8', 'uint32', 'uint64'])
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

    try {
      await loadWin32()

      // Get HWND as void* for passing to other Win32 functions
      const hwndPtr = _getForegroundWindowPtr()
      if (!hwndPtr) {
        console.log('[context] GetForegroundWindow returned null')
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

      // Capture selected text via Ctrl+C simulation (before overlay steals focus)
      this.captureSelectedText(processName)

      // For Explorer: immediately query Shell COM with exact HWND matching
      if (processName?.toLowerCase() === 'explorer') {
        const shellDir = this.getExplorerFolderPath(hwndNum)
        if (shellDir) {
          this.capturedWorkingDir = shellDir
          console.log(`[context] Explorer working dir: ${shellDir}`)
        } else {
          // Fallback: try to parse from title
          const parsedDir = this.parseExplorerTitle(title)
          if (parsedDir) {
            this.capturedWorkingDir = parsedDir
            console.log(`[context] Explorer title dir: ${parsedDir}`)
          }
        }

        // Capture selected files in Explorer
        const selected = this.getExplorerSelectedFiles(hwndNum)
        if (selected && selected.length > 0) {
          this.capturedSelectedFiles = selected
          console.log(`[context] Selected files: ${selected.length} items — ${selected.slice(0, 3).map(f => path.basename(f)).join(', ')}${selected.length > 3 ? '...' : ''}`)
        }
      }

      // For terminals: parse path from title
      if (processName?.toLowerCase() === 'windowsterminal' ||
          processName?.toLowerCase() === 'cmd' ||
          processName?.toLowerCase() === 'powershell') {
        const pathMatch = title.match(/[A-Z]:\\[^\s]*/i)
        if (pathMatch && fs.existsSync(pathMatch[0])) {
          this.capturedWorkingDir = pathMatch[0]
          console.log(`[context] Terminal working dir: ${pathMatch[0]}`)
        }
      }

      // For VS Code: parse folder from title
      if (processName?.toLowerCase() === 'code') {
        const match = title.match(/[-–—]\s*([A-Z]:\\[^\s]+)/i)
        if (match && fs.existsSync(match[1])) {
          this.capturedWorkingDir = match[1]
          console.log(`[context] VSCode working dir: ${match[1]}`)
        }
      }

      return result
    } catch (err) {
      console.error(`[context] Window capture failed: ${err}`)
      return null
    }
  }

  async collect(pressX = 0, pressY = 0): Promise<DesktopContext> {
    const [screenshot, clipboard] = await Promise.all([
      this.captureScreen().catch(() => undefined),
      this.readClipboard().catch(() => null),
    ])

    return {
      screenshot,
      activeWindow: this.capturedWindow,
      clipboard,
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
   * Capture selected text by briefly simulating Ctrl+C.
   * Must be called while foreground window still has focus (before overlay shows).
   * Saves and restores original clipboard content.
   */
  private captureSelectedText(processName: string | null): void {
    if (!_keybdEvent) return

    // Skip terminals where Ctrl+C sends SIGINT
    const lower = (processName || '').toLowerCase()
    if (['windowsterminal', 'cmd', 'powershell'].includes(lower)) return
    if (lower.includes('terminal')) return

    try {
      // Don't risk corrupting non-text clipboard (images, files)
      const formats = clipboard.availableFormats()
      const hasNonText = formats.some(f => !f.startsWith('text/'))
      if (hasNonText) return

      const oldClip = clipboard.readText()

      // Wait for foreground window to fully receive focus after overlay hide
      const focusSAB = new SharedArrayBuffer(4)
      Atomics.wait(new Int32Array(focusSAB), 0, 0, 100)

      // Send Ctrl+C
      const VK_CONTROL = 0x11
      const VK_C = 0x43
      const KEYEVENTF_KEYUP = 0x0002
      _keybdEvent(VK_CONTROL, 0, 0, BigInt(0))
      _keybdEvent(VK_C, 0, 0, BigInt(0))
      _keybdEvent(VK_C, 0, KEYEVENTF_KEYUP, BigInt(0))
      _keybdEvent(VK_CONTROL, 0, KEYEVENTF_KEYUP, BigInt(0))

      // Wait for clipboard to update
      const sab = new SharedArrayBuffer(4)
      Atomics.wait(new Int32Array(sab), 0, 0, 300)

      const newClip = clipboard.readText()

      // Restore original clipboard
      if (oldClip) clipboard.writeText(oldClip)
      else clipboard.clear()

      // If clipboard changed → it's the selected text
      if (newClip && newClip !== oldClip) {
        this.capturedSelectedText = newClip
        console.log(`[context] Selected text captured (${newClip.length} chars): "${newClip.slice(0, 60)}..."`)
      }
    } catch (err) {
      console.error(`[context] Selected text capture failed: ${err}`)
    }
  }

  /**
   * Get Explorer's current folder via Shell COM automation.
   * Uses exact HWND matching to find the correct Explorer window.
   */
  private getExplorerFolderPath(hwndNum: number | bigint): string | null {
    try {
      // Pass HWND to PowerShell for exact Shell COM window matching
      const hwndStr = typeof hwndNum === 'bigint' ? hwndNum.toString() : String(hwndNum)

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
        `          Write-Output $b64; ` +
        `        } ` +
        `      } ` +
        `      break; ` +
        `    } ` +
        `  } catch {} ` +
        `}`,
      ], { encoding: 'utf-8', timeout: 8000 }).trim()

      if (!output) {
        console.log(`[context] Shell COM: no match for HWND=${hwndStr}`)
        return null
      }

      // Decode Base64 path
      const decoded = Buffer.from(output.split('\n')[0].trim(), 'base64').toString('utf-8')
      if (decoded && fs.existsSync(decoded)) {
        return decoded
      }
      return null
    } catch (err) {
      console.error(`[context] Shell COM failed: ${err}`)
      return null
    }
  }

  /**
   * Get selected files in the Explorer window matching the given HWND.
   * Uses Shell COM automation to query SelectedItems().
   */
  private getExplorerSelectedFiles(hwndNum: number | bigint): string[] | null {
    try {
      const hwndStr = typeof hwndNum === 'bigint' ? hwndNum.toString() : String(hwndNum)

      // Query Shell COM for selected items in the matching Explorer window
      // Output: Base64-encoded JSON array of file paths (one per line)
      const output = execFileSync('powershell', [
        '-NoProfile', '-Command',
        `$targetHwnd = ${hwndStr}; ` +
        `$shell = New-Object -ComObject Shell.Application; ` +
        `$wins = $shell.Windows(); ` +
        `foreach ($w in $wins) { ` +
        `  try { ` +
        `    if ($w.HWND -eq $targetHwnd) { ` +
        `      $items = $w.Document.SelectedItems(); ` +
        `      foreach ($item in $items) { ` +
        `        $p = $item.Path; ` +
        `        if ($p) { ` +
        `          $b64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($p)); ` +
        `          Write-Output $b64; ` +
        `        } ` +
        `      } ` +
        `      break; ` +
        `    } ` +
        `  } catch {} ` +
        `}`,
      ], { encoding: 'utf-8', timeout: 8000 }).trim()

      if (!output) return null

      // Decode each Base64 line into a file path
      const paths = output.split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0)
        .map(line => {
          try { return Buffer.from(line, 'base64').toString('utf-8') } catch { return null }
        })
        .filter((p): p is string => !!p && fs.existsSync(p))

      return paths.length > 0 ? paths : null
    } catch (err) {
      console.error(`[context] Selected files capture failed: ${err}`)
      return null
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
