import { app, BrowserWindow, globalShortcut, ipcMain, screen, shell, protocol, net, Tray, Menu, nativeImage } from 'electron'
import path from 'path'
import { MouseMonitor } from './input/MouseMonitor'
import { Orchestrator } from './orchestrator/Orchestrator'
import { loadConfig, saveConfig } from './config'
import { TencentASR } from './stt/TencentASR'
import { UpdateChecker } from './update/UpdateChecker'
import { getStats as getOh3Stats, clearAll as clearOh3All } from './oh3/Oh3Store'

let mainWindow: BrowserWindow | null = null
let settingsWindow: BrowserWindow | null = null
let mouseMonitor: MouseMonitor | null = null
let orchestrator: Orchestrator | null = null
let tray: Tray | null = null
let updateChecker: UpdateChecker | null = null

// Resolve icon paths — works in both dev and packaged mode
function getIconPath(name: string): string {
  // In production, resources are in resources/ (asar-unpacked or extraResources)
  const prodPath = path.join(process.resourcesPath, name)
  if (!process.env.ELECTRON_RENDERER_URL && require('fs').existsSync(prodPath)) {
    return prodPath
  }
  // In dev, use build/ directory
  return path.join(__dirname, '../../build', name)
}

function createWindow(): BrowserWindow {
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize

  const win = new BrowserWindow({
    width: 700,
    height: 400,
    x: Math.round((sw - 700) / 2),
    y: sh - 430,
    transparent: true,
    frame: false,
    thickFrame: false,
    roundedCorners: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    show: false,
    backgroundColor: '#00000000',
    icon: nativeImage.createFromPath(getIconPath('icon.ico')),
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

  win.setIgnoreMouseEvents(true, { forward: true })

  // Workaround for Electron bug #47946 / #39959:
  // Windows DWM redraws white title bar on transparent frameless windows when focus changes.
  // Fixed in Electron 37.3.1 but we're on 35.x.
  // Approach: reset background color on blur/focus to force DWM re-composite without resizing.
  win.setContentProtection(true)
  const resetBg = () => {
    if (!win || win.isDestroyed()) return
    win.setBackgroundColor('#00000000')
  }
  win.on('blur', resetBg)
  win.on('focus', resetBg)

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  return win
}

function buildTrayMenu(): Menu {
  const template: Electron.MenuItemConstructorOptions[] = []

  // Show update notification at the top if available
  const update = updateChecker?.getCachedResult()
  if (update?.hasUpdate) {
    template.push({
      label: `✨ 新版可用: v${update.latestVersion} (当前 v${update.currentVersion})`,
      click: () => {
        if (update.releaseUrl) shell.openExternal(update.releaseUrl)
      },
    })
    template.push({ type: 'separator' })
  }

  template.push({
    label: '设置 / Settings',
    click: () => openSettingsWindow(),
  })
  template.push({
    label: '检查更新 / Check for Updates',
    click: async () => {
      if (!updateChecker) return
      const result = await updateChecker.check()
      if (tray) tray.setContextMenu(buildTrayMenu())
      if (!result) {
        // Show a brief notification in the tray tooltip
        tray?.setToolTip('OnHands3 — 更新检查失败，请检查网络')
        setTimeout(() => tray?.setToolTip('OnHands3'), 4000)
      } else if (result.hasUpdate) {
        tray?.setToolTip(`OnHands3 — 新版 v${result.latestVersion} 可用`)
      } else {
        tray?.setToolTip(`OnHands3 — 已是最新版 v${result.currentVersion}`)
        setTimeout(() => tray?.setToolTip('OnHands3'), 4000)
      }
    },
  })
  template.push({ type: 'separator' })
  template.push({
    label: '退出 / Quit',
    click: () => {
      app.quit()
    },
  })

  return Menu.buildFromTemplate(template)
}

function createTray(): Tray {
  const icon = nativeImage.createFromPath(getIconPath('tray.ico'))
  const t = new Tray(icon)
  t.setToolTip('OnHands3')
  t.setContextMenu(buildTrayMenu())

  // Double-click tray icon to toggle overlay
  t.on('double-click', () => {
    if (!mainWindow) return
    if (mainWindow.isVisible()) {
      mainWindow.hide()
    } else {
      mainWindow.show()
      mainWindow.setIgnoreMouseEvents(false)
      mainWindow.focus()
    }
  })

  return t
}

function openSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus()
    return
  }
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize
  const wW = 720, wH = 520
  settingsWindow = new BrowserWindow({
    width: wW,
    height: wH,
    x: Math.round((sw - wW) / 2),
    y: Math.round((sh - wH) / 2),
    frame: false,
    resizable: false,
    backgroundColor: '#ffffff',
    title: 'OnHands3 Settings',
    icon: nativeImage.createFromPath(getIconPath('icon.ico')),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  if (process.env.ELECTRON_RENDERER_URL) {
    settingsWindow.loadURL(`${process.env.ELECTRON_RENDERER_URL}/settings.html`)
  } else {
    settingsWindow.loadFile(path.join(__dirname, '../renderer/settings.html'))
  }
  settingsWindow.on('closed', () => { settingsWindow = null })
}

// ─── Detect installed Agent CLIs ───
function detectAgents(): { name: string; path: string; installed: boolean }[] {
  const agents = [
    { name: 'Claude Code', cmd: 'claude', env: 'claudeCodePath' },
    { name: 'Codex', cmd: 'codex', env: 'codexPath' },
    { name: 'OpenCode', cmd: 'opencode', env: 'opencodePath' },
  ]
  return agents.map(a => {
    const config = loadConfig()
    const customPath = (config as any)[a.env] as string
    let found = false
    let resolvedPath = ''
    try {
      const { execFileSync } = require('child_process')
      if (customPath) {
        resolvedPath = customPath
        found = true
      } else if (process.platform === 'win32') {
        // Use 'buffer' encoding + fully pipe stdio to prevent GBK mojibake
        // leaking to terminal on Chinese Windows when 'where' fails
        const buf = execFileSync('where', [a.cmd], {
          timeout: 3000,
          encoding: 'buffer',
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        }) as Buffer
        resolvedPath = buf.toString('utf-8').split('\n')[0].trim()
        found = !!resolvedPath
      } else {
        resolvedPath = execFileSync('which', [a.cmd], { encoding: 'utf-8' }).trim()
        found = !!resolvedPath
      }
    } catch {
      found = false
    }
    return { name: a.name, path: resolvedPath || '', installed: found }
  })
}

// ─── Single instance lock — prevent multiple OnHands3 processes ───
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  console.log('[main] Another instance is already running — quitting')
  app.quit()
} else {
  app.on('second-instance', () => {
    // Another instance tried to start — focus our existing window
    console.log('[main] Second instance blocked — focusing existing window')
    if (mainWindow) {
      if (!mainWindow.isVisible()) mainWindow.show()
      mainWindow.setIgnoreMouseEvents(false)
      mainWindow.focus()
    }
  })
}

// Disable Windows DWM frame drawing for truly frameless transparent windows
// NOTE: must be a single comma-separated call — multiple appendSwitch calls with same key overwrite each other
app.commandLine.appendSwitch('disable-features', 'WidgetLayering,CalculateNativeWinOcclusion')

app.whenReady().then(async () => {
  if (process.platform === 'win32') {
    process.stdout.write('\x1b[?65001h')
    try { require('child_process').execSync('chcp 65001', { stdio: 'ignore' }) } catch {}
  }

  const config = loadConfig()
  console.log('[main] OnHands3 starting...')
  console.log(`[main] Config: sttMode=${config.sttMode}, dataDir=${config.dataDir}`)
  console.log(`[main] API configured: ${!!config.aiApiKey}`)

  mainWindow = createWindow()
  console.log('[main] Overlay window created')

  // System tray
  tray = createTray()

  // Update checker — fire-and-forget on startup, refresh tray menu when done
  updateChecker = new UpdateChecker(app.getVersion())
  updateChecker.check().then((result) => {
    if (tray && result?.hasUpdate) {
      tray.setContextMenu(buildTrayMenu())
      console.log(`[main] Update available: v${result.latestVersion}`)
    }
  }).catch(() => { /* silent — network errors don't block startup */ })

  mouseMonitor = new MouseMonitor(config.longPressDuration, config.dragThresholdPx)
  orchestrator = new Orchestrator(mainWindow, mouseMonitor)

  await orchestrator.initialize()
  console.log('[main] Orchestrator initialized')

  // IPC: toggle mouse events — forward:true keeps mousemove events flowing
  ipcMain.handle('window:interactive', (_e, v: boolean) => {
    if (mainWindow) mainWindow.setIgnoreMouseEvents(!v, !v ? { forward: true } : undefined)
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

  // IPC: open file in folder
  ipcMain.handle('media:openInFolder', (_e, filePath: string) => {
    shell.openPath(path.dirname(filePath))
  })

  // IPC: regenerate media
  ipcMain.handle('media:regenerate', () => {
    orchestrator?.regenerateMedia()
  })

  // IPC: save media from temp to target directory
  ipcMain.handle('media:save', (_e, sourcePath: string, targetDir: string) => {
    if (!orchestrator) return null
    return orchestrator.saveMedia(sourcePath, targetDir)
  })

  // Register onhands-media:// protocol for serving local media files to renderer
  protocol.handle('onhands-media', (request) => {
    const filePath = decodeURIComponent(request.url.replace('onhands-media://', ''))
    return net.fetch(`file:///${filePath.replace(/\\/g, '/')}`)
  })

  // ─── Settings IPC ───

  ipcMain.handle('settings:load', () => {
    return loadConfig()
  })

  ipcMain.handle('settings:save', (_e, data: Record<string, any>) => {
    const updated = saveConfig(data)
    // Update mouse monitor settings in-place (don't recreate — orchestrator
    // event listeners are bound to the original instance)
    if (mouseMonitor && (data.longPressDuration !== undefined || data.dragThresholdPx !== undefined)) {
      mouseMonitor.updateSettings(updated.longPressDuration, updated.dragThresholdPx)
    }
    return updated
  })

  ipcMain.handle('settings:detectAgents', () => {
    return detectAgents()
  })

  ipcMain.handle('settings:openSettings', () => {
    openSettingsWindow()
  })

  ipcMain.handle('settings:closeWindow', () => {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.close()
    }
  })

  // IPC: app version (reads from package.json — stays in sync automatically)
  ipcMain.handle('app:version', () => {
    return app.getVersion()
  })

  // IPC: check for updates on demand (also returns cached result)
  ipcMain.handle('update:check', async () => {
    if (!updateChecker) return null
    const result = await updateChecker.check()
    if (tray) tray.setContextMenu(buildTrayMenu())
    return result
  })

  // IPC: get cached update status without re-checking
  ipcMain.handle('update:status', () => {
    return updateChecker?.getCachedResult() || null
  })

  // IPC: test Tencent ASR connection with given credentials
  ipcMain.handle('stt:testTencent', async (_e, creds: { secretId: string; secretKey: string; appId: string }) => {
    try {
      const asr = new TencentASR({
        ...loadConfig(),
        tencentSecretId: creds.secretId,
        tencentSecretKey: creds.secretKey,
        tencentAppId: creds.appId,
      } as any)
      return await asr.testConnection()
    } catch (err: any) {
      return { success: false, message: err?.message || '测试失败' }
    }
  })

  // IPC: get .oh3/ memory stats (size, entry count per directory)
  ipcMain.handle('oh3:stats', () => {
    try {
      return { success: true, stats: getOh3Stats() }
    } catch (err: any) {
      return { success: false, error: err?.message || 'Failed to get stats' }
    }
  })

  // IPC: clear all .oh3/ memory data (irreversible — UI must confirm twice)
  ipcMain.handle('oh3:clearAll', () => {
    try {
      const deletedCount = clearOh3All()
      return { success: true, deletedCount }
    } catch (err: any) {
      return { success: false, error: err?.message || 'Failed to clear' }
    }
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

  // Settings window: Ctrl+Shift+S
  globalShortcut.register('CommandOrControl+Shift+S', () => {
    openSettingsWindow()
  })

  // Force kill: Ctrl+Shift+Escape (always available, even when overlay is hidden)
  globalShortcut.register('CommandOrControl+Shift+Escape', () => {
    console.log('[main] Force kill — Ctrl+Shift+Escape pressed')
    process.exit(0)
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
  if (tray) { tray.destroy(); tray = null }
  if (orchestrator) orchestrator.destroy()
  if (mouseMonitor) await mouseMonitor.stop()
})
