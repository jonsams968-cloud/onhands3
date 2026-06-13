import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import {
  ensureInitialized,
  loadMemory,
  appendRule,
  removeRule,
  rebuildIndex,
  formatRulesForPrompt,
  oh3Path,
  memoryMdPath,
  indexJsonPath,
  configJsonPath,
} from '../../src/main/oh3/Oh3Store'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oh3-test-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

// ─── ensureInitialized ────────────────────────────────────────────────────────

describe('ensureInitialized', () => {
  it('创建完整的 .oh3/ 结构', () => {
    ensureInitialized(tmpDir)
    expect(fs.existsSync(oh3Path(tmpDir))).toBe(true)
    expect(fs.existsSync(memoryMdPath(tmpDir))).toBe(true)
    expect(fs.existsSync(indexJsonPath(tmpDir))).toBe(true)
    expect(fs.existsSync(path.join(oh3Path(tmpDir), '.gitignore'))).toBe(true)
    expect(fs.existsSync(configJsonPath(tmpDir))).toBe(true)
  })

  it('幂等 — 重复调用不覆盖已有文件', () => {
    ensureInitialized(tmpDir)
    const stat1 = fs.statSync(memoryMdPath(tmpDir)).mtimeMs

    // 确保下一次 stat 能检测到差异
    const future = new Date(Date.now() + 5000)
    fs.utimesSync(memoryMdPath(tmpDir), future, future)
    const statAfterTouch = fs.statSync(memoryMdPath(tmpDir)).mtimeMs

    ensureInitialized(tmpDir)
    const stat2 = fs.statSync(memoryMdPath(tmpDir)).mtimeMs

    // mtime 不变（没有重写）
    expect(stat2).toBe(statAfterTouch)
  })

  it('在 node_modules 下不创建', () => {
    const nmDir = path.join(tmpDir, 'node_modules')
    fs.mkdirSync(nmDir)
    ensureInitialized(nmDir)
    expect(fs.existsSync(oh3Path(nmDir))).toBe(false)
  })

  it('在 .git 下不创建', () => {
    const gitDir = path.join(tmpDir, '.git')
    fs.mkdirSync(gitDir)
    ensureInitialized(gitDir)
    expect(fs.existsSync(oh3Path(gitDir))).toBe(false)
  })

  it('.gitignore 内容为 "*"', () => {
    ensureInitialized(tmpDir)
    const gi = fs.readFileSync(path.join(oh3Path(tmpDir), '.gitignore'), 'utf-8')
    expect(gi.trim()).toBe('*')
  })

  it('config.json 含默认配置', () => {
    ensureInitialized(tmpDir)
    const cfg = JSON.parse(fs.readFileSync(configJsonPath(tmpDir), 'utf-8'))
    expect(cfg.retentionDays).toBe(7)
    expect(cfg.backupMaxMB).toBe(200)
    expect(cfg.skipPatterns).toContain('node_modules')
    expect(cfg.skipPatterns).toContain('.git')
  })

  it('初始化时 _index.json 为空', () => {
    ensureInitialized(tmpDir)
    const idx = JSON.parse(fs.readFileSync(indexJsonPath(tmpDir), 'utf-8'))
    expect(idx.version).toBe(1)
    expect(idx.entries).toEqual([])
  })

  it('memory.md 含三个 section', () => {
    ensureInitialized(tmpDir)
    const md = fs.readFileSync(memoryMdPath(tmpDir), 'utf-8')
    expect(md).toContain('## Rules（必须遵守）')
    expect(md).toContain('## Preferences（影响决策）')
    expect(md).toContain('## Facts（项目背景）')
  })

  it('用户误删 config.json 但保留 memory.md → 重建索引，不丢数据', () => {
    // 1. 正常初始化并写入数据
    ensureInitialized(tmpDir)
    appendRule(tmpDir, 'rule', '重要规则', 'user')

    // 2. 用户误删 config.json 和 _index.json（保留 memory.md）
    fs.unlinkSync(configJsonPath(tmpDir))
    fs.unlinkSync(indexJsonPath(tmpDir))

    // 3. 再次 ensureInitialized
    ensureInitialized(tmpDir)

    // 4. memory.md 仍含原数据
    const md = fs.readFileSync(memoryMdPath(tmpDir), 'utf-8')
    expect(md).toContain('重要规则')

    // 5. _index.json 从 memory.md 重建
    const data = loadMemory(tmpDir)
    expect(data.entries).toHaveLength(1)
    expect(data.entries[0].content).toBe('重要规则')
  })
})

