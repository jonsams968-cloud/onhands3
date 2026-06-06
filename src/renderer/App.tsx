import { useState, useEffect, useRef, useCallback } from 'react'
import { useVoiceRecorder } from './hooks/useVoiceRecorder'
import type { UIState, PermissionRequest } from '../shared/types'
import './styles.css'

declare global {
  interface Window {
    onhands: {
      onStateChanged: (cb: (state: UIState, data?: string) => void) => () => void
      onStreamChunk: (cb: (chunk: string) => void) => () => void
      onPermissionRequest: (cb: (req: PermissionRequest) => void) => () => void
      sendRecording: (base64Audio: string) => Promise<void>
      sendRecordingError: (error: string) => Promise<void>
      textCommand: (text: string) => Promise<void>
      abortAction: () => Promise<void>
      setInteractive: (interactive: boolean) => Promise<void>
      hideWindow: () => Promise<void>
      answerPermission: (id: string, approved: boolean) => Promise<void>
      resizeWindow: (height: number) => Promise<void>
    }
  }
}

export default function App() {
  const [state, setState] = useState<UIState>('hidden')
  const [message, setMessage] = useState('')
  const [inputText, setInputText] = useState('')
  const [streamLines, setStreamLines] = useState<string[]>([])
  const [routeMode, setRouteMode] = useState<string>('')
  const [permission, setPermission] = useState<PermissionRequest | null>(null)
  const [countdown, setCountdown] = useState(15)
  const [visible, setVisible] = useState(false)
  const [exiting, setExiting] = useState(false)

  const inputRef = useRef<HTMLInputElement>(null)
  const streamRef = useRef<HTMLDivElement>(null)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const stateRef = useRef<UIState>('hidden')
  const prevState = useRef<UIState>('hidden')

  useEffect(() => { stateRef.current = state }, [state])

  useVoiceRecorder(state, {
    onRecordingComplete: (base64) => window.onhands.sendRecording(base64),
    onError: (err) => window.onhands.sendRecordingError(err),
  })

  // ─── State transitions ───

  useEffect(() => {
    return window.onhands.onStateChanged((s, d) => {
      if (hideTimer.current) clearTimeout(hideTimer.current)
      if (countdownRef.current) clearInterval(countdownRef.current)

      prevState.current = stateRef.current
      setMessage(d || '')
      setState(s)

      if (s === 'hidden') {
        setExiting(true)
        setTimeout(() => {
          setVisible(false)
          setExiting(false)
          setStreamLines([])
          setRouteMode('')
          setPermission(null)
          window.onhands.setInteractive(false)
        }, 200)
        return
      }

      setVisible(true)
      setExiting(false)
      window.onhands.setInteractive(true)

      if (s === 'routing' && d) setRouteMode(d)

      if (s === 'result' || s === 'error') {
        hideTimer.current = setTimeout(() => {
          setExiting(true)
          setTimeout(() => {
            setState('hidden')
            setVisible(false)
            setExiting(false)
            window.onhands.hideWindow()
            window.onhands.setInteractive(false)
          }, 200)
        }, 12000)
      }
    })
  }, [])

  // ─── Stream chunks ───

  useEffect(() => {
    return window.onhands.onStreamChunk((chunk) => {
      setStreamLines(prev => [...prev.slice(-80), chunk])
    })
  }, [])

  // ─── Permission requests ───

  useEffect(() => {
    return window.onhands.onPermissionRequest((req) => {
      setPermission(req)
      setState('confirm')
      setCountdown(15)
      countdownRef.current = setInterval(() => {
        setCountdown(prev => {
          if (prev <= 1) {
            if (countdownRef.current) clearInterval(countdownRef.current)
            handlePermissionAnswer(false)
            return 0
          }
          return prev - 1
        })
      }, 1000)
    })
  }, [])

  // ─── Auto-scroll & auto-focus ───

  useEffect(() => {
    if (streamRef.current) streamRef.current.scrollTop = streamRef.current.scrollHeight
  }, [streamLines])

  useEffect(() => {
    if (state === 'input') setTimeout(() => inputRef.current?.focus(), 50)
  }, [state])

  // ─── Handlers ───

  const handlePermissionAnswer = useCallback((approved: boolean) => {
    if (countdownRef.current) clearInterval(countdownRef.current)
    if (permission) window.onhands.answerPermission(permission.id, approved)
    setPermission(null)
  }, [permission])

  const handleSubmit = useCallback(() => {
    const text = inputText.trim()
    if (!text) return
    setInputText('')
    setState('processing')
    window.onhands.textCommand(text)
  }, [inputText])

  const handleAbort = useCallback(() => { window.onhands.abortAction() }, [])

  // ─── Render ───

  if (!visible && !exiting) return <div style={{ width: '100%', height: '100%' }} />

  const capsuleClass = [
    'capsule',
    state === 'recording' && 'capsule--recording',
    state === 'processing' && 'capsule--processing',
    state === 'result' && 'capsule--result',
    state === 'error' && 'capsule--error',
    !exiting && prevState.current === 'hidden' && 'capsule-enter',
    exiting && 'capsule-exit',
  ].filter(Boolean).join(' ')

  return (
    <div className="app-container">
      <div className={capsuleClass}>

        {/* Abort button — top right, visible during active states */}
        {(state === 'processing' || state === 'routing' || state === 'transcribed') && (
          <button onClick={handleAbort} className="abort-btn" title="终止 (双击ESC)">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M2 2L10 10M10 2L2 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
          </button>
        )}

        {/* ── Recording ── */}
        {state === 'recording' && (
          <div className="row row--gap-md">
            <div className="waveform">
              {[0,1,2,3,4].map(i => <div key={i} className="waveform__bar" />)}
            </div>
            <span className="label-muted">正在聆听...</span>
            <button onClick={() => setState('input')} className="input-toggle-btn">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <rect x="1" y="3" width="9" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.2"/>
                <path d="M11 5.5L13 4.5V9.5L11 8.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
          </div>
        )}

        {/* ── Text Input ── */}
        {state === 'input' && (
          <div className="row row--gap-sm">
            <input
              ref={inputRef}
              type="text"
              value={inputText}
              onChange={e => setInputText(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') handleSubmit()
                if (e.key === 'Escape') { setState('hidden'); window.onhands.hideWindow() }
              }}
              placeholder="输入指令..."
              autoFocus
              className="text-input"
            />
            <span className="label-muted">↵ 发送</span>
          </div>
        )}

        {/* ── Transcribed ── */}
        {state === 'transcribed' && message && (
          <div className="row row--gap-md">
            <div className="pulse-dot" />
            <span className="transcribed-text">{message}</span>
          </div>
        )}

        {/* ── Routing ── */}
        {state === 'routing' && (
          <div className="row row--gap-md">
            <div className="spinner" />
            <span className="route-badge" style={{
              background: message === 'agent' ? 'rgba(99,102,241,0.15)' : 'rgba(34,197,94,0.1)',
              color: message === 'agent' ? '#818cf8' : '#4ade80',
              border: `1px solid ${message === 'agent' ? 'rgba(99,102,241,0.2)' : 'rgba(34,197,94,0.15)'}`,
            }}>
              {message === 'agent' ? '🤖 Agent' : '⚡ 快速'}
            </span>
            <span className="label-muted">分析中...</span>
          </div>
        )}

        {/* ── Processing ── */}
        {state === 'processing' && (
          <div>
            <div className="row row--gap-sm row--mb">
              <div className="spinner" />
              <span className="label-muted">{routeMode === 'agent' ? 'Agent 执行中' : '处理中'}...</span>
            </div>
            {streamLines.length > 0 && (
              <div className="stream-area" ref={streamRef}>
                {streamLines.map((line, i) => (
                  <div key={i} className={`stream-line ${getStreamLineClass(line)}`}>
                    {formatStreamLine(line)}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── Permission Confirm ── */}
        {state === 'confirm' && permission && (
          <div className="confirm-panel">
            <div className="row row--gap-sm row--mb">
              <svg className="countdown-ring" viewBox="0 0 20 20">
                <circle className="countdown-ring__bg" cx="10" cy="10" r="8" />
                <circle className="countdown-ring__fg" cx="10" cy="10" r="8"
                  strokeDasharray={`${2 * Math.PI * 8}`}
                  strokeDashoffset={`${2 * Math.PI * 8 * (1 - countdown / 15)}`}
                  transform="rotate(-90 10 10)" />
              </svg>
              <div>
                <div className="permission-title">权限请求 · {permission.tool}</div>
                <div className="permission-desc">{permission.description}</div>
              </div>
            </div>
            {permission.detail && (
              <div className="detail-box">{permission.detail.slice(0, 200)}</div>
            )}
            <div className="confirm-actions">
              <button className="confirm-btn confirm-btn--approve" onClick={() => handlePermissionAnswer(true)}>
                允许本次所有操作
              </button>
              <button className="confirm-btn confirm-btn--deny" onClick={() => handlePermissionAnswer(false)}>
                终止 ({countdown}s)
              </button>
            </div>
          </div>
        )}

        {/* ── Result ── */}
        {state === 'result' && (
          <div className="row row--start row--gap-md">
            <div className="status-icon status-icon--success">
              <svg width="10" height="8" viewBox="0 0 10 8" fill="none">
                <path d="M1 4L3.5 6.5L9 1" stroke="#22c55e" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </div>
            <div className="result-text" dangerouslySetInnerHTML={{ __html: renderMarkdown(message) }} />
          </div>
        )}

        {/* ── Error ── */}
        {state === 'error' && (
          <div className="row row--start row--gap-md">
            <div className="status-icon status-icon--error">
              <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
                <path d="M1 1L7 7M7 1L1 7" stroke="#ef4444" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
            </div>
            <p className="error-text">{message}</p>
          </div>
        )}

      </div>
    </div>
  )
}

function getStreamLineClass(line: string): string {
  if (line.startsWith('[tool]') || line.startsWith('Tool:')) return 'stream-line--tool'
  if (line.startsWith('[text]') || line.startsWith('Text:')) return 'stream-line--text'
  if (line.startsWith('[')) return 'stream-line--system'
  return ''
}

function formatStreamLine(line: string): string {
  return line.replace(/^\[(tool|text|system)\]\s*/, '').replace(/^Tool:\s*/, '🔧 ').replace(/^Text:\s*/, '').slice(0, 120)
}

function renderMarkdown(text: string): string {
  let html = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, _lang, code) => `<pre class="md-code-block"><code>${code.trim()}</code></pre>`)
  html = html.replace(/`([^`\n]+)`/g, '<code class="md-inline-code">$1</code>')
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  html = html.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>')
  html = html.replace(/^### (.+)$/gm, '<h4 class="md-h4">$1</h4>')
  html = html.replace(/^## (.+)$/gm, '<h3 class="md-h3">$1</h3>')
  html = html.replace(/^# (.+)$/gm, '<h2 class="md-h2">$1</h2>')
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a class="md-link" href="$2" target="_blank" rel="noopener">$1</a>')
  html = html.replace(/^[-*] (.+)$/gm, '<li class="md-li">$1</li>')
  html = html.replace(/((?:<li class="md-li">.*<\/li>\n?)+)/g, '<ul class="md-ul">$1</ul>')
  html = html.replace(/\n/g, '<br/>')
  return html
}
