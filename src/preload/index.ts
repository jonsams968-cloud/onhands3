import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('onhands', {
  onStateChanged: (cb: (state: string, data?: string) => void) => {
    const handler = (_e: any, state: string, data?: string) => cb(state as any, data)
    ipcRenderer.on('state-changed', handler)
    return () => ipcRenderer.removeListener('state-changed', handler)
  },
  sendRecording: (base64: string) => ipcRenderer.invoke('voice:recording', base64),
  sendRecordingError: (error: string) => ipcRenderer.invoke('voice:error', error),
  textCommand: (text: string) => ipcRenderer.invoke('text:command', text),
  abortAction: () => ipcRenderer.invoke('action:abort'),
  setInteractive: (v: boolean) => ipcRenderer.invoke('window:interactive', v),
  hideWindow: () => ipcRenderer.invoke('window:hide'),
})