// ─── appendRule ───────────────────────────────────────────────────────────────

describe('appendRule', () => {
  beforeEach(() => ensureInitialized(tmpDir))

  it('同时写入 memory.md 和 _index.json', () => {
    const id = appendRule(tmpDir, 'rule', '禁止修改 node_modules/', 'user')
    expect(id).toBeTruthy()

    const data = loadMemory(tmpDir)
    expect(data.entries).toHaveLength(1)
    expect(data.entries[0].content).toBe('禁止修改 node_modules/')
    expect(data.entries[0].type).toBe('rule')

    const md = fs.readFileSync(memoryMdPath(tmpDir), 'utf-8')
    expect(md).toContain('禁止修改 node_modules/')
    expect(md).toContain('## Rules（必须遵守）')
  })

  it('每个 type 的 id 独立递增', () => {
    const r1 = appendRule(tmpDir, 'rule', 'rule 1', 'user')
    const r2 = appendRule(tmpDir, 'rule', 'rule 2', 'user')
    const p1 = appendRule(tmpDir, 'preference', 'pref 1', 'user')
    const f1 = appendRule(tmpDir, 'fact', 'fact 1', 'user')

    expect(r1).toBe('r1')
    expect(r2).toBe('r2')
    expect(p1).toBe('p1')
    expect(f1).toBe('f1')
  })

  it('大小写不敏感的去重', () => {
    appendRule(tmpDir, 'rule', 'No Touch', 'user')
    const dup = appendRule(tmpDir, 'rule', 'no touch', 'user')
    expect(dup).toBeNull()

    const data = loadMemory(tmpDir)
    expect(data.entries).toHaveLength(1)
  })

  it('跨 type 不去重（同内容不同类型可共存）', () => {
    appendRule(tmpDir, 'rule', 'Electron 35')
    appendRule(tmpDir, 'fact', 'Electron 35')
    const data = loadMemory(tmpDir)
    expect(data.entries).toHaveLength(2)
  })

  it('trim 内容两侧空白', () => {
    const id = appendRule(tmpDir, 'fact', '  hello world  ', 'user')
    expect(id).toBeTruthy()
    const data = loadMemory(tmpDir)
    expect(data.entries[0].content).toBe('hello world')
  })

  it('拒绝空内容', () => {
    expect(appendRule(tmpDir, 'rule', '', 'user')).toBeNull()
    expect(appendRule(tmpDir, 'rule', '   ', 'user')).toBeNull()
    expect(appendRule(tmpDir, 'rule', '\t\n', 'user')).toBeNull()
  })

  it('时间戳格式为 YYYY-MM-DD HH:MM:SS', () => {
    appendRule(tmpDir, 'fact', 'test', 'user')
    const data = loadMemory(tmpDir)
    const ts = data.entries[0].ts
    expect(ts).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  })

  it('bullet 格式含 [id] 标记和 HTML 注释时间戳', () => {
    appendRule(tmpDir, 'rule', 'test rule', 'user')
    const md = fs.readFileSync(memoryMdPath(tmpDir), 'utf-8')
    expect(md).toMatch(/- \[r1\] test rule  <!-- \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} -->/)
  })

  it('多条同 type 按顺序追加到 section', () => {
    appendRule(tmpDir, 'rule', 'rule A', 'user')
    appendRule(tmpDir, 'rule', 'rule B', 'user')
    appendRule(tmpDir, 'rule', 'rule C', 'user')

    const md = fs.readFileSync(memoryMdPath(tmpDir), 'utf-8')
    const lines = md.split('\n')
    const ruleBullets = lines.filter(l => l.trim().startsWith('- [r'))
    expect(ruleBullets).toHaveLength(3)
    expect(ruleBullets[0]).toContain('rule A')
    expect(ruleBullets[1]).toContain('rule B')
    expect(ruleBullets[2]).toContain('rule C')
  })
})

// ─── removeRule ───────────────────────────────────────────────────────────────

