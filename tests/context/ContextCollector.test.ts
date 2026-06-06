import { describe, it, expect, vi } from 'vitest'

// Mock electron before importing ContextCollector
vi.mock('electron', () => ({
  screen: { getPrimaryDisplay: () => ({ size: { width: 1920, height: 1080 }, scaleFactor: 1 }) },
  desktopCapturer: { getSources: vi.fn() },
}))

describe('ContextCollector', () => {
  it('should format context for prompt', async () => {
    const { ContextCollector } = await import('../../src/main/context/ContextCollector')
    const collector = new ContextCollector()

    const result = collector.formatForPrompt({
      activeWindow: { title: 'Sales.xlsx - Excel', processName: 'EXCEL', pid: 1234 },
      clipboard: '100\n200\n300',
      workingDirectory: 'C:\\Users\\test',
    })

    expect(result).toContain('EXCEL')
    expect(result).toContain('Sales.xlsx')
    expect(result).toContain('100')
    expect(result).toContain('C:\\Users\\test')
  })

  it('should handle missing context gracefully', async () => {
    const { ContextCollector } = await import('../../src/main/context/ContextCollector')
    const collector = new ContextCollector()

    const result = collector.formatForPrompt({
      activeWindow: null,
      clipboard: null,
      workingDirectory: 'C:\\Users\\test',
    })

    expect(result).toContain('C:\\Users\\test')
    expect(result).not.toContain('Active window')
    expect(result).not.toContain('Clipboard')
  })

  it('should truncate long clipboard content', async () => {
    const { ContextCollector } = await import('../../src/main/context/ContextCollector')
    const collector = new ContextCollector()

    const longText = 'x'.repeat(3000)
    const result = collector.formatForPrompt({
      activeWindow: null,
      clipboard: longText,
      workingDirectory: 'C:\\test',
    })

    expect(result).toContain('[truncated]')
    expect(result.length).toBeLessThan(3000 + 200)
  })

  describe('collect without captureActiveWindow', () => {
    it('should fallback to process.cwd() when no window captured', async () => {
      const { ContextCollector } = await import('../../src/main/context/ContextCollector')
      const collector = new ContextCollector()

      // No window captured via captureActiveWindow
      collector.setCapturedWindow(null)

      const context = await collector.collect(0, 0)
      expect(context.activeWindow).toBeNull()
      expect(context.workingDirectory).toBe(process.cwd())
    })

    it('should return captured window in collect result', async () => {
      const { ContextCollector } = await import('../../src/main/context/ContextCollector')
      const collector = new ContextCollector()

      // Simulate setting captured window (without captureActiveWindow)
      const explorerWindow = {
        processName: 'explorer',
        title: 'D:\\Agent Flie',
        pid: 5678,
      }
      collector.setCapturedWindow(explorerWindow)

      const context = await collector.collect(0, 0)
      expect(context.activeWindow).toEqual(explorerWindow)
      // Without captureActiveWindow, capturedWorkingDir is null → falls back to cwd
      expect(context.workingDirectory).toBe(process.cwd())
    })
  })

  describe('parseExplorerTitle', () => {
    // Test the title parsing via the public formatForPrompt method
    // which uses the workingDirectory from DesktopContext
    it('should produce correct prompt with drive path in Explorer title', async () => {
      const { ContextCollector } = await import('../../src/main/context/ContextCollector')
      const collector = new ContextCollector()

      const ctx = {
        activeWindow: { processName: 'explorer', title: 'D:\\Agent Flie', pid: 100 },
        clipboard: null,
        workingDirectory: 'D:\\Agent Flie',
      }

      const prompt = collector.formatForPrompt(ctx)
      expect(prompt).toContain('explorer')
      expect(prompt).toContain('D:\\Agent Flie')
      expect(prompt).toContain('Working directory: D:\\Agent Flie')
    })

    it('should produce correct prompt with Chinese Explorer title', async () => {
      const { ContextCollector } = await import('../../src/main/context/ContextCollector')
      const collector = new ContextCollector()

      const ctx = {
        activeWindow: { processName: 'explorer', title: '新建文件夹 - 资源管理器', pid: 100 },
        clipboard: null,
        workingDirectory: 'C:\\Users\\Decory\\Desktop\\新建文件夹',
      }

      const prompt = collector.formatForPrompt(ctx)
      expect(prompt).toContain('explorer')
      expect(prompt).toContain('新建文件夹')
      expect(prompt).toContain('C:\\Users\\Decory\\Desktop\\新建文件夹')
    })
  })
})
