import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('onhands', {
  onStateChanged: (cb: (state: string, data?: string) => void) => {
    const handler = (_e: any, state: string, data?: string) => cb(state as any, data)
    ipcRenderer.on('state-changed', handler)
    return () => ipcRenderer.removeListener('state-changed', handler)
  },
  onCommandText: (cb: (text: string) => void) => {
    const handler = (_e: any, text: string) => cb(text)
    ipcRenderer.on('command-text', handler)
    return () => ipcRenderer.removeListener('command-text', handler)
  },
  onStreamChunk: (cb: (chunk: string) => void) => {
    const handler = (_e: any, chunk: string) => cb(chunk)
    ipcRenderer.on('stream-chunk', handler)
    return () => ipcRenderer.removeListener('stream-chunk', handler)
  },
  onPermissionRequest: (cb: (req: any) => void) => {
    const handler = (_e: any, req: any) => cb(req)
    ipcRenderer.on('permission-request', handler)
    return () => ipcRenderer.removeListener('permission-request', handler)
  },
  onAskRequest: (cb: (req: any) => void) => {
    const handler = (_e: any, req: any) => cb(req)
    ipcRenderer.on('ask-request', handler)
    return () => ipcRenderer.removeListener('ask-request', handler)
  },
  sendRecording: (base64: string) => ipcRenderer.invoke('voice:recording', base64),
  sendRecordingError: (error: string) => ipcRenderer.invoke('voice:error', error),
  textCommand: (text: string) => ipcRenderer.invoke('text:command', text),
  abortAction: () => ipcRenderer.invoke('action:abort'),
  setInteractive: (v: boolean) => ipcRenderer.invoke('window:interactive', v),
  hideWindow: () => ipcRenderer.invoke('window:hide'),
  answerPermission: (id: string, approved: boolean) => ipcRenderer.invoke('permission:answer', id, approved),
  answerAsk: (optionLabel: string) => ipcRenderer.invoke('ask:answer', optionLabel),
  resizeWindow: (height: number) => ipcRenderer.invoke('window:resize', height),
  openInFolder: (filePath: string) => ipcRenderer.invoke('media:openInFolder', filePath),
  regenerateMedia: () => ipcRenderer.invoke('media:regenerate'),
  saveMedia: (sourcePath: string, targetDir: string) => ipcRenderer.invoke('media:save', sourcePath, targetDir),

  // Queue IPC
  onQueueUpdate: (cb: (items: { id: number; command: string }[]) => void) => {
    const handler = (_e: any, items: any) => cb(items)
    ipcRenderer.on('queue-update', handler)
    return () => ipcRenderer.removeListener('queue-update', handler)
  },
  cancelQueueTask: (id: number) => ipcRenderer.invoke('queue:cancel', id),
  onRecordingQueue: (cb: (active: boolean) => void) => {
    const handler = (_e: any, active: boolean) => cb(active)
    ipcRenderer.on('recording-queue', handler)
    return () => ipcRenderer.removeListener('recording-queue', handler)
  },

  // Settings IPC
  settingsLoad: () => ipcRenderer.invoke('settings:load'),
  settingsSave: (data: Record<string, any>) => ipcRenderer.invoke('settings:save', data),
  settingsDetectAgents: () => ipcRenderer.invoke('settings:detectAgents'),
  settingsCloseWindow: () => ipcRenderer.invoke('settings:closeWindow'),

  // App version (reads from package.json via app.getVersion())
  getVersion: () => ipcRenderer.invoke('app:version'),
})