describe('removeRule', () => {
  beforeEach(() => ensureInitialized(tmpDir))

  it('按 id 删除条目', () => {
    const id = appendRule(tmpDir, 'rule', 'temp rule', 'user')
    const ok = removeRule(tmpDir, id!)
    expect(ok).toBe(true)

    const data = loadMemory(tmpDir)
    expect(data.entries).toHaveLength(0)
  })

  it('同步从 memory.md 删除', () => {
    const id = appendRule(tmpDir, 'rule', 'temp rule', 'user')
    removeRule(tmpDir, id!)

    const md = fs.readFileSync(memoryMdPath(tmpDir), 'utf-8')
    expect(md).not.toContain('temp rule')
    expect(md).not.toContain('[r1]')
  })

  it('只删除指定 id，不影响其他', () => {
    appendRule(tmpDir, 'rule', 'keep me', 'user')
    const id2 = appendRule(tmpDir, 'rule', 'delete me', 'user')

    removeRule(tmpDir, id2!)

    const data = loadMemory(tmpDir)
    expect(data.entries).toHaveLength(1)
    expect(data.entries[0].content).toBe('keep me')
  })

  it('未知 id 返回 false', () => {
    expect(removeRule(tmpDir, 'r999')).toBe(false)
    expect(removeRule(tmpDir, '')).toBe(false)
  })
})

// ─── loadMemory 与外部编辑 ────────────────────────────────────────────────────

describe('loadMemory 检测外部编辑', () => {
  beforeEach(() => ensureInitialized(tmpDir))

  it('memory.md 比 _index.json 新 → 自动重建', () => {
    appendRule(tmpDir, 'rule', 'original', 'user')

    // 模拟用户手动编辑 memory.md（添加新行 + 调整 mtime）
    const mdPath = memoryMdPath(tmpDir)
    const content = fs.readFileSync(mdPath, 'utf-8')
    const newContent = content.replace(
      '## Rules（必须遵守）\n',
      '## Rules（必须遵守）\n- 手动添加的规则\n',
    )
    fs.writeFileSync(mdPath, newContent, 'utf-8')
    const future = new Date(Date.now() + 5000)
    fs.utimesSync(mdPath, future, future)

    const data = loadMemory(tmpDir)
    const contents = data.entries.map(e => e.content)
    expect(contents).toContain('手动添加的规则')
    expect(contents).toContain('original')
    expect(data.lastWrittenBy).toBe('user')
  })

  it('未编辑时不会触发重建', () => {
    appendRule(tmpDir, 'rule', 'stable', 'user')
    const before = JSON.parse(fs.readFileSync(indexJsonPath(tmpDir), 'utf-8'))

    // 不修改任何文件，直接 load
    const data = loadMemory(tmpDir)
    const after = JSON.parse(fs.readFileSync(indexJsonPath(tmpDir), 'utf-8'))

    // 索引未被重写（lastWrittenBy 不变）
    expect(after.lastWrittenBy).toBe(before.lastWrittenBy)
    expect(data.entries[0].content).toBe('stable')
  })

  it('目录未初始化时返回空数据', () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oh3-empty-'))
    try {
      const data = loadMemory(emptyDir)
      expect(data.entries).toEqual([])
      expect(data.version).toBe(1)
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true })
    }
  })
})

// ─── rebuildIndex ─────────────────────────────────────────────────────────────

describe('rebuildIndex', () => {
  beforeEach(() => ensureInitialized(tmpDir))

  it('解析带 [id] 的 bullet', () => {
    const md = `# Memory

## Rules（必须遵守）
- [r1] rule one  <!-- 2026-06-13 14:00:00 -->
- [r2] rule two  <!-- 2026-06-13 14:01:00 -->

## Preferences（影响决策）
- [p1] pref one  <!-- 2026-06-13 14:02:00 -->
`
    fs.writeFileSync(memoryMdPath(tmpDir), md, 'utf-8')

    const data = rebuildIndex(tmpDir)
    expect(data.entries).toHaveLength(3)
    expect(data.entries[0].id).toBe('r1')
    expect(data.entries[0].content).toBe('rule one')
    expect(data.entries[0].ts).toBe('2026-06-13 14:00:00')
    expect(data.entries[1].id).toBe('r2')
    expect(data.entries[2].id).toBe('p1')
    expect(data.entries[2].type).toBe('preference')
  })

  it('为无 id 的 bullet 分配新 id', () => {
    const md = `# Memory

## Rules（必须遵守）
- no id here
- another rule
`
    fs.writeFileSync(memoryMdPath(tmpDir), md, 'utf-8')

    const data = rebuildIndex(tmpDir)
    expect(data.entries).toHaveLength(2)
    expect(data.entries[0].id).toBe('r1')
    expect(data.entries[0].content).toBe('no id here')
    expect(data.entries[1].id).toBe('r2')
  })

  it('正确归类到当前 section', () => {
    const md = `# Memory

## Rules（必须遵守）
- must do this

## Facts（项目背景）
- uses Electron 35
`
    fs.writeFileSync(memoryMdPath(tmpDir), md, 'utf-8')

    const data = rebuildIndex(tmpDir)
    expect(data.entries).toHaveLength(2)
    expect(data.entries[0].type).toBe('rule')
    expect(data.entries[1].type).toBe('fact')
  })

  it('空 memory.md 返回空 entries', () => {
    fs.writeFileSync(memoryMdPath(tmpDir), '# Empty\n', 'utf-8')
    const data = rebuildIndex(tmpDir)
    expect(data.entries).toHaveLength(0)
  })

  it('忽略非 bullet 行（如 section 之间的说明）', () => {
    const md = `# Memory

这是一段说明文字，不是 bullet。
> 这是一段引用。

## Rules（必须遵守）
some text without dash
- valid rule
`
    fs.writeFileSync(memoryMdPath(tmpDir), md, 'utf-8')

    const data = rebuildIndex(tmpDir)
    expect(data.entries).toHaveLength(1)
    expect(data.entries[0].content).toBe('valid rule')
  })
})

