import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

// Mock loadConfig before importing DirectAI
vi.mock('../../src/main/config', () => ({
  loadConfig: () => ({
    aiApiKey: 'test-key',
    aiBaseUrl: 'https://test.example.com/v1',
    aiModel: 'test-flash',
    aiMaxTokens: 1024,
  }),
}))

import { DirectAI } from '../../src/main/ai/DirectAI'
import { ensureInitialized, loadMemory, appendRule, oh3Path } from '../../src/main/oh3/Oh3Store'

// fetch mock — call mockFetch with the desired response before each test
let mockResponse: any = { choices: [{ message: { content: '{"shouldWrite": false}' } }] }
const fetchMock = vi.fn(async () => ({
  ok: true,
  status: 200,
  json: async () => mockResponse,
  text: async () => JSON.stringify(mockResponse),
})) as any

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  mockResponse = { choices: [{ message: { content: '{"shouldWrite": false}' } }] }
  fetchMock.mockClear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('DirectAI.judgeMemory', () => {
  const directAI = new DirectAI()

  it('rule 类输入 → 返回 rule judgment', async () => {
    mockResponse = {
      choices: [{
        message: {
          content: '{"shouldWrite": true, "type": "rule", "content": "禁止修改 node_modules/"}',
        },
      }],
    }

    const result = await directAI.judgeMemory('不要碰 node_modules')

    expect(result).not.toBeNull()
    expect(result!.type).toBe('rule')
    expect(result!.content).toBe('禁止修改 node_modules/')
  })

  it('preference 类输入 → 返回 preference judgment', async () => {
    mockResponse = {
      choices: [{
        message: {
          content: '{"shouldWrite": true, "type": "preference", "content": "commit message 用中文"}',
        },
      }],
    }

    const result = await directAI.judgeMemory('commit 信息请用中文')

    expect(result).not.toBeNull()
    expect(result!.type).toBe('preference')
  })

  it('fact 类输入 → 返回 fact judgment', async () => {
    mockResponse = {
      choices: [{
        message: {
          content: '{"shouldWrite": true, "type": "fact", "content": "项目使用 TypeScript"}',
        },
      }],
    }

    const result = await directAI.judgeMemory('我们项目用 TypeScript')

    expect(result).not.toBeNull()
    expect(result!.type).toBe('fact')
  })

  it('普通命令 → 返回 null', async () => {
    mockResponse = {
      choices: [{ message: { content: '{"shouldWrite": false}' } }],
    }

    const result = await directAI.judgeMemory('修复这个 bug')
    expect(result).toBeNull()
  })

  it('翻译请求 → 返回 null', async () => {
    mockResponse = {
      choices: [{ message: { content: '{"shouldWrite": false}' } }],
    }

    const result = await directAI.judgeMemory('translate this to English')
    expect(result).toBeNull()
  })

  it('空输入 → 直接返回 null（不调 API）', async () => {
    const result = await directAI.judgeMemory('')
    expect(result).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('纯空白输入 → 返回 null', async () => {
    const result = await directAI.judgeMemory('   \n\t  ')
    expect(result).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('API 返回非 JSON → 返回 null', async () => {
    mockResponse = {
      choices: [{ message: { content: 'I cannot judge this.' } }],
    }

    const result = await directAI.judgeMemory('test')
    expect(result).toBeNull()
  })

  it('API 返回无效 JSON → 返回 null', async () => {
    mockResponse = {
      choices: [{ message: { content: '{invalid json}' } }],
    }

    const result = await directAI.judgeMemory('test')
    expect(result).toBeNull()
  })

  it('API 返回未知 type → 返回 null', async () => {
    mockResponse = {
      choices: [{
        message: {
          content: '{"shouldWrite": true, "type": "unknown", "content": "test"}',
        },
      }],
    }

    const result = await directAI.judgeMemory('test')
    expect(result).toBeNull()
  })

  it('API 返回缺 content → 返回 null', async () => {
    mockResponse = {
      choices: [{
        message: { content: '{"shouldWrite": true, "type": "rule"}' },
      }],
    }

    const result = await directAI.judgeMemory('test')
    expect(result).toBeNull()
  })

  it('API 返回超长 content → 截断到 200 字符', async () => {
    const longContent = 'A'.repeat(500)
    mockResponse = {
      choices: [{
        message: {
          content: `{"shouldWrite": true, "type": "rule", "content": "${longContent}"}`,
        },
      }],
    }

    const result = await directAI.judgeMemory('test')
    expect(result).not.toBeNull()
    expect(result!.content.length).toBe(200)
  })

  it('API 返回带前后噪声的 JSON → 仍能解析', async () => {
    mockResponse = {
      choices: [{
        message: {
          content: 'Here is my judgment:\n{"shouldWrite": true, "type": "rule", "content": "test"}\nDone.',
        },
      }],
    }

    const result = await directAI.judgeMemory('test')
    expect(result).not.toBeNull()
    expect(result!.content).toBe('test')
  })

  it('API 失败 → 返回 null', async () => {
    fetchMock.mockResolvedValueOnceOnce?.()
    fetchMock.mockImplementationOnce(async () => ({ ok: false, status: 500 }))

    const result = await directAI.judgeMemory('test')
    expect(result).toBeNull()
  })

  it('网络异常 → 返回 null（不抛出）', async () => {
    fetchMock.mockImplementationOnce(async () => {
      throw new Error('Network error')
    })

    const result = await directAI.judgeMemory('test')
    expect(result).toBeNull()
  })

  it('AbortError → 返回 null', async () => {
    fetchMock.mockImplementationOnce(async () => {
      const err = new Error('Aborted')
      err.name = 'AbortError'
      throw err
    })

    const result = await directAI.judgeMemory('test')
    expect(result).toBeNull()
  })

  it('超长输入 → 截断到 500 字符', async () => {
    mockResponse = {
      choices: [{ message: { content: '{"shouldWrite": false}' } }],
    }

    const longInput = 'A'.repeat(1000)
    await directAI.judgeMemory(longInput)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const callBody = JSON.parse(fetchMock.mock.calls[0][1].body)
    const userMsg = callBody.messages[1].content
    expect(userMsg.length).toBe(500)
  })

  it('调用了正确的 system prompt', async () => {
    mockResponse = {
      choices: [{ message: { content: '{"shouldWrite": false}' } }],
    }

    await directAI.judgeMemory('test')

    const callBody = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(callBody.messages[0].role).toBe('system')
    expect(callBody.messages[0].content).toContain('记忆判断器')
    expect(callBody.messages[0].content).toContain('rule')
    expect(callBody.messages[0].content).toContain('preference')
    expect(callBody.messages[0].content).toContain('fact')
  })
})

// ─── 端到端：DirectAI.judgeMemory → Oh3Store.appendRule ──────────────────────

describe('DirectAI.judgeMemory → Oh3Store.appendRule 端到端', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oh3-judge-'))
    ensureInitialized(tmpDir)
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('judgment 写入 Oh3Store 后立即可读', async () => {
    const directAI = new DirectAI()
    mockResponse = {
      choices: [{
        message: {
          content: '{"shouldWrite": true, "type": "rule", "content": "禁止修改 node_modules/"}',
        },
      }],
    }

    const judgment = await directAI.judgeMemory('不要碰 node_modules')
    expect(judgment).not.toBeNull()

    // 写入 Oh3Store
    const id = appendRule(tmpDir, judgment!.type, judgment!.content, 'directai')
    expect(id).toBe('r1')

    // 立即可读
    const data = loadMemory(tmpDir)
    expect(data.entries).toHaveLength(1)
    expect(data.entries[0].content).toBe('禁止修改 node_modules/')
    expect(data.entries[0].source).toBe('directai')
  })

  it('judgment 为 null 时不写入', async () => {
    const directAI = new DirectAI()
    mockResponse = {
      choices: [{ message: { content: '{"shouldWrite": false}' } }],
    }

    const judgment = await directAI.judgeMemory('just a question')
    expect(judgment).toBeNull()

    const data = loadMemory(tmpDir)
    expect(data.entries).toHaveLength(0)
  })
})
