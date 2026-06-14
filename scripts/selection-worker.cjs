/**
 * Selection hook worker — runs in a SEPARATE Node.js process.
 *
 * WHY: selection-hook uses WH_MOUSE_LL (low-level mouse hook) to detect when
 * the user finishes selecting text. This hook requires a standard Windows
 * message pump (GetMessage/DispatchMessage). Electron's Chromium message loop
 * doesn't pump hook messages, so the hook callback never fires in-process.
 *
 * Running in a child process gives selection-hook its own message loop,
 * independent of Electron/Chromium.
 *
 * Communication: JSON lines on stdout, commands on stdin.
 * - Output: {"type":"selection","text":"...","programName":"...","method":1}
 * - Output: {"type":"status","started":true}
 * - Input:  {"cmd":"stop"} — shut down gracefully
 */

// @ts-check

let hook = null

async function main() {
  try {
    const SH = require('selection-hook')
    hook = new SH()

    // Clipboard fallback policy: enabled by default (good for SPA selection
    // detection), but temporarily disabled while the user is taking a
    // screenshot. selection-hook's fallback simulates Ctrl+C on mouse-up,
    // which races against screenshot tools writing image data to the clipboard
    // and clobbers it (Win+Shift+S, Snipping Tool, ShareX, Snipaste, etc.).
    //
    // Solution: listen for screenshot hotkeys (PrintScreen, Win+Shift+S) and
    // disable clipboard fallback for ~5 seconds while the user is capturing.
    // After the window expires, restore the default behavior.
    //
    // Detection priority: UIA (method=1) > IAccessible (method=3) > Clipboard (method=99)
    let clipboardEnabled = true
    let screenshotTimer = null
    let winPressed = false
    let shiftPressed = false

    const SCREENSHOT_DISABLE_MS = 5000

    function setClipboardEnabled(enabled) {
      if (enabled === clipboardEnabled) return
      clipboardEnabled = enabled
      if (enabled) {
        hook.enableClipboard()
        console.error('[selection-worker] Clipboard fallback re-enabled')
      } else {
        hook.disableClipboard()
        console.error('[selection-worker] Clipboard fallback disabled (screenshot mode)')
      }
    }

    function enterScreenshotMode() {
      setClipboardEnabled(false)
      if (screenshotTimer) clearTimeout(screenshotTimer)
      screenshotTimer = setTimeout(() => {
        screenshotTimer = null
        setClipboardEnabled(true)
      }, SCREENSHOT_DISABLE_MS)
    }

    hook.on('key-down', (data) => {
      const key = data.uniKey

      // Track modifier states for Win+Shift+S detection.
      // (sys flag tells us a modifier is down, but doesn't distinguish which.)
      if (key === 'Meta' || key === 'OS') winPressed = true
      if (key === 'Shift') shiftPressed = true

      // PrintScreen: standalone screenshot key.
      // Most generic — works for full-screen capture, Snipping Tool, etc.
      if (key === 'PrintScreen') {
        enterScreenshotMode()
        return
      }

      // Win+Shift+S: Windows Snipping Tool overlay.
      // sys=true (Win is pressed) + shift tracked separately + 's' key.
      // Avoids false positives from Ctrl+S, Win+S, etc.
      if (key === 's' && data.sys && winPressed && shiftPressed) {
        enterScreenshotMode()
        return
      }
    })

    hook.on('key-up', (data) => {
      const key = data.uniKey
      if (key === 'Meta' || key === 'OS') winPressed = false
      if (key === 'Shift') shiftPressed = false
    })

    hook.on('text-selection', (data) => {
      if (data.text && data.text.trim()) {
        send({ type: 'selection', text: data.text, programName: data.programName || '', method: data.method })
      }
    })

    hook.on('error', (err) => {
      send({ type: 'error', message: err.message })
    })

    const started = hook.start()
    send({ type: 'status', started })

    if (!started) {
      process.exit(1)
    }

    // Listen for commands from parent
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => {
      for (const line of chunk.split('\n')) {
        if (!line.trim()) continue
        try {
          const msg = JSON.parse(line)
          if (msg.cmd === 'stop') {
            if (hook) { try { hook.cleanup() } catch {} }
            process.exit(0)
          }
          // Active snapshot: query current selection on demand.
          // Used when the mouse-action classifier detects a selection-intent
          // gesture (drag/dblclick/trplclick) — passive events may have
          // arrived BEFORE the maction (during the drag itself), getting
          // discarded by the state machine. This snapshot lets us fetch the
          // authoritative current selection at the moment we know the user
          // intended to select.
          if (msg.cmd === 'snapshot') {
            try {
              const sel = hook.getCurrentSelection()
              if (sel && sel.text && sel.text.trim()) {
                send({
                  type: 'selection',
                  text: sel.text,
                  programName: sel.programName || '',
                  method: sel.method,
                  snapshot: true,  // mark as authoritative
                })
              } else {
                send({ type: 'snapshot-empty' })
              }
            } catch (err) {
              send({ type: 'error', message: 'snapshot failed: ' + (err.message || String(err)) })
            }
          }
        } catch {}
      }
    })

    // Keep the process alive
    setInterval(() => {}, 60000)
  } catch (err) {
    send({ type: 'error', message: err instanceof Error ? err.message : String(err) })
    process.exit(1)
  }
}

function send(data) {
  process.stdout.write(JSON.stringify(data) + '\n')
}

main()
