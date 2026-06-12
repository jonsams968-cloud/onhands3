import { useState, useEffect, createContext, useContext } from 'react'
import { createRoot } from 'react-dom/client'
import './settings.css'

// ─── Types ───

interface Config {
  aiApiKey: string
  aiBaseUrl: string
  aiModel: string
  aiMaxTokens: number
  claudeCodePath: string
  codexPath: string
  opencodePath: string
  sttMode: 'local' | 'cloud' | 'tencent'
  whisperModel: string
  tencentSecretId: string
  tencentSecretKey: string
  tencentAppId: string
  longPressDuration: number
  dragThresholdPx: number
  defaultPermissionAction: 'ask' | 'allow' | 'deny'
  language: 'zh' | 'en'
}

interface AgentInfo {
  name: string
  path: string
  installed: boolean
}

// ─── IPC Helper ───

const api = (window as any).onhands as {
  settingsLoad: () => Promise<Config>
  settingsSave: (data: Partial<Config>) => Promise<Config>
  settingsDetectAgents: () => Promise<AgentInfo[]>
  settingsCloseWindow: () => Promise<void>
} | undefined

// ─── i18n ───

type Lang = 'zh' | 'en'

const t = {
  zh: {
    settings: '设置',
    aiConfig: 'AI 配置',
    speech: '语音识别',
    interaction: '交互行为',
    about: '关于',
    aiTitle: 'AI 配置',
    aiDesc: '配置 Direct AI 快速模式的 API 参数',
    apiKey: 'API Key',
    apiBase: 'API Base URL',
    model: '模型',
    modelHint: '支持 OpenAI 兼容的模型名称',
    maxTokens: '最大 Tokens',
    maxTokensHint: '单次回复最大 token 数',
    agentPath: 'Agent CLI 路径',
    agentPathDesc: '自动检测已安装的 Agent CLI，也可手动指定路径',
    detected: '已检测',
    notDetected: '未检测',
    notInstalled: '未安装',
    sttTitle: '语音识别',
    sttDesc: '选择语音转文字引擎',
    sttEngine: 'STT 引擎',
    tencent: '腾讯云 ASR',
    tencentDesc: '实时流式识别，速度快，需联网',
    localWhisper: '本地 Whisper',
    localDesc: 'whisper.cpp 离线推理，隐私性好',
    cloudWhisper: '云端 Whisper',
    cloudDesc: 'OpenAI Whisper API，需 API Key',
    tencentConfig: '腾讯云配置',
    tencentConfigDesc: '实时语音识别 WebSocket API',
    secretId: 'Secret ID',
    secretKey: 'Secret Key',
    appId: 'App ID',
    testConnection: '测试连接',
    localConfig: '本地 Whisper 配置',
    localConfigDesc: '模型文件需手动下载到 data/whisper/',
    modelSize: '模型大小',
    modelPath: '模型路径',
    cloudConfig: 'OpenAI Whisper API',
    cloudConfigDesc: '使用 OpenAI 兼容的 Whisper API 端点',
    apiKeyIndependent: '与上方 AI 配置的 API Key 独立',
    interactionTitle: '交互行为',
    interactionDesc: '调整触发方式和操作偏好',
    longPressDuration: '长按触发时长',
    longPressHint: '按住鼠标多久后开始录音',
    dragThreshold: '拖拽阈值',
    dragThresholdHint: '超过此像素移动则取消长按 (px)',
    routingPermissions: '路由与权限',
    forceAgent: '强制 Agent 模式',
    forceAgentDesc: '所有请求都走 Agent CLI，不使用 Direct AI 快速模式',
    permissionBehavior: '默认权限行为',
    askEveryTime: '每次询问 (推荐)',
    autoAllow: '自动允许',
    autoDeny: '自动拒绝',
    memorySystem: '目录记忆系统',
    memorySystemDesc: '每个目录独立积累 AI 操作上下文',
    enableOh3: '启用 .oh3/ 记忆系统',
    enableOh3Desc: '自动创建隐藏目录记录操作日志、备份高危文件',
    retentionPeriod: '保留期限',
    days: '天',
    backupLimit: '备份空间上限',
    backupLimitHint: '单个目录备份数据最大 MB',
    comingSoon: '即将推出',
    systemInfo: '系统信息',
    links: '链接',
    docs: '文档',
    feedback: '反馈',
    saveChanges: '保存更改',
    saved: '已保存',
  },
  en: {
    settings: 'Settings',
    aiConfig: 'AI Config',
    speech: 'Speech',
    interaction: 'Interaction',
    about: 'About',
    aiTitle: 'AI Configuration',
    aiDesc: 'Configure Direct AI quick mode API parameters',
    apiKey: 'API Key',
    apiBase: 'API Base URL',
    model: 'Model',
    modelHint: 'Supports OpenAI-compatible model names',
    maxTokens: 'Max Tokens',
    maxTokensHint: 'Maximum tokens per response',
    agentPath: 'Agent CLI Path',
    agentPathDesc: 'Auto-detect installed Agent CLIs, or specify manually',
    detected: 'Detected',
    notDetected: 'Not detected',
    notInstalled: 'Not installed',
    sttTitle: 'Speech Recognition',
    sttDesc: 'Select speech-to-text engine',
    sttEngine: 'STT Engine',
    tencent: 'Tencent ASR',
    tencentDesc: 'Real-time streaming, fast, requires network',
    localWhisper: 'Local Whisper',
    localDesc: 'whisper.cpp offline inference, privacy-friendly',
    cloudWhisper: 'Cloud Whisper',
    cloudDesc: 'OpenAI Whisper API, requires API Key',
    tencentConfig: 'Tencent Cloud Config',
    tencentConfigDesc: 'Real-time speech recognition WebSocket API',
    secretId: 'Secret ID',
    secretKey: 'Secret Key',
    appId: 'App ID',
    testConnection: 'Test Connection',
    localConfig: 'Local Whisper Config',
    localConfigDesc: 'Download model files to data/whisper/',
    modelSize: 'Model Size',
    modelPath: 'Model Path',
    cloudConfig: 'OpenAI Whisper API',
    cloudConfigDesc: 'Use OpenAI-compatible Whisper API endpoint',
    apiKeyIndependent: 'Independent from the AI config API Key above',
    interactionTitle: 'Interaction',
    interactionDesc: 'Adjust trigger method and operation preferences',
    longPressDuration: 'Long Press Duration',
    longPressHint: 'How long to hold before recording starts',
    dragThreshold: 'Drag Threshold',
    dragThresholdHint: 'Cancel long press if mouse moves beyond this (px)',
    routingPermissions: 'Routing & Permissions',
    forceAgent: 'Force Agent Mode',
    forceAgentDesc: 'Route all requests through Agent CLI, skip Direct AI quick mode',
    permissionBehavior: 'Default Permission Behavior',
    askEveryTime: 'Ask every time (Recommended)',
    autoAllow: 'Auto allow',
    autoDeny: 'Auto deny',
    memorySystem: 'Directory Memory',
    memorySystemDesc: 'Each directory independently accumulates AI operation context',
    enableOh3: 'Enable .oh3/ Memory System',
    enableOh3Desc: 'Auto-create hidden directory for operation logs and risky file backups',
    retentionPeriod: 'Retention Period',
    days: 'days',
    backupLimit: 'Backup Size Limit',
    backupLimitHint: 'Maximum backup size per directory (MB)',
    comingSoon: 'Coming Soon',
    systemInfo: 'System Info',
    links: 'Links',
    docs: 'Docs',
    feedback: 'Feedback',
    saveChanges: 'Save Changes',
    saved: 'Saved',
  },
} as const

