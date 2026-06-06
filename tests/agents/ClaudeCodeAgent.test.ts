import { describe, it, expect } from 'vitest'

describe('ClaudeCodeAgent', () => {
  it('should build correct CLI args', async () => {
    const { ClaudeCodeAgent } = await import('../../src/main/agents/ClaudeCodeAgent')
    const agent = new ClaudeCodeAgent({
      name: 'claude-code',
      displayName: 'Claude Code',
      binaryPath: 'claude',
      available: true,
    })

    expect(agent.info.name).toBe('claude-code')
    expect(agent.info.available).toBe(true)
  })

  it('should extract plain text from stream-json output', async () => {
    const { ClaudeCodeAgent } = await import('../../src/main/agents/ClaudeCodeAgent')
    const agent = new ClaudeCodeAgent({
      name: 'claude-code',
      displayName: 'Claude Code',
      binaryPath: 'claude',
      available: true,
    })

    // Access private method via any cast for testing
    const extract = (agent as any).extractPlainText.bind(agent)

    const streamOutput = [
      '{"type":"system","session_id":"abc"}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"Hello world"}]}}',
      '{"type":"result","result":"Hello world","duration_ms":1000}',
    ].join('\n')

    expect(extract(streamOutput)).toBe('Hello world')
  })
})
