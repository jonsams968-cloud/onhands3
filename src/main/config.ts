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
}

let config: Config | null = null

export function loadConfig(): Config {
  if (config) return config

  // Load .env file
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

  config = {
    aiApiKey:        e.AI_API_KEY || '',
    aiBaseUrl:       e.AI_BASE_URL || 'https://apihub.agnes-ai.com/v1',
    aiModel:         e.AI_MODEL || 'agnes-2.0-flash',
    aiMaxTokens:     parseInt(e.AI_MAX_TOKENS || '1024'),

    claudeCodePath:  e.CLAUDE_CODE_PATH || '',
    codexPath:       e.CODEX_PATH || '',
    opencodePath:    e.OPENCODE_PATH || '',

    sttMode:         (e.STT_MODE as 'local' | 'cloud' | 'tencent') || 'cloud',
    whisperModel:    (e.WHISPER_MODEL as any) || 'large-v3-turbo',

    tencentSecretId:  e.TENCENT_SECRET_ID || '',
    tencentSecretKey: e.TENCENT_SECRET_KEY || '',
    tencentAppId:     e.TENCENT_APP_ID || '',

    longPressDuration: parseInt(e.LONG_PRESS_DURATION || '800'),
    dragThresholdPx:   parseInt(e.DRAG_THRESHOLD_PX || '15'),

    dataDir: e.DATA_DIR || path.join(app.getPath('userData'), 'data'),

    permissionPort:           parseInt(e.PERMISSION_PORT || '19843'),
    permissionTimeout:        parseInt(e.PERMISSION_TIMEOUT || '15000'),
    defaultPermissionAction:  (e.DEFAULT_PERMISSION_ACTION as any) || 'ask',
  }

  return config
}
