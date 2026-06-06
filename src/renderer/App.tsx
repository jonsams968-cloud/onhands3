import { useState, useEffect, useRef, useCallback } from 'react'
import { useVoiceRecorder } from './hooks/useVoiceRecorder'
import type { UIState } from '../shared/types'

declare global {
  interface Window {
    onhands: {
      onStateChanged: (cb: (state: UIState, data?: string) => void) => () => void
      sendRecording: (base64Audio: string) => Promise<void>
      sendRecordingError: (error: string) => Promise<void>
      textCommand: (text: string) => Promise<void>
      abortAction: () => Promise<void>
      setInteractive: (interactive: boolean) => Promise<void>
      hideWindow: () => Promise<void>
    }
  }
}

export default function App() {
  const [state, setState] = useState<UIState>('hidden')
  const [message, setMessage] = useState('')
  const [inputText, setInputText] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useVoiceRecorder(state, {
    onRecordingComplete: (base64) => window.onhands.sendRecording(base64),
    onError: (err) => window.onhands.sendRecordingError(err),
  })

  useEffect(() => {
    return window.onhands.onStateChanged((s, d) => {
      if (hideTimer.current) clearTimeout(hideTimer.current)
      setState(s)
      if (d) setMessage(d)

      if (s === 'result' || s === 'error') {
        hideTimer.current = setTimeout(() => {
          setState('hidden')
          window.onhands.hideWindow()
        }, 12000)
      }
    })
  }, [])

  useEffect(() => {
    if (state === 'input') setTimeout(() => inputRef.current?.focus(), 50)
  }, [state])

  const handleSubmit = useCallback(() => {
    const text = inputText.trim()
    if (!text) return
    setInputText('')
    setState('processing')
    window.onhands.textCommand(text)
  }, [inputText])

  if (state === 'hidden') {
    window.onhands?.setInteractive(false)
    return <div className="w-full h-full" />
  }
  window.onhands?.setInteractive(true)

  return (
    <div className="w-full h-full flex items-end justify-center pb-3">
      <div className="bg-gray-900/90 backdrop-blur-xl rounded-2xl px-5 py-3 shadow-xl border border-white/[0.06] max-w-[500px]">
        {state === 'recording' && (
          <div className="flex items-center gap-3">
            <div className="flex gap-[3px]">
              {[0,1,2,3,4].map(i => (
                <div key={i} className="w-[3px] rounded-full bg-blue-400 animate-pulse"
                  style={{ height: `${6 + Math.random() * 14}px`, animationDelay: `${i * 0.12}s` }} />
              ))}
            </div>
            <span className="text-xs text-gray-400">正在录音...</span>
            <button onClick={() => setState('input')} className="text-xs text-gray-500 border border-gray-700 rounded-lg px-2 py-0.5 ml-2">
              键盘输入
            </button>
          </div>
        )}

        {state === 'input' && (
          <div className="flex items-center gap-2 min-w-[300px]">
            <input ref={inputRef} type="text" value={inputText}
              onChange={e => setInputText(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleSubmit(); if (e.key === 'Escape') setState('hidden') }}
              placeholder="输入指令..." autoFocus
              className="bg-transparent text-sm text-gray-200 placeholder-gray-600 outline-none flex-1" />
            <span className="text-[10px] text-gray-600">Enter 发送</span>
          </div>
        )}

        {state === 'processing' && (
          <div className="flex items-center gap-2.5">
            <div className="w-4 h-4 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
            <span className="text-xs text-gray-400">处理中...</span>
          </div>
        )}

        {state === 'result' && (
          <div className="flex items-start gap-2.5">
            <div className="w-4 h-4 rounded-full border border-blue-400 flex items-center justify-center shrink-0 mt-0.5">
              <div className="w-1 h-1 bg-blue-400 rounded-full" />
            </div>
            <p className="text-xs text-blue-400 leading-relaxed whitespace-pre-wrap">{message}</p>
          </div>
        )}

        {state === 'error' && (
          <div className="flex items-start gap-2.5">
            <div className="text-red-400 text-sm shrink-0 mt-0.5">✕</div>
            <p className="text-xs text-red-400 leading-relaxed">{message}</p>
          </div>
        )}
      </div>
    </div>
  )
}
