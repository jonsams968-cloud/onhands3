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
    width: 600,
    height: 200,
    x: Math.round((sw - 600) / 2),
    y: sh - 220,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  win.setIgnoreMouseEvents(true)

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  return win
}

app.whenReady().then(async () => {
  if (process.platform === 'win32') {
    // Force UTF-8 output on Windows terminal
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

  // Keyboard shortcuts for testing
  globalShortcut.register('CommandOrControl+Shift+1', () => {
    mainWindow?.webContents.send('state-changed', 'recording')
    mainWindow?.show()
    mainWindow?.setIgnoreMouseEvents(false)
  })
  globalShortcut.register('CommandOrControl+Shift+6', () => {
    mainWindow?.webContents.send('state-changed', 'result', '测试结果')
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
