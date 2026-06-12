import * as path from 'path'
import * as fs from 'fs'
import { app } from 'electron'

export interface Config {
  // AI (direct mode — fast tasks)
  aiApiKey: string
  aiBaseUrl: string
  aiModel: string
  aiMaxTokens: number

  // Agent CLI paths
  claudeCodePath: string
  codexPath: string
  opencodePath: string

  // STT
  sttMode: 'local' | 'cloud' | 'tencent'
  whisperModel: 'tiny' | 'base' | 'medium' | 'large-v3' | 'large-v3-turbo'

  // Tencent Cloud ASR
  tencentSecretId: string
  tencentSecretKey: string
  tencentAppId: string

  // Input
  longPressDuration: number
  dragThresholdPx: number

  // Data
  dataDir: string

  // Permission system
  permissionPort: number
  permissionTimeout: number
  defaultPermissionAction: 'ask' | 'allow' | 'deny'

  // Language
  language: 'zh' | 'en'
}

let config: Config | null = null

function getConfigPath(): string {
  return path.join(app.getPath('userData'), 'config.json')
}

function getDefaultConfig(): Config {
  return {
    aiApiKey: '',
    aiBaseUrl: 'https://apihub.agnes-ai.com/v1',
    aiModel: 'agnes-2.0-flash',
    aiMaxTokens: 1024,

    claudeCodePath: '',
    codexPath: '',
    opencodePath: '',

    sttMode: 'tencent',
    whisperModel: 'large-v3-turbo',

    tencentSecretId: '',
    tencentSecretKey: '',
    tencentAppId: '',

    longPressDuration: 800,
    dragThresholdPx: 15,

    dataDir: path.join(app.getPath('userData'), 'data'),

    permissionPort: 19843,
    permissionTimeout: 15000,
    defaultPermissionAction: 'ask',

    language: 'zh',
  }
}

function loadEnvOverrides(): Partial<Config> {
  const envPath = path.join(process.cwd(), '.env')
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
      const match = line.match(/^([^#=]+)=(.*)$/)
      if (match && !process.env[match[1].trim()]) {
        process.env[match[1].trim()] = match[2].trim()
      }
    }
  }

  const e = process.env
  const overrides: Partial<Config> = {}
  if (e.AI_API_KEY) overrides.aiApiKey = e.AI_API_KEY
  if (e.AI_BASE_URL) overrides.aiBaseUrl = e.AI_BASE_URL
  if (e.AI_MODEL) overrides.aiModel = e.AI_MODEL
  if (e.AI_MAX_TOKENS) overrides.aiMaxTokens = parseInt(e.AI_MAX_TOKENS)
  if (e.CLAUDE_CODE_PATH) overrides.claudeCodePath = e.CLAUDE_CODE_PATH
  if (e.CODEX_PATH) overrides.codexPath = e.CODEX_PATH
  if (e.OPENCODE_PATH) overrides.opencodePath = e.OPENCODE_PATH
  if (e.STT_MODE) overrides.sttMode = e.STT_MODE as any
  if (e.WHISPER_MODEL) overrides.whisperModel = e.WHISPER_MODEL as any
  if (e.TENCENT_SECRET_ID) overrides.tencentSecretId = e.TENCENT_SECRET_ID
  if (e.TENCENT_SECRET_KEY) overrides.tencentSecretKey = e.TENCENT_SECRET_KEY
  if (e.TENCENT_APP_ID) overrides.tencentAppId = e.TENCENT_APP_ID
  if (e.LONG_PRESS_DURATION) overrides.longPressDuration = parseInt(e.LONG_PRESS_DURATION)
  if (e.DRAG_THRESHOLD_PX) overrides.dragThresholdPx = parseInt(e.DRAG_THRESHOLD_PX)
  if (e.DATA_DIR) overrides.dataDir = e.DATA_DIR
  if (e.PERMISSION_PORT) overrides.permissionPort = parseInt(e.PERMISSION_PORT)
  if (e.PERMISSION_TIMEOUT) overrides.permissionTimeout = parseInt(e.PERMISSION_TIMEOUT)
  if (e.DEFAULT_PERMISSION_ACTION) overrides.defaultPermissionAction = e.DEFAULT_PERMISSION_ACTION as any
  if (e.LANGUAGE) overrides.language = e.LANGUAGE as 'zh' | 'en'
  return overrides
}

export function loadConfig(): Config {
  if (config) return config

  const defaults = getDefaultConfig()
  const configPath = getConfigPath()

  let fileConfig: Partial<Config> = {}
  if (fs.existsSync(configPath)) {
    try {
      fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
    } catch {
      console.warn('[config] Failed to parse config.json, using defaults')
    }
  }

  const envOverrides = loadEnvOverrides()

  config = { ...defaults, ...fileConfig, ...envOverrides } as Config
  return config
}

export function saveConfig(partial: Partial<Config>): Config {
  const current = loadConfig()
  config = { ...current, ...partial }

  const configPath = getConfigPath()
  const dir = path.dirname(configPath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8')

  // Also update process.env so any code reading env vars gets the new values
  if (config.aiApiKey) process.env.AI_API_KEY = config.aiApiKey
  if (config.aiBaseUrl) process.env.AI_BASE_URL = config.aiBaseUrl
  if (config.aiModel) process.env.AI_MODEL = config.aiModel
  if (config.tencentSecretId) process.env.TENCENT_SECRET_ID = config.tencentSecretId
  if (config.tencentSecretKey) process.env.TENCENT_SECRET_KEY = config.tencentSecretKey
  if (config.tencentAppId) process.env.TENCENT_APP_ID = config.tencentAppId
  if (config.sttMode) process.env.STT_MODE = config.sttMode
  if (config.whisperModel) process.env.WHISPER_MODEL = config.whisperModel

  return config
}
