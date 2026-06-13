/**
 * TextInjector — injects cleaned dictation text into the foreground app.
 *
 * Uses SendInput with KEYEVENTF_UNICODE, packing ALL key events into a single
 * kernel call. This is critical for Chinese text: individual SendInput calls
 * allow the IME to intercept each character, causing garbled output in apps
 * like WeChat. A single atomic batch delivery bypasses IME processing.
 *
 * Supports:
 * - CJK characters, Latin, Cyrillic, etc. (BMP: U+0000..U+FFFF)
 * - Emoji and supplementary characters (surrogate pairs)
 * - Newlines (→ Enter key) and tabs (→ Tab key)
 */

let _koffi: any = null
let _user32: any = null

async function getUser32() {
  if (!_koffi) {
    _koffi = await import('koffi')
    _user32 = _koffi.load('user32.dll')
  }
  return _user32
}

// ─── SendInput constants ───

const INPUT_KEYBOARD = 1
const KEYEVENTF_KEYUP = 0x0002
const KEYEVENTF_UNICODE = 0x0004
const VK_RETURN = 0x0D
const VK_TAB = 0x09

/**
 * Build a 40-byte INPUT structure for a keyboard event.
 *
 * Layout (64-bit Windows):
 *   offset  0: UINT type (4 bytes)
 *   offset  4: padding (4 bytes)
 *   offset  8: WORD wVk (2 bytes)
 *   offset 10: WORD wScan (2 bytes)
 *   offset 12: DWORD dwFlags (4 bytes)
 *   offset 16: DWORD time (4 bytes)
 *   offset 20: ULONG_PTR dwExtraInfo (8 bytes)
 *   offset 28: padding (12 bytes)
 *   Total: 40 bytes
 */
function makeKeyEvent(wVk: number, wScan: number, dwFlags: number): Buffer {
  const buf = Buffer.alloc(40)
  buf.writeUInt32LE(INPUT_KEYBOARD, 0)   // type
  buf.writeUInt16LE(wVk, 8)              // wVk
  buf.writeUInt16LE(wScan, 10)           // wScan
  buf.writeUInt32LE(dwFlags, 12)         // dwFlags
  return buf
}

/**
 * Inject text into the currently focused input field via batch SendInput.
 *
 * ALL key events (down + up for every character) are packed into a single
 * SendInput call. This makes the delivery atomic — the IME sees one burst
 * of keystrokes rather than individual events it can intercept.
 */
export async function injectText(text: string): Promise<boolean> {
  try {
    const events: Buffer[] = []

    let i = 0
    while (i < text.length) {
      const code = text.codePointAt(i)!
      const charLen = code > 0xFFFF ? 2 : 1

      if (code === 0x0A) {
        // Newline → Enter key
        events.push(makeKeyEvent(VK_RETURN, 0, 0))
        events.push(makeKeyEvent(VK_RETURN, 0, KEYEVENTF_KEYUP))
      } else if (code === 0x09) {
        // Tab → Tab key
        events.push(makeKeyEvent(VK_TAB, 0, 0))
        events.push(makeKeyEvent(VK_TAB, 0, KEYEVENTF_KEYUP))
      } else if (code > 0xFFFF) {
        // Supplementary character → send as UTF-16 surrogate pair
        const hi = text.charCodeAt(i)
        const lo = text.charCodeAt(i + 1)
        events.push(makeKeyEvent(0, hi, KEYEVENTF_UNICODE))
        events.push(makeKeyEvent(0, hi, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP))
        events.push(makeKeyEvent(0, lo, KEYEVENTF_UNICODE))
        events.push(makeKeyEvent(0, lo, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP))
      } else {
        // BMP character → single Unicode event
        events.push(makeKeyEvent(0, code, KEYEVENTF_UNICODE))
        events.push(makeKeyEvent(0, code, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP))
      }

      i += charLen
    }

    if (events.length === 0) return true

    // Single atomic SendInput call with all events concatenated
    const batchBuffer = Buffer.concat(events)
    const user32 = await getUser32()
    const sendInput = user32.func('__stdcall', 'SendInput', 'uint', ['uint', 'void *', 'int'])
    const sent = sendInput(events.length, batchBuffer, 40)

    console.log(`[TextInjector] Batch SendInput: ${events.length} events (${batchBuffer.length} bytes) for "${text.slice(0, 30)}", SendInput returned: ${sent}`)

    if (sent === 0) {
      console.warn('[TextInjector] SendInput returned 0 — injection blocked (UIPI or other issue)')
      return false
    }
    if (sent !== events.length) {
      console.warn(`[TextInjector] SendInput partial: ${sent}/${events.length} events injected`)
    }

    // Brief wait for target app to process the keystrokes
    await new Promise(r => setTimeout(r, 5))

    return true
  } catch (err) {
    console.warn('[TextInjector] Failed:', err)
    return false
  }
}
