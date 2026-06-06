import { app, BrowserWindow, globalShortcut, ipcMain, screen } from 'electron'
import path from 'path'
import { MouseMonitor } from './input/MouseMonitor'
import { Orchestrator } from './orchestrator/Orchestrator'
import { loadConfig } from './config'

let mainWindow: BrowserWindow | null = null
let mouseMonitor: MouseMonitor | null = null
let orchestrator: Orchestrator | null = null

function createWindow(): BrowserWindow {
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize

  const win = new BrowserWindow({
    width: 700,
    height: 400,
    x: Math.round((sw - 700) / 2),
    y: sh - 430,
    transparent: true,
    frame: false,
    roundedCorners: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  // Prevent Windows from adding any system chrome to frameless transparent window
  win.setMenuBarVisibility(false)

  // Highest z-order level — always on top of everything including fullscreen apps
  win.setAlwaysOnTop(true, 'screen-saver')

  win.setIgnoreMouseEvents(true)

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  return win
}

// Disable Windows DWM frame drawing for truly frameless transparent windows
app.commandLine.appendSwitch('disable-features', 'WidgetLayering')
// Prevent Windows from adding any visual chrome/border to the window
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')

app.whenReady().then(async () => {
  if (process.platform === 'win32') {
    process.stdout.write('\x1b[?65001h')
    try { require('child_process').execSync('chcp 65001', { stdio: 'ignore' }) } catch {}
  }

  const config = loadConfig()
  console.log('[main] OnHands3 starting...')

  mainWindow = createWindow()

  mouseMonitor = new MouseMonitor(config.longPressDuration, config.dragThresholdPx)
  orchestrator = new Orchestrator(mainWindow, mouseMonitor)

  await orchestrator.initialize()

  // IPC: toggle mouse events
  ipcMain.handle('window:interactive', (_e, v: boolean) => {
    if (mainWindow) mainWindow.setIgnoreMouseEvents(!v)
  })

  // IPC: hide window from renderer auto-hide timer
  ipcMain.handle('window:hide', () => {
    if (mainWindow) {
      mainWindow.setIgnoreMouseEvents(true)
      mainWindow.hide()
    }
  })

  // IPC: resize window height dynamically
  ipcMain.handle('window:resize', (_e, height: number) => {
    if (mainWindow) {
      const [w] = mainWindow.getSize()
      mainWindow.setSize(w, Math.max(120, Math.min(500, height)))
    }
  })

  // IPC: permission answer from renderer
  ipcMain.handle('permission:answer', (_e, id: string, approved: boolean) => {
    orchestrator?.handlePermissionAnswer(id, approved)
  })

  // Keyboard shortcuts for testing
  globalShortcut.register('CommandOrControl+Shift+1', () => {
    mainWindow?.webContents.send('state-changed', 'recording')
    mainWindow?.show()
    mainWindow?.setIgnoreMouseEvents(false)
  })
  globalShortcut.register('CommandOrControl+Shift+2', () => {
    mainWindow?.webContents.send('state-changed', 'transcribed', '这是一段测试语音识别结果')
    mainWindow?.show()
    mainWindow?.setIgnoreMouseEvents(false)
  })
  globalShortcut.register('CommandOrControl+Shift+3', () => {
    mainWindow?.webContents.send('state-changed', 'routing', 'agent')
    mainWindow?.show()
    mainWindow?.setIgnoreMouseEvents(false)
  })
  globalShortcut.register('CommandOrControl+Shift+4', () => {
    mainWindow?.webContents.send('state-changed', 'processing')
    mainWindow?.show()
    mainWindow?.setIgnoreMouseEvents(false)
    // Simulate stream chunks
    const lines = ['[system] 正在分析...', '[tool] Bash: ls -la', '[text] 找到3个文件', '[tool] Bash: mv old.txt new.txt']
    lines.forEach((line, i) => {
      setTimeout(() => mainWindow?.webContents.send('stream-chunk', line), (i + 1) * 800)
    })
  })
  globalShortcut.register('CommandOrControl+Shift+6', () => {
    mainWindow?.webContents.send('state-changed', 'result', '已将文件重命名为 2026-06-06')
    mainWindow?.show()
    mainWindow?.setIgnoreMouseEvents(false)
  })
  globalShortcut.register('CommandOrControl+Shift+7', () => {
    mainWindow?.webContents.send('state-changed', 'error', '无法连接到 Agent CLI')
    mainWindow?.show()
    mainWindow?.setIgnoreMouseEvents(false)
  })
  globalShortcut.register('CommandOrControl+Shift+0', () => {
    mainWindow?.webContents.send('state-changed', 'hidden')
    mainWindow?.setIgnoreMouseEvents(true)
    mainWindow?.hide()
  })

  try {
    await mouseMonitor.start()
    console.log('[main] Mouse monitor active')
  } catch (err) {
    console.warn(`[main] Mouse monitor failed: ${err}`)
  }
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })

app.on('before-quit', async () => {
  globalShortcut.unregisterAll()
  if (mouseMonitor) await mouseMonitor.stop()
})
