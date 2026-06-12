/**
 * CaretDetector — detects if the user's cursor is inside an input field.
 *
 * Multi-strategy detection:
 * 1. GetGUIThreadInfo → hwndCaret (standard Win32 caret)
 * 2. Fallback: GetFocus → check window class name for known text input classes
 *
 * Call this BEFORE hiding the overlay or changing window focus,
 * so the result reflects the user's actual context at the moment of long-press.
 */

export interface CaretContext {
  /** True if user is likely in an input field */
  inInputField: boolean
  /** Window handle of the element with the caret */
  hwndCaret: number
  /** Caret rectangle in screen coordinates (may be zero if not exposed) */
  caretRect: { left: number; top: number; right: number; bottom: number }
}

let _koffi: any = null
let _user32: any = null

async function getUser32() {
  if (!_koffi) {
    _koffi = await import('koffi')
    _user32 = _koffi.load('user32.dll')
  }
  return _user32
}

/**
 * Get the class name of a window handle.
 */
async function getClassName(hwnd: number): Promise<string> {
  const user32 = await getUser32()
  const buf = Buffer.alloc(512)
  const getClassNameW = user32.func('__stdcall', 'GetClassNameW', 'int', ['pointer', 'void *', 'int'])
  const len = getClassNameW(hwnd, buf, 256)
  if (len <= 0) return ''
  // Read as UTF-16LE
  const chars: number[] = []
  for (let i = 0; i < len; i++) {
    chars.push(buf.readUInt16LE(i * 2))
  }
  return String.fromCharCode(...chars)
}

/**
 * Check if a window class name belongs to a known text input control.
 */
function isTextInputClass(className: string): boolean {
  if (!className) return false
  const lower = className.toLowerCase()

  // Standard Win32 text controls
  const textClasses = [
    'edit',           // Standard Win32 Edit control
    'richedit',       // Rich Edit 1.0
    'richedit20w',    // Rich Edit 2.0+ (Unicode)
    'richtextedit',   // Some apps
    'msctf_composition', // IME composition window
    'chat_edit',      // WeChat input box
    'wechatrichtexteditctrl', // WeChat new version
    'textinput',      // Generic
    'input',          // Generic
  ]

  // Exact match
  if (textClasses.includes(lower)) return true

  // Partial match for common patterns
  if (lower.includes('edit') && !lower.includes('list') && !lower.includes('combo')) return true
  if (lower.includes('textinput')) return true
  if (lower.includes('chat_edit')) return true

  return false
}

export async function detectCaret(): Promise<CaretContext> {
  const empty = { inInputField: false, hwndCaret: 0, caretRect: { left: 0, top: 0, right: 0, bottom: 0 } }

  try {
    const user32 = await getUser32()

    // GUITHREADINFO struct — 72 bytes on x64
    const buf = Buffer.alloc(72)
    buf.writeUInt32LE(72, 0) // cbSize

    const getGUIThreadInfo = user32.func('__stdcall', 'GetGUIThreadInfo', 'int', ['uint', 'void *'])
    const ok = getGUIThreadInfo(0, buf)

    if (!ok) {
      // GetGUIThreadInfo failed — try class name fallback
      return await detectByFocusClass(user32, empty)
    }

    // Read caret info
    const hwndCaret = Number(buf.readBigUInt64LE(48)) || 0
    const hwndFocus = Number(buf.readBigUInt64LE(16)) || 0

    const left = buf.readInt32LE(56)
    const top = buf.readInt32LE(60)
    const right = buf.readInt32LE(64)
    const bottom = buf.readInt32LE(68)

    // Strategy 1: Standard caret detected → high confidence
    if (hwndCaret !== 0) {
      return { inInputField: true, hwndCaret, caretRect: { left, top, right, bottom } }
    }

    // Strategy 2: No caret, but check focused window class name
    if (hwndFocus !== 0) {
      const className = await getClassName(hwndFocus)
      if (isTextInputClass(className)) {
        console.log(`[input] No caret, but focused class="${className}" → input field`)
        return { inInputField: true, hwndCaret: hwndFocus, caretRect: { left: 0, top: 0, right: 0, bottom: 0 } }
      }
    }

    return empty
  } catch {
    return empty
  }
}

/**
 * Fallback: try to detect input field from focused window class name
 * when GetGUIThreadInfo fails entirely.
 */
async function detectByFocusClass(user32: any, fallback: CaretContext): Promise<CaretContext> {
  try {
    const getFocus = user32.func('__stdcall', 'GetFocus', 'pointer', [])
    const hwndFocus = Number(getFocus()) || 0

    if (hwndFocus !== 0) {
      const className = await getClassName(hwndFocus)
      if (isTextInputClass(className)) {
        console.log(`[input] Fallback: focused class="${className}" → input field`)
        return { inInputField: true, hwndCaret: hwndFocus, caretRect: { left: 0, top: 0, right: 0, bottom: 0 } }
      }
    }

    return fallback
  } catch {
    return fallback
  }
}
