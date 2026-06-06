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
  sttMode: 'local' | 'cloud'
  whisperModel: 'tiny' | 'base'

  // Input
  longPressDuration: number
  dragThresholdPx: number

  // Data
  dataDir: string
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

    sttMode:         (e.STT_MODE as 'local' | 'cloud') || 'local',
    whisperModel:    (e.WHISPER_MODEL as 'tiny' | 'base') || 'base',

    longPressDuration: parseInt(e.LONG_PRESS_DURATION || '800'),
    dragThresholdPx:   parseInt(e.DRAG_THRESHOLD_PX || '15'),

    dataDir: e.DATA_DIR || path.join(app.getPath('userData'), 'data'),
  }

  return config
}
