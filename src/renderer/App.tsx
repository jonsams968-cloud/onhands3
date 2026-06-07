import { useState, useEffect, useRef, useCallback } from 'react'
import { useVoiceRecorder } from './hooks/useVoiceRecorder'
import type { UIState, PermissionRequest } from '../shared/types'
import './styles.css'

declare global {
  interface Window {
    onhands: {
      onStateChanged: (cb: (state: UIState, data?: string) => void) => () => void
      onCommandText: (cb: (text: string) => void) => () => void
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
      openInFolder: (filePath: string) => Promise<void>
      regenerateMedia: () => Promise<void>
      saveMedia: (sourcePath: string, targetDir: string) => Promise<string | null>
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
  const [commandText, setCommandText] = useState('')
  const [previewData, setPreviewData] = useState<{ type: string; path: string; url: string; saveDir: string } | null>(null)
  const [savedPath, setSavedPath] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

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
          setCommandText('')
          setPreviewData(null)
          setSavedPath(null)
          window.onhands.setInteractive(false)
        }, 200)
        return
      }

      setVisible(true)
      setExiting(false)
      window.onhands.setInteractive(true)

      if (s === 'routing' && d) setRouteMode(d)

      if (s === 'preview' && d) {
        try {
          const data = JSON.parse(d)
          setPreviewData(data)
          setSavedPath(null)
          window.onhands.resizeWindow(380)
        } catch {}
        // Safety auto-hide after 60s
        hideTimer.current = setTimeout(() => {
          setExiting(true)
          setTimeout(() => {
            setState('hidden')
            setVisible(false)
            setExiting(false)
            setPreviewData(null)
            window.onhands.hideWindow()
            window.onhands.setInteractive(false)
          }, 200)
        }, 60000)
        return
      }

      // Resize back to default for non-preview states
      if (prevState.current === 'preview') {
        window.onhands.resizeWindow(400)
      }

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

  // ─── Command text (persistent across pipeline states) ───

  useEffect(() => {
    return window.onhands.onCommandText((text) => {
      if (text) setCommandText(text)
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

  // ─── ESC to close preview ───

  useEffect(() => {
    if (state !== 'preview') return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setExiting(true)
        setTimeout(() => {
          setState('hidden')
          setPreviewData(null)
          setSavedPath(null)
          window.onhands.hideWindow()
        }, 200)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [state])

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
    state === 'preview' && 'capsule--result',
    !exiting && prevState.current === 'hidden' && 'capsule-enter',
    exiting && 'capsule-exit',
  ].filter(Boolean).join(' ')

  return (
    <div className="app-container">
      <div className={capsuleClass}>

        {/* Abort button — top right, visible during active states */}
        {(state === 'processing' || state === 'routing' || state === 'transcribed') && (
          <button onClick={handleAbort} className="abort-btn" title="终止">
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
          <div>
            {commandText && <div className="command-header">{commandText}</div>}
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
          </div>
        )}

        {/* ── Processing ── */}
        {state === 'processing' && (
          <div>
            {commandText && <div className="command-header">{commandText}</div>}
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
          <div>
            {commandText && <div className="command-header command-header--done">{commandText}</div>}
            <div className="row row--start row--gap-md">
            <div className="status-icon status-icon--success">
              <svg width="10" height="8" viewBox="0 0 10 8" fill="none">
                <path d="M1 4L3.5 6.5L9 1" stroke="#22c55e" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </div>
            <div className="result-text" dangerouslySetInnerHTML={{ __html: renderMarkdown(message) }} />
            </div>
          </div>
        )}

        {/* ── Error ── */}
        {state === 'error' && (
          <div>
            {commandText && <div className="command-header command-header--error">{commandText}</div>}
            <div className="row row--start row--gap-md">
            <div className="status-icon status-icon--error">
              <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
                <path d="M1 1L7 7M7 1L1 7" stroke="#ef4444" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
            </div>
            <p className="error-text">{message}</p>
            </div>
          </div>
        )}

        {/* ── Media Preview ── */}
        {state === 'preview' && previewData && (
          <div className="preview-panel">
            <div className="preview-media">
              {previewData.type === 'image' ? (
                <img src={previewData.url} alt="Generated" className="preview-img" />
              ) : (
                <video src={previewData.url} className="preview-video" controls autoPlay loop />
              )}
            </div>
            <div className="preview-actions">
              {!savedPath ? (
                <button
                  className="preview-btn preview-btn--accent"
                  disabled={saving}
                  onClick={async () => {
                    setSaving(true)
                    try {
                      const result = await window.onhands.saveMedia(previewData.path, previewData.saveDir)
                      if (result) setSavedPath(result)
                    } finally {
                      setSaving(false)
                    }
                  }}
                  title={`保存到 ${previewData.saveDir}`}
                >
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                    <path d="M7 2v7M4 6l3 3 3-3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
                    <path d="M2 10v1.5a.5.5 0 00.5.5h9a.5.5 0 00.5-.5V10" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
                  </svg>
                  <span>{saving ? '保存中...' : `保存到 ${previewData.saveDir.split(/[\\/]/).pop()}`}</span>
                </button>
              ) : (
                <>
                  <span className="preview-saved-badge">✓ 已保存</span>
                  <button className="preview-btn" onClick={() => window.onhands.openInFolder(savedPath)} title="打开文件夹">
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                      <path d="M2 4h4l1 1h5v6H2V4z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/>
                    </svg>
                    <span>打开文件夹</span>
                  </button>
                </>
              )}
              <button className="preview-btn preview-btn--accent" onClick={() => {
                setSavedPath(null)
                setPreviewData(null)
                setState('processing')
                window.onhands.regenerateMedia()
              }} title="重新生成">
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <path d="M11 7a4 4 0 11-2.4-3.67" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
                  <path d="M11 2v2.5h-2.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
                <span>重新生成</span>
              </button>
              <button className="preview-btn preview-btn--close" onClick={() => {
                setExiting(true)
                setTimeout(() => {
                  setState('hidden')
                  setPreviewData(null)
                  setSavedPath(null)
                  window.onhands.hideWindow()
                }, 200)
              }} title="关闭">
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                  <path d="M2 2L10 10M10 2L2 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                </svg>
              </button>
            </div>
            {savedPath && (
              <div className="preview-path" title={savedPath}>
                📁 {savedPath}
              </div>
            )}
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
  // Code blocks (must come before inline code)
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, _lang, code) => `<pre class="md-code-block"><code>${code.trim()}</code></pre>`)
  html = html.replace(/`([^`\n]+)`/g, '<code class="md-inline-code">$1</code>')
  // Bold & italic
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  html = html.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>')
  // Headers
  html = html.replace(/^### (.+)$/gm, '<h4 class="md-h4">$1</h4>')
  html = html.replace(/^## (.+)$/gm, '<h3 class="md-h3">$1</h3>')
  html = html.replace(/^# (.+)$/gm, '<h2 class="md-h2">$1</h2>')
  // Links
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a class="md-link" href="$2" target="_blank" rel="noopener">$1</a>')
  // Tables: | header | header | \n |---|---| \n | cell | cell |
  html = html.replace(/((?:^\|.+\|[ ]*\n)+)/gm, (block) => {
    const lines = block.trim().split('\n')
    const rows: string[] = []
    for (const line of lines) {
      // Skip separator line (|---|---|)
      if (/^\|[\s\-:]+\|/.test(line)) continue
      const cells = line.split('|').slice(1, -1).map(c => c.trim())
      if (cells.length === 0) continue
      const tag = rows.length === 0 ? 'th' : 'td'
      const cellHtml = cells.map(c => `<${tag} class="md-${tag}">${c}</${tag}>`).join('')
      rows.push(`<tr class="md-tr">${cellHtml}</tr>`)
    }
    if (rows.length === 0) return block
    return `<table class="md-table"><tbody class="md-tbody">${rows.join('')}</tbody></table>`
  })
  // Lists
  html = html.replace(/^[-*] (.+)$/gm, '<li class="md-li">$1</li>')
  html = html.replace(/((?:<li class="md-li">.*<\/li>\n?)+)/g, '<ul class="md-ul">$1</ul>')
  // Line breaks
  html = html.replace(/\n/g, '<br/>')
  return html
}
