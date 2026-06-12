/**
 * TextInjector — injects cleaned dictation text into the foreground app.
 *
 * Strategy: SendInput with KEYEVENTF_UNICODE — sends characters directly
 * as keyboard events. Completely bypasses the clipboard, so screenshots
 * (Win+Shift+S) and other clipboard content are never touched.
 *
 * Works across all Windows input fields:
 * (native Win32, UWP, Electron, web browsers, WPF, etc.)
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
 * Send a single Unicode character via SendInput (key-down + key-up).
 */
async function sendUnicodeChar(code: number): Promise<void> {
  const user32 = await getUser32()
  const sendInput = user32.func('__stdcall', 'SendInput', 'uint', ['uint', 'void *', 'int'])

  // Key down
  const down = Buffer.alloc(40)
  down.writeUInt32LE(INPUT_KEYBOARD, 0)        // type
  down.writeUInt16LE(0, 8)                      // wVk = 0 for Unicode
  down.writeUInt16LE(code, 10)                  // wScan = Unicode code point
  down.writeUInt32LE(KEYEVENTF_UNICODE, 12)     // dwFlags
  sendInput(1, down, 40)

  // Key up
  const up = Buffer.alloc(40)
  up.writeUInt32LE(INPUT_KEYBOARD, 0)
  up.writeUInt16LE(0, 8)
  up.writeUInt16LE(code, 10)
  up.writeUInt32LE(KEYEVENTF_UNICODE | KEYEVENTF_KEYUP, 12)
  sendInput(1, up, 40)
}

/**
 * Send a virtual key (Enter, Tab, etc.) via SendInput.
 */
async function sendVk(vk: number): Promise<void> {
  const user32 = await getUser32()
  const sendInput = user32.func('__stdcall', 'SendInput', 'uint', ['uint', 'void *', 'int'])

  // Key down
  const down = Buffer.alloc(40)
  down.writeUInt32LE(INPUT_KEYBOARD, 0)
  down.writeUInt16LE(vk, 8)
  sendInput(1, down, 40)

  // Key up
  const up = Buffer.alloc(40)
  up.writeUInt32LE(INPUT_KEYBOARD, 0)
  up.writeUInt16LE(vk, 8)
  up.writeUInt32LE(KEYEVENTF_KEYUP, 12)
  sendInput(1, up, 40)
}

/**
 * Inject text into the currently focused input field via Unicode SendInput.
 *
 * Characters are sent as virtual keyboard events — the clipboard is never touched.
 * Supports:
 * - CJK characters, Latin, Cyrillic, etc. (BMP: U+0000..U+FFFF)
 * - Emoji and supplementary characters (surrogate pairs)
 * - Newlines (→ Enter key) and tabs (→ Tab key)
 */
export async function injectText(text: string): Promise<boolean> {
  try {
    let i = 0
    while (i < text.length) {
      const code = text.codePointAt(i)!
      const charLen = code > 0xFFFF ? 2 : 1

      if (code === 0x0A) {
        // Newline → Enter
        await sendVk(VK_RETURN)
      } else if (code === 0x09) {
        // Tab → Tab key
        await sendVk(VK_TAB)
      } else if (code > 0xFFFF) {
        // Supplementary character → send as UTF-16 surrogate pair
        await sendUnicodeChar(text.charCodeAt(i))      // high surrogate
        await sendUnicodeChar(text.charCodeAt(i + 1))   // low surrogate
      } else {
        // BMP character → single SendInput
        await sendUnicodeChar(code)
      }

      i += charLen
    }

    return true
  } catch (err) {
    console.warn('[TextInjector] Failed:', err)
    return false
  }
}
