import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock electron's net.request as a controllable fake
const mockRequest = vi.fn()
vi.mock('electron', () => ({
  net: { request: (...args: any[]) => mockRequest(...args) },
}))

import { UpdateChecker } from '../../src/main/update/UpdateChecker'

/**
 * Configure the next net.request call to simulate a GitHub API response.
 * Mimics Electron's net.request API: returns an object with setHeader/on/end methods.
 */
function mockGitHubResponse(tagName: string, body = '', statusCode = 200) {
  const requestInstance = {
    setHeader: vi.fn(),
    on: vi.fn((event: string, cb: Function) => {
      if (event === 'response') {
        const response = {
          statusCode,
          on: vi.fn((ev: string, handler: Function) => {
            if (ev === 'data') {
              setTimeout(() => handler(Buffer.from(JSON.stringify({
                tag_name: tagName,
                html_url: 'https://github.com/jonsams968-cloud/onhands3/releases/latest',
                body,
              }))), 0)
            } else if (ev === 'end') {
              setTimeout(() => handler(), 5)
            }
          }),
        }
        setTimeout(() => cb(response), 0)
      }
    }),
    end: vi.fn(),
  }
  mockRequest.mockReturnValueOnce(requestInstance)
  return requestInstance
}

describe('UpdateChecker', () => {
  let checker: UpdateChecker

  beforeEach(() => {
    mockRequest.mockReset()
    checker = new UpdateChecker('0.5.1')
  })

  describe('version comparison', () => {
    it('detects newer version available', async () => {
      mockGitHubResponse('v0.6.0')
      const result = await checker.check()
      expect(result).not.toBeNull()
      expect(result!.hasUpdate).toBe(true)
      expect(result!.latestVersion).toBe('0.6.0')
      expect(result!.currentVersion).toBe('0.5.1')
    })

    it('detects same version (no update)', async () => {
      mockGitHubResponse('v0.5.1')
      const result = await checker.check()
      expect(result!.hasUpdate).toBe(false)
      expect(result!.latestVersion).toBe('0.5.1')
    })

    it('detects older remote version (no update, dev environment)', async () => {
      mockGitHubResponse('v0.5.0')
      const result = await checker.check()
      expect(result!.hasUpdate).toBe(false)
    })

    it('handles tag without "v" prefix', async () => {
      mockGitHubResponse('0.6.0')
      const result = await checker.check()
      expect(result!.latestVersion).toBe('0.6.0')
      expect(result!.hasUpdate).toBe(true)
    })

    it('handles pre-release suffix (strips it)', async () => {
      mockGitHubResponse('v0.6.0-beta')
      const result = await checker.check()
      expect(result!.latestVersion).toBe('0.6.0')
    })

    it('handles major version bump', async () => {
      mockGitHubResponse('v1.0.0')
      const result = await checker.check()
      expect(result!.hasUpdate).toBe(true)
    })

    it('handles minor version bump', async () => {
      mockGitHubResponse('v0.6.0')
      const result = await checker.check()
      expect(result!.hasUpdate).toBe(true)
    })

    it('handles patch version bump', async () => {
      mockGitHubResponse('v0.5.2')
      const result = await checker.check()
      expect(result!.hasUpdate).toBe(true)
    })

    it('returns null on invalid tag', async () => {
      mockGitHubResponse('not-a-version')
      const result = await checker.check()
      expect(result).toBeNull()
    })

    it('exposes release notes in result', async () => {
      mockGitHubResponse('v0.6.0', '## New features\n- Better STT')
      const result = await checker.check()
      expect(result!.releaseNotes).toContain('Better STT')
    })

    it('caches last result via getCachedResult', async () => {
      mockGitHubResponse('v0.6.0')
      await checker.check()
      const cached = checker.getCachedResult()
      expect(cached).not.toBeNull()
      expect(cached!.latestVersion).toBe('0.6.0')
    })
  })

  describe('error handling', () => {
    it('returns null when API returns 404 (no releases yet)', async () => {
      mockGitHubResponse('', '', 404)
      const result = await checker.check()
      expect(result).toBeNull()
    })

    it('getCachedResult returns null before any check', () => {
      expect(checker.getCachedResult()).toBeNull()
    })
  })
})