const LangCtx = createContext<{ lang: Lang; setLang: (l: Lang) => void }>({ lang: 'zh', setLang: () => {} })
const useT = () => t[useContext(LangCtx).lang]

// ─── Reusable Components ───

function SettingInput({ label, value, type = 'text', placeholder, hint, onChange }: {
  label: string; value: string; type?: 'text' | 'password' | 'number'
  placeholder?: string; hint?: string; onChange?: (v: string) => void
}) {
  const [showPassword, setShowPassword] = useState(false)
  return (
    <div className="setting-field">
      <label className="setting-label">{label}</label>
      <div className="setting-input-wrap">
        <input
          className="setting-input"
          type={type === 'password' && showPassword ? 'text' : type}
          value={value}
          placeholder={placeholder}
          onChange={onChange ? (e) => onChange(e.target.value) : undefined}
        />
        {type === 'password' && (
          <button className="setting-input-toggle" onClick={() => setShowPassword(!showPassword)}>
            {showPassword ? (
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path d="M8 4C4.5 4 2 8 2 8s2.5 4 6 4 6-4 6-4-2.5-4-6-4z" stroke="currentColor" strokeWidth="1.2"/>
                <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.2"/>
                <path d="M3 3l10 10" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path d="M8 4C4.5 4 2 8 2 8s2.5 4 6 4 6-4 6-4-2.5-4-6-4z" stroke="currentColor" strokeWidth="1.2"/>
                <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.2"/>
              </svg>
            )}
          </button>
        )}
      </div>
      {hint && <span className="setting-hint">{hint}</span>}
    </div>
  )
}

