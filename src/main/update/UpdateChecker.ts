/**
 * Lightweight update checker — polls GitHub Releases for the latest version.
 *
 * Design:
 * - No electron-updater dependency (we don't auto-download/install)
 * - Just compares the latest release tag against app.getVersion()
 * - User clicks "下载新版" → opens browser to the release page
 *
 * The check is best-effort: network failures are silent. We don't want to
 * nag users about updates if GitHub is unreachable.
 */

import { net } from 'electron'
import type { UpdateStatus } from '../../shared/types'

/**
 * Parse "v0.5.1" / "0.5.1" / "0.5.1-beta" into [major, minor, patch].
 * Returns null if the string isn't a recognizable X.Y.Z version.
 * Pre-release suffixes are stripped (we treat 1.0.0-beta same as 1.0.0).
 */
function parseVersion(raw: string): [number, number, number] | null {
  const match = raw.match(/^v?(\d+)\.(\d+)\.(\d+)/)
  if (!match) return null
  return [parseInt(match[1]), parseInt(match[2]), parseInt(match[3])]
}

/** Returns true if `a` is strictly greater than `b`. */
function isVersionGreater(a: [number, number, number], b: [number, number, number]): boolean {
  return a[0] !== b[0] ? a[0] > b[0]
       : a[1] !== b[1] ? a[1] > b[1]
       :                a[2] > b[2]
}

const REPO = 'jonsams968-cloud/onhands3'
const API_URL = `https://api.github.com/repos/${REPO}/releases/latest`

export class UpdateChecker {
  private currentVersion: string
  private lastResult: UpdateStatus | null = null

  constructor(currentVersion: string) {
    this.currentVersion = currentVersion
  }

  /**
   * Poll GitHub for the latest release. Safe to call on startup.
   * Returns null if the check fails (network error, parse error, etc.)
   */
  async check(): Promise<UpdateStatus | null> {
    try {
      const body = await this.fetchJson(API_URL)
      if (!body || !body.tag_name) {
        console.warn('[update] No tag_name in release response')
        return null
      }

      // Strip leading 'v' from tag (e.g. "v0.5.1" → "0.5.1")
      const latestRaw = String(body.tag_name).replace(/^v/, '')
      const latest = parseVersion(latestRaw)
      if (!latest) {
        console.warn(`[update] Invalid semver from tag: ${body.tag_name}`)
        return null
      }

      const current = parseVersion(this.currentVersion)
      if (!current) {
        console.warn(`[update] Current version not semver: ${this.currentVersion}`)
        return null
      }

      const hasUpdate = isVersionGreater(latest, current)
      const latestStr = latest.join('.')
      const currentStr = current.join('.')
      this.lastResult = {
        hasUpdate,
        currentVersion: currentStr,
        latestVersion: latestStr,
        releaseUrl: body.html_url || `https://github.com/${REPO}/releases/latest`,
        releaseNotes: body.body || '',
        checkedAt: Date.now(),
      }
      console.log(`[update] current=${currentStr}, latest=${latestStr}, hasUpdate=${hasUpdate}`)
      return this.lastResult
    } catch (err) {
      console.warn(`[update] Check failed: ${err instanceof Error ? err.message : err}`)
      return null
    }
  }

  getCachedResult(): UpdateStatus | null {
    return this.lastResult
  }

  private fetchJson(url: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const request = net.request({
        url,
        redirect: 'follow',
      })
      request.setHeader('User-Agent', 'OnHands3-Update-Checker')
      request.setHeader('Accept', 'application/vnd.github+json')

      let data = ''
      request.on('response', (response) => {
        // GitHub API returns 404 for repos with no releases yet
        if (response.statusCode === 404) {
          console.log('[update] No releases yet (404)')
          resolve(null)
          return
        }
        if (response.statusCode !== 200) {
          reject(new Error(`HTTP ${response.statusCode}`))
          return
        }
        response.on('data', (chunk: Buffer) => { data += chunk.toString('utf8') })
        response.on('end', () => {
          try {
            resolve(JSON.parse(data))
          } catch (err) {
            reject(new Error('Invalid JSON'))
          }
        })
      })
      request.on('error', reject)
      request.end()
    })
  }
}
