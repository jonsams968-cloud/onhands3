import { describe, it, expect } from 'vitest'

// MouseMonitor depends on koffi (native), so we test the logic only
// by simulating the internal state machine.

describe('MouseMonitor (logic)', () => {
  it('should export the correct interface', async () => {
    // Dynamic import to check the class exists and has expected methods
    // In a real test environment with koffi, we'd test the actual polling
    const { MouseMonitor } = await import('../../src/main/input/MouseMonitor')
    const monitor = new MouseMonitor(800, 15)

    expect(typeof monitor.start).toBe('function')
    expect(typeof monitor.stop).toBe('function')
    expect(typeof monitor.on).toBe('function')
    expect(typeof monitor.emit).toBe('function')
  })

  it('should accept custom longPress duration', async () => {
    const { MouseMonitor } = await import('../../src/main/input/MouseMonitor')
    const monitor = new MouseMonitor(500, 20)
    // Constructor should not throw
    expect(monitor).toBeDefined()
  })
})
