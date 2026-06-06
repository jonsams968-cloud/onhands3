import { EventEmitter } from 'events'
import type { LongPressEvent, LongPressEndEvent } from '../../shared/types'

/**
 * Mouse long-press detector using GetAsyncKeyState polling.
 *
 * No hooks, no callbacks, no FFI registration — just two simple
 * Win32 function calls polled every 80ms via koffi.
 */
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

  constructor(longPressMs = 800, dragThresholdPx = 15) {
    super()
    this.longPressMs = longPressMs
    this.dragThresholdPx = dragThresholdPx
  }

  async start(): Promise<void> {
    const koffi = await import('koffi')
    this.user32 = koffi.load('user32.dll')

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

  private onMouseDown(x: number, y: number): void {
    this.mouseDownPos = { x, y }
    this.mouseDownTime = Date.now()
    this.isLongPress = false

    this.timer = setTimeout(() => {
      this.isLongPress = true
      this.emit('longpress', { x: this.mouseDownPos.x, y: this.mouseDownPos.y, timestamp: Date.now() } satisfies LongPressEvent)
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
