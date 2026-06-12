/**
 * CaretDetector — detects if the user's cursor is inside an input field.
 *
 * Multi-strategy detection:
 * 1. GetGUIThreadInfo → hwndCaret (standard Win32 caret)
 * 2. GetFocus → check window class name for known text input classes
 * 3. Cursor shape check — if current cursor is I-beam, user is hovering over
 *    a text area (works for browsers, Electron apps, etc.)
 *
 * Call this BEFORE hiding the overlay or changing window focus,
 * so the result reflects the user's actual context at the moment of long-press.
 */

import * as koffi from 'koffi'

export interface CaretContext {
  /** True if user is likely in an input field */
  inInputField: boolean
  /** Window handle of the element with the caret */
  hwndCaret: number
  /** Caret rectangle in screen coordinates (may be zero if not exposed) */
  caretRect: { left: number; top: number; right: number; bottom: number }
  /** Which strategy detected the input field */
  strategy: string
}

let _user32: any = null
let _ibeamHandle: number = 0

async function getUser32() {
  if (!_user32) {
    _user32 = koffi.load('user32.dll')

    // Pre-load the I-beam cursor handle (IDC_IBEAM = 32513)
    // Using uint64 for the MAKEINTRESOURCE parameter works on x64
    try {
      const HWND = koffi.pointer('HWND', 'void *')
      const loadCursorW = _user32.func('__stdcall', 'LoadCursorW', 'void *', ['void *', 'uint64'])
      _ibeamHandle = Number(loadCursorW(null, 32513n))
    } catch {}
  }
  return _user32
}

/**
 * Get the class name of a window handle.
 */
async function getClassName(hwnd: number): Promise<string> {
  const user32 = await getUser32()
  const buf = Buffer.alloc(512)
  const HWND = koffi.pointer('HWND', 'void *')
  const getClassNameW = user32.func('__stdcall', 'GetClassNameW', 'int', [HWND, 'void *', 'int'])
  const len = getClassNameW(hwnd, buf, 256)
  if (len <= 0) return ''
  return Buffer.from(buf.buffer, buf.byteOffset, len * 2).toString('utf16le')
}

/**
 * Check if a window class name belongs to a known text input control.
 */
function isTextInputClass(className: string): boolean {
  if (!className) return false
  const lower = className.toLowerCase()

  const textClasses = [
    'edit',
    'richedit',
    'richedit20w',
    'richtextedit',
    'msctf_composition',
    'chat_edit',
    'wechatrichtexteditctrl',
    'textinput',
    'input',
  ]

  if (textClasses.includes(lower)) return true
  if (lower.includes('edit') && !lower.includes('list') && !lower.includes('combo')) return true
  if (lower.includes('textinput')) return true
  if (lower.includes('chat_edit')) return true

  return false
}

/**
 * Check if the current mouse cursor is an I-beam (text selection cursor).
 * Works across all apps including browsers where hwndCaret is always 0.
 */
async function isIBeamCursor(): Promise<boolean> {
  try {
    const user32 = await getUser32()
    if (!_ibeamHandle) return false

    // CURSORINFO struct (x64): cbSize(4) + flags(4) + hCursor(8) + ptScreenPos(8) = 24
    const ci = Buffer.alloc(24)
    ci.writeUInt32LE(24, 0)

    const getCursorInfo = user32.func('__stdcall', 'GetCursorInfo', 'int', ['void *'])
    if (!getCursorInfo(ci)) return false

    const flags = ci.readUInt32LE(4)
    if (!(flags & 0x0001)) return false  // CURSOR_SHOWING

    const hCursor = Number(ci.readBigUInt64LE(8))
    return hCursor === _ibeamHandle
  } catch {
    return false
  }
}

/**
 * Get the foreground window handle.
 */
async function getForegroundHwnd(): Promise<number> {
  const user32 = await getUser32()
  const getForegroundWindow = user32.func('__stdcall', 'GetForegroundWindow', 'void *', [])
  return Number(getForegroundWindow())
}

export async function detectCaret(): Promise<CaretContext> {
  const empty: CaretContext = { inInputField: false, hwndCaret: 0, caretRect: { left: 0, top: 0, right: 0, bottom: 0 }, strategy: 'none' }

  try {
    const user32 = await getUser32()

    // ─── Strategy 1: Standard Win32 caret (hwndCaret) ───
    const buf = Buffer.alloc(72)
    buf.writeUInt32LE(72, 0)

    const getGUIThreadInfo = user32.func('__stdcall', 'GetGUIThreadInfo', 'int', ['uint', 'void *'])
    const ok = getGUIThreadInfo(0, buf)

    if (ok) {
      const hwndCaret = Number(buf.readBigUInt64LE(48)) || 0
      const hwndFocus = Number(buf.readBigUInt64LE(16)) || 0

      if (hwndCaret !== 0) {
        const left = buf.readInt32LE(56)
        const top = buf.readInt32LE(60)
        const right = buf.readInt32LE(64)
        const bottom = buf.readInt32LE(68)
        return { inInputField: true, hwndCaret, caretRect: { left, top, right, bottom }, strategy: 'hwndCaret' }
      }

      // ─── Strategy 2: Focused window class name ───
      if (hwndFocus !== 0) {
        const className = await getClassName(hwndFocus)
        if (isTextInputClass(className)) {
          console.log(`[input] Strategy 2: focused class="${className}" → input field`)
          return { inInputField: true, hwndCaret: hwndFocus, caretRect: { left: 0, top: 0, right: 0, bottom: 0 }, strategy: 'className' }
        }
      }
    }

    // ─── Strategy 3: I-beam cursor shape ───
    // If the mouse cursor is I-beam, user is hovering over a text area.
    // This catches browsers (Chrome, Edge, Firefox), Electron apps, and
    // any app where the system caret isn't exposed but the cursor changes.
    if (await isIBeamCursor()) {
      const hwndFocus = ok ? (Number(buf.readBigUInt64LE(16)) || 0) : 0
      const className = hwndFocus ? await getClassName(hwndFocus) : ''
      console.log(`[input] Strategy 3: I-beam cursor detected (class="${className}") → input field`)
      return { inInputField: true, hwndCaret: hwndFocus, caretRect: { left: 0, top: 0, right: 0, bottom: 0 }, strategy: 'ibeamCursor' }
    }

    return empty
  } catch {
    return empty
  }
}