function SettingSelect({ label, value, options, onChange }: {
  label: string; value: string; options: { value: string; label: string }[]; onChange?: (v: string) => void
}) {
  return (
    <div className="setting-field">
      <label className="setting-label">{label}</label>
      <select className="setting-select" value={value} onChange={onChange ? (e) => onChange(e.target.value) : undefined}>
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  )
}

function SettingToggle({ label, description, checked, onChange, disabled }: {
  label: string; description?: string; checked: boolean; onChange?: (v: boolean) => void; disabled?: boolean
}) {
  return (
    <div className={`setting-field setting-field--row ${disabled ? 'setting-field--disabled' : ''}`}>
      <div>
        <label className="setting-label">{label}</label>
        {description && <span className="setting-hint">{description}</span>}
      </div>
      <button
        className={`toggle ${checked ? 'toggle--on' : ''} ${disabled ? 'toggle--disabled' : ''}`}
        onClick={disabled ? undefined : (onChange ? () => onChange(!checked) : undefined)}
      >
        <span className="toggle-thumb" />
      </button>
    </div>
  )
}

function SettingSlider({ label, value, min, max, step, unit = '', onChange }: {
  label: string; value: number; min: number; max: number; step: number
  unit?: string; onChange?: (v: number) => void
}) {
  const pct = ((value - min) / (max - min)) * 100
  return (
    <div className="setting-field">
      <div className="setting-label-row">
        <label className="setting-label">{label}</label>
        <span className="setting-value">{value}{unit}</span>
      </div>
      <input
        type="range" className="setting-slider"
        min={min} max={max} step={step} value={value}
        onChange={onChange ? (e) => onChange(Number(e.target.value)) : undefined}
        style={{ '--pct': `${pct}%` } as any}
      />
    </div>
  )
}

