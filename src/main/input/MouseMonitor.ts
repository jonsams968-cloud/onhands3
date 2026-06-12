import { EventEmitter } from 'events'
import type { LongPressEvent, LongPressEndEvent } from '../../shared/types'

/**
 * Mouse long-press detector using GetAsyncKeyState polling.
 *
 * Also captures cursor shape at mouse-down time to determine if the
 * user clicked in a text field (I-beam cursor = text input area).
 */

export interface LongPressEventExt extends LongPressEvent {
  /** True if the cursor was I-beam at mouse-down time (text input area) */
  isIBeam: boolean
}

export class MouseMonitor extends EventEmitter {
  private timer: ReturnType<typeof setTimeout> | null = null
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private mouseDownPos = { x: 0, y: 0 }
  private mouseDownTime = 0
  private isLongPress = false
  private wasMouseDown = false
  private readonly longPressMs: number
  private readonly dragThresholdPx: number
  private user32: any = null
  private ibeamHandle: number = 0
  /** Cursor shape captured at mouse-down time */
  private mouseDownIsIBeam = false

  constructor(longPressMs = 800, dragThresholdPx = 15) {
    super()
    this.longPressMs = longPressMs
    this.dragThresholdPx = dragThresholdPx
  }

  async start(): Promise<void> {
    const koffi = await import('koffi')
    this.user32 = koffi.load('user32.dll')

    // Pre-load I-beam cursor handle (IDC_IBEAM = 32513)
    try {
      const loadCursorW = this.user32.func('__stdcall', 'LoadCursorW', 'void *', ['void *', 'uint64'])
      this.ibeamHandle = Number(loadCursorW(null, 32513n))
    } catch {}

    const getAsyncKeyState = this.user32.func('__stdcall', 'GetAsyncKeyState', 'short', ['int'])
    const getCursorPos = this.user32.func('__stdcall', 'GetCursorPos', 'int', ['void *'])
    const VK_LBUTTON = 0x01

    this.pollTimer = setInterval(() => {
      try {
        const state = getAsyncKeyState(VK_LBUTTON)
        const isDown = (state & 0x8000) !== 0

        const buf = Buffer.alloc(8)
        getCursorPos(buf)
        const x = buf.readInt32LE(0)
        const y = buf.readInt32LE(4)

        if (isDown && !this.wasMouseDown) {
          this.onMouseDown(x, y)
        } else if (!isDown && this.wasMouseDown) {
          this.onMouseUp(x, y)
        } else if (isDown) {
          this.onMouseMove(x, y)
        }
        this.wasMouseDown = isDown
      } catch { /* poll errors are non-fatal */ }
    }, 50)
  }

  async stop(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null }
    if (this.user32) { try { this.user32.unload() } catch {} this.user32 = null }
  }

  /** Check if current cursor is I-beam */
  private checkIBeam(): boolean {
    if (!this.ibeamHandle || !this.user32) return false
    try {
      const ci = Buffer.alloc(24)
      ci.writeUInt32LE(24, 0)
      const getCursorInfo = this.user32.func('__stdcall', 'GetCursorInfo', 'int', ['void *'])
      if (!getCursorInfo(ci)) return false
      const flags = ci.readUInt32LE(4)
      if (!(flags & 0x0001)) return false  // CURSOR_SHOWING
      const hCursor = Number(ci.readBigUInt64LE(8))
      return hCursor === this.ibeamHandle
    } catch { return false }
  }

  private onMouseDown(x: number, y: number): void {
    this.mouseDownPos = { x, y }
    this.mouseDownTime = Date.now()
    this.isLongPress = false

    // Capture cursor shape NOW — at mouse-down time
    // This is the reliable moment: cursor hasn't changed yet
    this.mouseDownIsIBeam = this.checkIBeam()

    this.timer = setTimeout(() => {
      this.isLongPress = true
      this.emit('longpress', {
        x: this.mouseDownPos.x,
        y: this.mouseDownPos.y,
        timestamp: Date.now(),
        isIBeam: this.mouseDownIsIBeam,
      } satisfies LongPressEventExt)
    }, this.longPressMs)
  }

  private onMouseUp(x: number, y: number): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    if (this.isLongPress) {
      this.emit('longpressend', { x, y, duration: Date.now() - this.mouseDownTime } satisfies LongPressEndEvent)
    }
    this.isLongPress = false
  }

  private onMouseMove(x: number, y: number): void {
    if (!this.timer) return
    const dx = x - this.mouseDownPos.x
    const dy = y - this.mouseDownPos.y
    if (Math.sqrt(dx * dx + dy * dy) > this.dragThresholdPx) {
      clearTimeout(this.timer)
      this.timer = null
      this.isLongPress = false
    }
  }
}
