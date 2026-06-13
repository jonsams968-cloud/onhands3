/**
 * Oh3Store — 每个目录的 AI 记忆系统。
 *
 * 目录布局：
 *   <workDir>/.oh3/
 *   ├── .gitignore          # 内容为 "*"（整个 .oh3/ 都不纳入版本控制）
 *   ├── config.json         # OnHands 配置：保留期、备份上限、跳过列表
 *   └── memory/
 *       ├── memory.md       # 人类可读，按 section 组织
 *       └── _index.json     # 程序可读的索引
 *
 * memory.md 的 section：
 *   ## Rules（必须遵守）       硬约束（如"禁止修改 node_modules/"）
 *   ## Preferences（影响决策） 软偏好（如"commit message 用中文"）
 *   ## Facts（项目背景）        静态事实（如"技术栈：Electron 35"）
 *
 * 同步契约：
 *   - 写入路径：appendRule / removeRule 同时更新 memory.md 和 _index.json
 *   - 读取路径：loadMemory 优先读 _index.json；若 memory.md 的 mtime 比索引中
 *     记录的 memoryMtime 更新（用户手动编辑过），自动重建索引
 *   - 手动编辑：用户可以自由编辑 memory.md；下次读取时 OnHands 自动重建
 *
 * Windows 隐藏属性：
 *   .oh3/ 目录会被设置 `attrib +H +S`（隐藏 + 系统），避免用户随手浏览。
 *   子文件通过目录属性继承（资源管理器默认隐藏系统文件）。
 *
 * 时间戳：
 *   所有时间戳使用 `YYYY-MM-DD HH:MM:SS` 格式（秒级精度）。
 *   _index.json 内部的 memoryMtime 使用 ISO 8601（带毫秒）便于精确比较。
 */

import * as fs from 'fs'
import * as path from 'path'
import { execFileSync } from 'child_process'

// ─── 类型 ─────────────────────────────────────────────────────────────────────

export type RuleType = 'rule' | 'preference' | 'fact'
export type RuleSource = 'user' | 'directai' | 'agent'

export interface MemoryEntry {
  id: string         // 如 'r1', 'p2', 'f3'
  type: RuleType
  content: string
  ts: string         // YYYY-MM-DD HH:MM:SS
  source: RuleSource
}

export interface MemoryData {
  version: number
  memoryMtime: string  // ISO 8601 — OnHands 上次写入 memory.md 的时间
  lastWrittenBy: 'directai' | 'agent' | 'user' | 'system'
  entries: MemoryEntry[]
}

export interface Oh3Config {
  retentionDays: number      // log/context 条目的保留天数
  backupMaxMB: number        // .oh3/backups/ 的最大体积
  skipPatterns: string[]     // 不创建 .oh3/ 的目录名
}

/** DirectAI 判断结果：是否值得记住，以及类型与内容 */
export interface MemoryJudgment {
  type: RuleType
  content: string
}

// ─── 常量 ─────────────────────────────────────────────────────────────────────

const OH3_DIR = '.oh3'
const MEMORY_DIR = 'memory'
const MEMORY_MD = 'memory.md'
const INDEX_JSON = '_index.json'
const CONFIG_JSON = 'config.json'
const GITIGNORE = '.gitignore'

const DEFAULT_CONFIG: Oh3Config = {
  retentionDays: 7,
  backupMaxMB: 200,
  skipPatterns: ['node_modules', '.git', 'dist', 'build', 'out', '.oh3'],
}

const SECTION_HEADERS: Record<RuleType, string> = {
  rule: '## Rules（必须遵守）',
  preference: '## Preferences（影响决策）',
  fact: '## Facts（项目背景）',
}

const ID_PREFIX: Record<RuleType, string> = {
  rule: 'r',
  preference: 'p',
  fact: 'f',
}

const MEMORY_MD_TEMPLATE = `# OnHands 项目记忆

> 最后更新：—
> 由 OnHands 自动维护，也可手动编辑。手动修改后下次读取会自动重建索引。

## Rules（必须遵守）


## Preferences（影响决策）


## Facts（项目背景）

`

const GITIGNORE_CONTENT = '*\n'

// ─── 路径辅助 ─────────────────────────────────────────────────────────────────

export function oh3Path(workDir: string): string {
  return path.join(workDir, OH3_DIR)
}

export function memoryDirPath(workDir: string): string {
  return path.join(oh3Path(workDir), MEMORY_DIR)
}