function SettingCardSelect({ label, value, options, onChange }: {
  label: string; value: string; options: { value: string; label: string; icon: string; desc: string }[]
  onChange?: (v: string) => void
}) {
  return (
    <div className="setting-field">
      <label className="setting-label">{label}</label>
      <div className="card-select">
        {options.map(o => (
          <button
            key={o.value}
            className={`card-option ${value === o.value ? 'card-option--active' : ''}`}
            onClick={onChange ? () => onChange(o.value) : undefined}
          >
            <span className="card-option-icon">{o.icon}</span>
            <span className="card-option-label">{o.label}</span>
            <span className="card-option-desc">{o.desc}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

function SectionHeader({ title, description, badge }: { title: string; description?: string; badge?: string }) {
  return (
    <div className="section-header">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <h3 className="section-title">{title}</h3>
        {badge && <span className="badge-coming-soon">{badge}</span>}
      </div>
      {description && <p className="section-desc">{description}</p>}
    </div>
  )
}

// ─── Tab Panels ───

function AIPanel({ cfg, setCfg, agents }: {
  cfg: Config; setCfg: (k: keyof Config, v: any) => void; agents: AgentInfo[]
}) {
  const txt = useT()
  const noApiKey = !cfg.aiApiKey
  return (
    <div className="tab-panel">
      <SectionHeader title={txt.aiTitle} description={txt.aiDesc} />

      {noApiKey && (
        <div className="warning-banner">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 1L1 12h12L7 1z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/><path d="M7 5v3M7 10v.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg>
          <span>API Key 未配置 — Direct AI 快速模式不可用</span>
        </div>
      )}

      <SettingInput label={txt.apiKey} value={cfg.aiApiKey} type="password" onChange={v => setCfg('aiApiKey', v)} />
      <SettingInput label={txt.apiBase} value={cfg.aiBaseUrl} placeholder="https://api.openai.com/v1" onChange={v => setCfg('aiBaseUrl', v)} />
      <SettingInput label={txt.model} value={cfg.aiModel} placeholder="gpt-4o-mini" hint={txt.modelHint} onChange={v => setCfg('aiModel', v)} />
      <SettingInput label={txt.maxTokens} value={String(cfg.aiMaxTokens)} type="number" hint={txt.maxTokensHint} onChange={v => setCfg('aiMaxTokens', parseInt(v) || 1024)} />

      <div className="section-divider" />
      <SectionHeader title={txt.agentPath} description={txt.agentPathDesc} />

      <div className="agent-status-list">
        {agents.map(a => (
          <div key={a.name} className={`agent-status ${a.installed ? 'agent-status--ok' : ''}`}>
            <span className="agent-status-dot" />
            <div className="agent-status-info">
              <span className="agent-status-name">{a.name}</span>
              <span className="agent-status-path">{a.path || txt.notInstalled}</span>
            </div>
            <span className={`agent-status-badge ${a.installed ? '' : 'agent-status-badge--muted'}`}>
              {a.installed ? txt.detected : txt.notDetected}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

function STTPanel({ cfg, setCfg }: { cfg: Config; setCfg: (k: keyof Config, v: any) => void }) {
  const txt = useT()
  return (
    <div className="tab-panel">
      <SectionHeader title={txt.sttTitle} description={txt.sttDesc} />

      <SettingCardSelect
        label={txt.sttEngine}
        value={cfg.sttMode}
        onChange={v => setCfg('sttMode', v)}
        options={[
          { value: 'tencent', label: txt.tencent, icon: '☁️', desc: txt.tencentDesc },
          { value: 'local', label: txt.localWhisper, icon: '💻', desc: txt.localDesc },
          { value: 'cloud', label: txt.cloudWhisper, icon: '🌐', desc: txt.cloudDesc },
        ]}
      />

      {cfg.sttMode === 'tencent' && (
        <div className="sub-section">
          <SectionHeader title={txt.tencentConfig} description={txt.tencentConfigDesc} />
          <SettingInput label={txt.secretId} value={cfg.tencentSecretId} type="password" onChange={v => setCfg('tencentSecretId', v)} />
          <SettingInput label={txt.secretKey} value={cfg.tencentSecretKey} type="password" onChange={v => setCfg('tencentSecretKey', v)} />
          <SettingInput label={txt.appId} value={cfg.tencentAppId} onChange={v => setCfg('tencentAppId', v)} />
          <button className="btn btn--outline" style={{ marginTop: 8 }}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 1v5M4 3l3 3 3-3M2 9h10" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/></svg>
            {txt.testConnection}
          </button>
        </div>
      )}

      {cfg.sttMode === 'local' && (
        <div className="sub-section">
          <SectionHeader title={txt.localConfig} description={txt.localConfigDesc} />
          <SettingSelect
            label={txt.modelSize}
            value={cfg.whisperModel}
            onChange={v => setCfg('whisperModel', v)}
            options={[
              { value: 'tiny', label: 'Tiny (75MB)' },
              { value: 'base', label: 'Base (142MB)' },
              { value: 'medium', label: 'Medium (1.5GB)' },
              { value: 'large-v3', label: 'Large v3 (3GB)' },
              { value: 'large-v3-turbo', label: 'Large v3 Turbo (1.5GB)' },
            ]}
          />
          <div className="model-path-info">
            <span className="setting-hint">{txt.modelPath}: %APPDATA%/onhands3/data/whisper/ggml-{cfg.whisperModel}.bin</span>
          </div>
        </div>
      )}

      {cfg.sttMode === 'cloud' && (
        <div className="sub-section">
          <SectionHeader title={txt.cloudConfig} description={txt.cloudConfigDesc} />
          <SettingInput label="API Key (OPENAI_API_KEY)" value="" type="password" placeholder="sk-..." />
          <span className="setting-hint" style={{ marginTop: -4, marginBottom: 8 }}>{txt.apiKeyIndependent}</span>
        </div>
      )}
    </div>
  )
}

function InteractionPanel({ cfg, setCfg }: { cfg: Config; setCfg: (k: keyof Config, v: any) => void }) {
  const txt = useT()
  return (
    <div className="tab-panel">
      <SectionHeader title={txt.interactionTitle} description={txt.interactionDesc} />

      <SettingSlider
        label={txt.longPressDuration}
        value={cfg.longPressDuration}
        min={400} max={1500} step={50} unit="ms"
        onChange={v => setCfg('longPressDuration', v)}
      />
      <span className="setting-hint" style={{ marginTop: -4, marginBottom: 12 }}>{txt.longPressHint}</span>

      <SettingInput label={txt.dragThreshold} value={String(cfg.dragThresholdPx)} type="number" hint={txt.dragThresholdHint}
        onChange={v => setCfg('dragThresholdPx', parseInt(v) || 15)} />

      <div className="section-divider" />
      <SectionHeader title={txt.routingPermissions} />

      <SettingSelect
        label={txt.permissionBehavior}
        value={cfg.defaultPermissionAction}
        onChange={v => setCfg('defaultPermissionAction', v)}
        options={[
          { value: 'ask', label: txt.askEveryTime },
          { value: 'allow', label: txt.autoAllow },
          { value: 'deny', label: txt.autoDeny },
        ]}
      />

      <div className="section-divider" />

      <SectionHeader title={txt.memorySystem} description={txt.memorySystemDesc} badge={txt.comingSoon} />
      <SettingToggle label={txt.enableOh3} description={txt.enableOh3Desc} checked={false} disabled />
      <div className="sub-section section-field--disabled">
        <SettingSelect label={txt.retentionPeriod} value="7" options={[
          { value: '7', label: `7 ${txt.days}` },
          { value: '14', label: `14 ${txt.days}` },
          { value: '30', label: `30 ${txt.days}` },
        ]} />
        <SettingInput label={txt.backupLimit} value="200" type="number" hint={txt.backupLimitHint} />
      </div>
    </div>
  )
}

function AboutPanel() {
  const txt = useT()
  return (
    <div className="tab-panel">
      <div className="about-hero">
        <img src="/Logo_W.png" alt="OnHands3" className="about-logo" />
        <h2 className="about-title">OnHands3</h2>
        <p className="about-tagline">AI-driven smart cursor</p>
        <span className="about-version">v0.49.1</span>
      </div>
      <div className="about-section">
        <h4 className="about-section-title">{txt.systemInfo}</h4>
        <div className="about-info-grid">
          <span className="about-info-key">Electron</span><span className="about-info-val">35.x</span>
          <span className="about-info-key">Node.js</span><span className="about-info-val">22.x</span>
          <span className="about-info-key">Chrome</span><span className="about-info-val">134.x</span>
          <span className="about-info-key">OS</span><span className="about-info-val">Windows 11 x64</span>
        </div>
      </div>
      <div className="about-section">
        <h4 className="about-section-title">{txt.links}</h4>
        <div className="about-links">
          <a className="about-link" href="#"><svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M5 1H2a1 1 0 00-1 1v9a1 1 0 001 1h9a1 1 0 001-1V9M8 1h5v5M5 9L13 1" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/></svg>GitHub</a>
          <a className="about-link" href="#"><svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M5 1H2a1 1 0 00-1 1v9a1 1 0 001 1h9a1 1 0 001-1V9M8 1h5v5M5 9L13 1" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/></svg>{txt.docs}</a>
          <a className="about-link" href="#"><svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M5 1H2a1 1 0 00-1 1v9a1 1 0 001 1h9a1 1 0 001-1V9M8 1h5v5M5 9L13 1" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/></svg>{txt.feedback}</a>
        </div>
      </div>
      <p className="about-footer">MIT License</p>
    </div>
  )
}

// ─── Main App ───

export default function SettingsApp() {
  const [tab, setTab] = useState<'ai' | 'stt' | 'interaction' | 'about'>('ai')
  const [cfg, setRawCfg] = useState<Config | null>(null)
  const [agents, setAgents] = useState<AgentInfo[]>([])
  const [lang, setLang] = useState<Lang>('zh')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  // Load config on mount
  useEffect(() => {
    if (api) {
      api.settingsLoad().then(c => {
        setRawCfg(c)
        setLang(c.language || 'zh')
      })
      api.settingsDetectAgents().then(setAgents)
    } else {
      // Fallback for standalone preview
      setRawCfg({
        aiApiKey: '', aiBaseUrl: 'https://apihub.agnes-ai.com/v1', aiModel: 'agnes-2.0-flash', aiMaxTokens: 1024,
        claudeCodePath: '', codexPath: '', opencodePath: '',
        sttMode: 'tencent', whisperModel: 'large-v3-turbo',
        tencentSecretId: '', tencentSecretKey: '', tencentAppId: '',
        longPressDuration: 800, dragThresholdPx: 15,
        defaultPermissionAction: 'ask', language: 'zh',
      })
      setAgents([
        { name: 'Claude Code', path: '', installed: false },
        { name: 'Codex', path: '', installed: false },
        { name: 'OpenCode', path: '', installed: false },
      ])
    }
  }, [])

  const setCfg = (k: keyof Config, v: any) => {
    if (!cfg) return
    setRawCfg({ ...cfg, [k]: v })
    setSaved(false)
  }

  const handleSave = async () => {
    if (!cfg || !api || saving) return
    setSaving(true)
    try {
      const updated = await api.settingsSave({ ...cfg, language: lang })
      setRawCfg(updated)
      setSaved(true)
      setTimeout(() => setSaved(false), 1500)
    } catch (err) {
      console.error('[settings] Save failed:', err)
    } finally {
      setSaving(false)
    }
  }

  if (!cfg) return null

  const txt = t[lang]

  const tabs: { key: 'ai' | 'stt' | 'interaction' | 'about'; label: string; icon: JSX.Element }[] = [
    { key: 'ai', label: txt.aiConfig, icon: <svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M9 2l1.5 3.5L14 7l-3.5 1.5L9 12 7.5 8.5 4 7l3.5-1.5L9 2z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/><path d="M4 11l1 2.5L7.5 14.5 5 15.5 4 18 3 15.5.5 14.5 3 13.5 4 11z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/></svg> },
    { key: 'stt', label: txt.speech, icon: <svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M9 2a3 3 0 013 3v3a3 3 0 01-6 0V5a3 3 0 013-3z" stroke="currentColor" strokeWidth="1.2"/><path d="M4 9a5 5 0 0010 0M9 14v2M7 16h4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg> },
    { key: 'interaction', label: txt.interaction, icon: <svg width="18" height="18" viewBox="0 0 18 18" fill="none"><rect x="3" y="3" width="12" height="12" rx="2" stroke="currentColor" strokeWidth="1.2"/><path d="M7 7h4M7 11h2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg> },
    { key: 'about', label: txt.about, icon: <svg width="18" height="18" viewBox="0 0 18 18" fill="none"><circle cx="9" cy="9" r="7" stroke="currentColor" strokeWidth="1.2"/><path d="M9 8v4M9 6v.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg> },
  ]

  return (
    <LangCtx.Provider value={{ lang, setLang }}>
      <div className="settings-window">
        <div className="settings-titlebar">
          <span className="settings-titlebar-text">{txt.settings}</span>
          <div className="settings-titlebar-buttons">
            <button className="lang-toggle" onClick={() => setLang(lang === 'zh' ? 'en' : 'zh')}
              title={lang === 'zh' ? 'Switch to English' : '切换中文'}>
              {lang === 'zh' ? 'EN' : '中'}
            </button>
            <button className="titlebar-btn titlebar-btn--close" onClick={() => api?.settingsCloseWindow()}>✕</button>
          </div>
        </div>

        <div className="settings-body">
          <nav className="settings-sidebar">
            {tabs.map(t => (
              <button key={t.key}
                className={`sidebar-tab ${tab === t.key ? 'sidebar-tab--active' : ''}`}
                onClick={() => setTab(t.key)}>
                {t.icon}<span>{t.label}</span>
              </button>
            ))}
          </nav>

          <main className="settings-content">
            {tab === 'ai' && <AIPanel cfg={cfg} setCfg={setCfg} agents={agents} />}
            {tab === 'stt' && <STTPanel cfg={cfg} setCfg={setCfg} />}
            {tab === 'interaction' && <InteractionPanel cfg={cfg} setCfg={setCfg} />}
            {tab === 'about' && <AboutPanel />}
          </main>
        </div>

        <div className="settings-footer">
          <span className="settings-footer-version">v0.49.1</span>
          <button className={`btn btn--primary ${saved ? 'btn--saved' : ''}`} onClick={handleSave} disabled={saving}>
            {saving ? '...' : saved ? txt.saved : txt.saveChanges}
          </button>
        </div>
      </div>
    </LangCtx.Provider>
  )
}

createRoot(document.getElementById('root')!).render(<SettingsApp />)