// ─── formatRulesForPrompt ─────────────────────────────────────────────────────

describe('formatRulesForPrompt', () => {
  beforeEach(() => ensureInitialized(tmpDir))

  it('无条目时返回空字符串', () => {
    expect(formatRulesForPrompt(tmpDir)).toBe('')
  })

  it('格式化三个 section', () => {
    appendRule(tmpDir, 'rule', '不许删除文件', 'user')
    appendRule(tmpDir, 'preference', 'commit 用中文', 'user')
    appendRule(tmpDir, 'fact', 'Electron 35', 'user')

    const s = formatRulesForPrompt(tmpDir)
    expect(s).toContain('【必须遵守的规则】')
    expect(s).toContain('不许删除文件')
    expect(s).toContain('【偏好】')
    expect(s).toContain('commit 用中文')
    expect(s).toContain('【项目背景】')
    expect(s).toContain('Electron 35')
  })

  it('只有部分 type 时只输出对应 section', () => {
    appendRule(tmpDir, 'rule', 'rule A', 'user')

    const s = formatRulesForPrompt(tmpDir)
    expect(s).toContain('【必须遵守的规则】')
    expect(s).not.toContain('【偏好】')
    expect(s).not.toContain('【项目背景】')
  })
})

// ─── 端到端工作流 ─────────────────────────────────────────────────────────────

describe('端到端工作流', () => {
  beforeEach(() => ensureInitialized(tmpDir))

  it('完整工作流：初始化 → 追加 → 读取 → 删除', () => {
    // 1. 追加多条
    appendRule(tmpDir, 'rule', '禁止删除文件', 'user')
    appendRule(tmpDir, 'preference', 'commit 用中文', 'user')
    appendRule(tmpDir, 'fact', '项目名：OnHands', 'directai')

    // 2. 读取
    let data = loadMemory(tmpDir)
    expect(data.entries).toHaveLength(3)

    // 3. 删除一条
    removeRule(tmpDir, 'p1')

    // 4. 再次读取
    data = loadMemory(tmpDir)
    expect(data.entries).toHaveLength(2)
    const types = data.entries.map(e => e.type)
    expect(types).toContain('rule')
    expect(types).toContain('fact')
    expect(types).not.toContain('preference')
  })

  it('用户手动编辑 → 自动重建 → 新条目可读', () => {
    appendRule(tmpDir, 'rule', 'auto rule', 'directai')

    // 用户手动编辑 memory.md，添加 2 条
    const mdPath = memoryMdPath(tmpDir)
    const content = fs.readFileSync(mdPath, 'utf-8')
    const newContent = content.replace(
      '## Rules（必须遵守）\n',
      '## Rules（必须遵守）\n- 手动规则 1\n- 手动规则 2\n',
    )
    fs.writeFileSync(mdPath, newContent, 'utf-8')
    fs.utimesSync(mdPath, new Date(Date.now() + 5000), new Date(Date.now() + 5000))

    // Agent 通过 formatRulesForPrompt 读
    const formatted = formatRulesForPrompt(tmpDir)
    expect(formatted).toContain('auto rule')
    expect(formatted).toContain('手动规则 1')
    expect(formatted).toContain('手动规则 2')
  })
})
