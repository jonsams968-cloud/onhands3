/**
 * TextInjector — injects cleaned dictation text into the foreground app.
 *
 * Two strategies:
 * 1. injectText: SendInput with KEYEVENTF_UNICODE — sends characters one by one.
 *    Bypasses clipboard entirely, works for most apps.
 *    CAUTION: can produce garbled text with active Chinese IME (e.g. WeChat),
 *    because the IME may intercept KEYEVENTF_UNICODE events.
 *
 * 2. injectTextViaClipboard: clipboard + Ctrl+V — writes to clipboard, pastes,
 *    then restores original clipboard. More reliable across IME states because
 *    Ctrl+V is the standard paste mechanism that all apps handle correctly.
 */

import { clipboard } from 'electron'

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
const VK_CONTROL = 0x11
const VK_V = 0x56

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
 * Send Ctrl+V via SendInput (key-down Ctrl → key-down V → key-up V → key-up Ctrl).
 */
async function sendCtrlV(): Promise<void> {
  const user32 = await getUser32()
  const sendInput = user32.func('__stdcall', 'SendInput', 'uint', ['uint', 'void *', 'int'])

  // Ctrl down
  const ctrlDown = Buffer.alloc(40)
  ctrlDown.writeUInt32LE(INPUT_KEYBOARD, 0)
  ctrlDown.writeUInt16LE(VK_CONTROL, 8)
  sendInput(1, ctrlDown, 40)

  // V down
  const vDown = Buffer.alloc(40)
  vDown.writeUInt32LE(INPUT_KEYBOARD, 0)
  vDown.writeUInt16LE(VK_V, 8)
  sendInput(1, vDown, 40)

  // V up
  const vUp = Buffer.alloc(40)
  vUp.writeUInt32LE(INPUT_KEYBOARD, 0)
  vUp.writeUInt16LE(VK_V, 8)
  vUp.writeUInt32LE(KEYEVENTF_KEYUP, 12)
  sendInput(1, vUp, 40)

  // Ctrl up
  const ctrlUp = Buffer.alloc(40)
  ctrlUp.writeUInt32LE(INPUT_KEYBOARD, 0)
  ctrlUp.writeUInt16LE(VK_CONTROL, 8)
  ctrlUp.writeUInt32LE(KEYEVENTF_KEYUP, 12)
  sendInput(1, ctrlUp, 40)
}

/**
 * Inject text via clipboard + Ctrl+V.
 *
 * More reliable than SendInput for Chinese text in apps with active IME
 * (WeChat, QQ, etc.) because Ctrl+V is the standard paste mechanism that
 * bypasses IME processing entirely.
 *
 * Steps: save clipboard → write text → Ctrl+V → restore clipboard
 * Total time: ~80ms. Safe when overlay is hidden (no screenshot conflict).
 */
export async function injectTextViaClipboard(text: string): Promise<boolean> {
  try {
    // Save current clipboard content
    let savedClipboard = ''
    try { savedClipboard = clipboard.readText() } catch {}

    // Write text to clipboard
    clipboard.writeText(text)
    await new Promise(r => setTimeout(r, 20))

    // Send Ctrl+V to paste
    await sendCtrlV()
    await new Promise(r => setTimeout(r, 50))

    // Restore original clipboard
    try { clipboard.writeText(savedClipboard) } catch {}

    return true
  } catch (err) {
    console.warn('[TextInjector] Clipboard injection failed:', err)
    return false
  }
}

/**
 * Inject text into the currently focused input field via Unicode SendInput.
 *
 * Characters are sent as virtual keyboard events — the clipboard is never touched.
 * Supports:
 * - CJK characters, Latin, Cyrillic, etc. (BMP: U+0000..U+FFFF)
 * - Emoji and supplementary characters (surrogate pairs)
 * - Newlines (→ Enter key) and tabs (→ Tab key)
 *
 * CAUTION: May produce garbled text in apps with active Chinese IME.
 * Use injectTextViaClipboard for dictation where reliability matters.
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