export function memoryMdPath(workDir: string): string {
  return path.join(memoryDirPath(workDir), MEMORY_MD)
}

export function indexJsonPath(workDir: string): string {
  return path.join(memoryDirPath(workDir), INDEX_JSON)
}

export function configJsonPath(workDir: string): string {
  return path.join(oh3Path(workDir), CONFIG_JSON)
}

// ─── 时间戳 ───────────────────────────────────────────────────────────────────

/** YYYY-MM-DD HH:MM:SS — 用于展示 */
function nowTs(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
         `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** ISO 8601 带毫秒 — 用于精确比较 */
function nowIso(): string {
  return new Date().toISOString()
}

// ─── 初始化 ───────────────────────────────────────────────────────────────────

/**
 * 在 workDir 下创建 .oh3/ 结构（若不存在）。
 * 幂等 — 每次 Agent 运行时调用都安全。
 *
 * 若 workDir 的 basename 命中 skipPatterns（如 node_modules），跳过创建。
 * 若 memory.md 已存在但其他文件缺失（用户误删），保留 memory.md 并重建索引。
 */
export function ensureInitialized(workDir: string): void {
  if (!workDir) return

  const base = path.basename(workDir)
  if (DEFAULT_CONFIG.skipPatterns.includes(base)) {
    return
  }

  const oh3 = oh3Path(workDir)
  const configExists = fs.existsSync(path.join(oh3, CONFIG_JSON))
  const mdExists = fs.existsSync(memoryMdPath(workDir))

  if (configExists) {
    return // 已完整初始化
  }

  fs.mkdirSync(memoryDirPath(workDir), { recursive: true })

  // 写入模板文件（但不覆盖已存在的 memory.md）
  if (!fs.existsSync(path.join(oh3, GITIGNORE))) {
    fs.writeFileSync(path.join(oh3, GITIGNORE), GITIGNORE_CONTENT, 'utf-8')
  }
  fs.writeFileSync(configJsonPath(workDir), JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf-8')
  if (!mdExists) {
    fs.writeFileSync(memoryMdPath(workDir), MEMORY_MD_TEMPLATE, 'utf-8')
  }

  // 重建 _index.json（若 memory.md 已存在，从中解析；否则初始化为空）
  if (mdExists) {
    rebuildIndex(workDir)
  } else {
    const initialData: MemoryData = {
      version: 1,
      memoryMtime: nowIso(),
      lastWrittenBy: 'system',
      entries: [],
    }
    fs.writeFileSync(indexJsonPath(workDir), JSON.stringify(initialData, null, 2), 'utf-8')
  }

  // Windows 下设置隐藏+系统属性（仅首次创建时）
  if (process.platform === 'win32' && !configExists) {
    try {
      execFileSync('attrib', ['+H', '+S', oh3], { windowsHide: true })
    } catch (err) {
      console.warn(`[Oh3Store] 设置隐藏属性失败 ${oh3}:`, err)
    }
  }
}

// ─── 加载 ─────────────────────────────────────────────────────────────────────

const EMPTY_MEMORY: MemoryData = {
  version: 1,
  memoryMtime: '',
  lastWrittenBy: 'system',
  entries: [],
}

/**
 * 加载 workDir 的记忆条目。
 *
 * 若 memory.md 被外部编辑过（mtime 比索引记录的更新），自动重建索引后再返回。
 */
export function loadMemory(workDir: string): MemoryData {
  const indexPath = indexJsonPath(workDir)
  if (!fs.existsSync(indexPath)) {
    return { ...EMPTY_MEMORY }
  }

  const stored = readIndex(workDir)
  if (!stored) return { ...EMPTY_MEMORY }

  // 检查 memory.md 是否被外部编辑（用 1 秒容差避免我们自己的写入触发误重建）
  const mdPath = memoryMdPath(workDir)
  if (fs.existsSync(mdPath) && stored.memoryMtime) {
    const mdMs = fs.statSync(mdPath).mtimeMs
    const storedMs = Date.parse(stored.memoryMtime)
    if (mdMs > storedMs + 1000) {
      // memory.md 比索引记录新 1 秒以上 → 用户手动编辑过，重建
      return rebuildIndex(workDir)
    }
  }

  return stored
}

function readIndex(workDir: string): MemoryData | null {
  try {
    const raw = fs.readFileSync(indexJsonPath(workDir), 'utf-8')
    return JSON.parse(raw) as MemoryData
  } catch {
    return null
  }
}

// ─── 追加 / 删除 ──────────────────────────────────────────────────────────────

/**
 * 追加一条记忆。同时更新 memory.md 和 _index.json。
 * 自动初始化 .oh3/ 结构（若不存在）。
 *
 * @returns 新建条目的 id；若内容为空或重复，返回 null
 */
export function appendRule(
  workDir: string,
  type: RuleType,
  content: string,
  source: RuleSource,
): string | null {
  const trimmed = content.trim()
  if (!trimmed) return null

  // 自动初始化（幂等）
  ensureInitialized(workDir)

  const data = loadMemory(workDir)

  // 去重检查（大小写不敏感）
  const dup = data.entries.find(
    e => e.type === type && e.content.toLowerCase() === trimmed.toLowerCase(),
  )
  if (dup) return null

  // 生成下一个 id
  const prefix = ID_PREFIX[type]
  const existingNums = data.entries
    .filter(e => e.id.startsWith(prefix))
    .map(e => parseInt(e.id.slice(prefix.length)) || 0)
  const nextNum = (existingNums.length ? Math.max(...existingNums) : 0) + 1
  const id = `${prefix}${nextNum}`

  const entry: MemoryEntry = {
    id,
    type,
    content: trimmed,
    ts: nowTs(),
    source,
  }

  // 更新 memory.md（插入到对应 section）
  appendToMemoryMd(workDir, entry)

  // 更新 _index.json
  const updated: MemoryData = {
    version: 1,
    memoryMtime: nowIso(),
    lastWrittenBy: source === 'user' ? 'user' : 'directai',
    entries: [...data.entries, entry],
  }
  fs.writeFileSync(indexJsonPath(workDir), JSON.stringify(updated, null, 2), 'utf-8')

  return id
}

/**
 * 按 id 删除一条记忆。
 */
export function removeRule(workDir: string, id: string): boolean {
  const data = loadMemory(workDir)
  const entry = data.entries.find(e => e.id === id)
  if (!entry) return false

  // 从 memory.md 删除
  removeFromMemoryMd(workDir, entry)

  // 从索引删除
  const updated: MemoryData = {
    ...data,
    memoryMtime: nowIso(),
    lastWrittenBy: 'directai',
    entries: data.entries.filter(e => e.id !== id),
  }
  fs.writeFileSync(indexJsonPath(workDir), JSON.stringify(updated, null, 2), 'utf-8')

  return true
}

// ─── memory.md section 编辑 ───────────────────────────────────────────────────

/**
 * 在 memory.md 的对应 section 下插入一条 bullet。
 * bullet 格式：`- [id] content  <!-- ts -->`
 */
function appendToMemoryMd(workDir: string, entry: MemoryEntry): void {
  const mdPath = memoryMdPath(workDir)
  let content = fs.existsSync(mdPath)
    ? fs.readFileSync(mdPath, 'utf-8')
    : MEMORY_MD_TEMPLATE

  const header = SECTION_HEADERS[entry.type]
  const bullet = `- [${entry.id}] ${entry.content}  <!-- ${entry.ts} -->`

  const lines = content.split('\n')
  let headerIdx = -1
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === header) {
      headerIdx = i
      break
    }
  }

  if (headerIdx === -1) {
    // section 不存在 — 追加到末尾
    content += `\n${header}\n${bullet}\n`
    fs.writeFileSync(mdPath, content, 'utf-8')
    return
  }

  // 找到插入点：header 之后、已有的同类 bullet 之后、下一个 ## 之前
  let insertIdx = headerIdx + 1
  while (insertIdx < lines.length) {
    const line = lines[insertIdx].trim()
    if (line.startsWith('## ')) break
    if (line.startsWith('- [')) {
      insertIdx++
      continue
    }
    // header 后的空行也跳过
    if (line === '') {
      insertIdx++
      continue
    }
    break
  }

  lines.splice(insertIdx, 0, bullet)
  fs.writeFileSync(mdPath, lines.join('\n'), 'utf-8')
}

/**
 * 从 memory.md 中删除指定条目的 bullet。
 */
function removeFromMemoryMd(workDir: string, entry: MemoryEntry): void {
  const mdPath = memoryMdPath(workDir)
  if (!fs.existsSync(mdPath)) return

  const content = fs.readFileSync(mdPath, 'utf-8')
  const lines = content.split('\n')
  const marker = `[${entry.id}]`

  const filtered = lines.filter(line => !line.includes(marker))
  fs.writeFileSync(mdPath, filtered.join('\n'), 'utf-8')
}

// ─── 重建索引 ─────────────────────────────────────────────────────────────────

/**
 * 从 memory.md 重建 _index.json。
 *
 * 用户手动编辑 memory.md 后使用。解析每个 section，提取形如
 * `- [id] content  <!-- ts -->` 的 bullet，重建索引。
 *
 * 没有 [id] 标记的 bullet 会被分配新 id。
 */
export function rebuildIndex(workDir: string): MemoryData {
  const mdPath = memoryMdPath(workDir)
  if (!fs.existsSync(mdPath)) {
    const empty: MemoryData = {
      version: 1,
      memoryMtime: nowIso(),
      lastWrittenBy: 'user',
      entries: [],
    }
    return empty
  }

  const content = fs.readFileSync(mdPath, 'utf-8')
  const lines = content.split('\n')
  const entries: MemoryEntry[] = []

  let currentType: RuleType | null = null
  const counters: Record<RuleType, number> = { rule: 0, preference: 0, fact: 0 }

  for (const line of lines) {
    const trimmed = line.trim()

    // 检测 section header
    if (trimmed.startsWith('## ')) {
      if (trimmed === SECTION_HEADERS.rule) currentType = 'rule'
      else if (trimmed === SECTION_HEADERS.preference) currentType = 'preference'
      else if (trimmed === SECTION_HEADERS.fact) currentType = 'fact'
      else currentType = null
      continue
    }

    if (!currentType) continue

    // 解析 bullet：`- [id] content  <!-- ts -->` 或 `- content`
    const matchWithId = trimmed.match(
      /^- \[([a-z])(\d+)\]\s*(.+?)\s*<!--\s*(.+?)\s*-->$/,
    )
    const matchPlain = trimmed.match(/^- (.+)$/)

    if (matchWithId) {
      const prefix = matchWithId[1]
      const num = parseInt(matchWithId[2])
      const entryContent = matchWithId[3]
      const ts = matchWithId[4]
      const type = (Object.keys(ID_PREFIX) as RuleType[]).find(
        k => ID_PREFIX[k] === prefix,
      )
      if (type) {
        counters[type] = Math.max(counters[type], num)
        entries.push({
          id: `${prefix}${num}`,
          type,
          content: entryContent,
          ts,
          source: 'user',
        })
      }
    } else if (matchPlain && !trimmed.startsWith('- [')) {
      // 无 id 的 bullet — 分配一个
      const type = currentType
      counters[type]++
      const cleanedContent = matchPlain[1].replace(/\s*<!--.+?-->\s*$/, '').trim()
      entries.push({
        id: `${ID_PREFIX[type]}${counters[type]}`,
        type,
        content: cleanedContent,
        ts: nowTs(),
        source: 'user',
      })
    }
  }

  const data: MemoryData = {
    version: 1,
    memoryMtime: nowIso(),
    lastWrittenBy: 'user',
    entries,
  }
  fs.writeFileSync(indexJsonPath(workDir), JSON.stringify(data, null, 2), 'utf-8')

  return data
}

// ─── 查询辅助 ─────────────────────────────────────────────────────────────────

/**
 * 将记忆格式化为注入 Agent prompt 的字符串。
 *
 * Rules 全部原样注入；Preferences 和 Facts 给出摘要行。
 * 若没有任何条目，返回空字符串。
 */
export function formatRulesForPrompt(workDir: string): string {
  const data = loadMemory(workDir)
  const rules = data.entries.filter(e => e.type === 'rule')
  const prefs = data.entries.filter(e => e.type === 'preference')
  const facts = data.entries.filter(e => e.type === 'fact')

  if (rules.length === 0 && prefs.length === 0 && facts.length === 0) {
    return ''
  }

  const parts: string[] = []
  if (rules.length > 0) {
    parts.push('【必须遵守的规则】')
    for (const r of rules) parts.push(`- ${r.content}`)
  }
  if (prefs.length > 0) {
    parts.push('【偏好】')
    for (const p of prefs) parts.push(`- ${p.content}`)
  }
  if (facts.length > 0) {
    parts.push('【项目背景】')
    for (const f of facts) parts.push(`- ${f.content}`)
  }
  return parts.join('\n')
}
