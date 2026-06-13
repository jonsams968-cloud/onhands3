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

    // IMPORTANT: Disable clipboard fallback.
    //
    // selection-hook enables clipboard fallback by default — when mouse-up
    // fires and UIA/IAccessible can't read a selection, it simulates Ctrl+C
    // to copy whatever might be selected, then reads the clipboard.
    //
    // This BREAKS screen capture tools (Win+Shift+S, Snipping Tool, etc.):
    //   1. User drags to select screenshot region → mouse-up
    //   2. selection-hook fires Ctrl+C (no text selected, so it copies nothing/empty)
    //   3. Screenshot tool writes image to clipboard
    //   4. The two race; Ctrl+C often wins, clobbering the image with empty text
    //   5. User pastes → nothing
    //
    // Disabling clipboard fallback here means:
    //   - Passive text-selection events won't fire for apps where UIA/IAccessible
    //     can't read (some Electron apps, SPA frameworks)
    //   - BUT the snapshot mechanism (getCurrentSelection, called after maction
    //     drag/dblclick/trplclick) still works — it uses the same detection
    //     priority internally and only fires on user-confirmed selection intent
    //
    // Detection priority: UIA (method=1) > IAccessible (method=3) > Clipboard (method=99)
    hook.disableClipboard()

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
