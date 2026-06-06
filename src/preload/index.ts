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
  sendRecording: (base64: string) => ipcRenderer.invoke('voice:recording', base64),
  sendRecordingError: (error: string) => ipcRenderer.invoke('voice:error', error),
  textCommand: (text: string) => ipcRenderer.invoke('text:command', text),
  abortAction: () => ipcRenderer.invoke('action:abort'),
  setInteractive: (v: boolean) => ipcRenderer.invoke('window:interactive', v),
  hideWindow: () => ipcRenderer.invoke('window:hide'),
  answerPermission: (id: string, approved: boolean) => ipcRenderer.invoke('permission:answer', id, approved),
  resizeWindow: (height: number) => ipcRenderer.invoke('window:resize', height),
})
