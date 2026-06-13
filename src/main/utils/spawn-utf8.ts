/**
 * Centralized UTF-8 spawn utilities for Windows.
 *
 * Windows has three independent encoding layers that can cause mojibake:
 *   1. OEM Code Page  — console stdin/stdout (chcp, default 936=GBK on Chinese Windows)
 *   2. ANSI Code Page — Win32 -A APIs (CreateFileA, argv parsing)
 *   3. .NET/PS        — PowerShell $OutputEncoding, [Console]::OutputEncoding, [Console]::InputEncoding
 *
 * This module ensures every child process speaks UTF-8 end-to-end:
 *   - Environment variables force Python, Node, Git, and locale tools to use UTF-8
 *   - setEncoding('utf8') on the Node side decodes stdout/stderr correctly
 *   - PowerShell prefix sets all three PS encoding variables in one shot
 *
 * References:
 *   - https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_character_encoding
 *   - https://github.com/PowerShell/PowerShell/issues/4681
 *   - https://github.com/anthropics/claude-code/issues/46486
 *   - https://github.com/google-gemini/gemini-cli/pull/20769
 */

import { spawn, execFile, ChildProcess, SpawnOptions, ExecFileOptions } from 'child_process'

// ─── Environment variable patch ───────────────────────────────────────────────

/**
 * Spread into any child process env to force UTF-8 throughout the process tree.
 * Covers Python, Node, Git, and POSIX locale tools.
 */
export const UTF8_ENV = {
  PYTHONIOENCODING: 'utf-8',      // Python stdin/stdout/stderr encoding
  PYTHONUTF8: '1',                 // Python 3.7+ UTF-8 mode (broader than PYTHONIOENCODING)
  LANG: 'en_US.UTF-8',            // POSIX locale — affects bash, grep, sort, etc.
  LC_ALL: 'en_US.UTF-8',          // Override all LC_* categories
  LESSCHARSET: 'utf-8',           // Git log pager (less) encoding
}

// ─── PowerShell UTF-8 prefix ──────────────────────────────────────────────────

/**
 * One-liner that sets all three PowerShell encoding variables to UTF-8 (no BOM).
 *
 * - $OutputEncoding         → what PS sends to external programs via pipe
 * - [Console]::OutputEncoding → what PS uses to decode external program output
 * - [Console]::InputEncoding  → what PS uses to decode stdin
 *
 * Prepend this to any PowerShell -Command string.
 *
 * NOTE: `chcp 65001` inside PowerShell is ineffective — .NET caches the console
 * encoding at startup. This prefix is the correct approach.
 */
export const PS_UTF8_PREFIX =
  "$OutputEncoding=[Console]::InputEncoding=[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding;"

// ─── Spawn helpers ────────────────────────────────────────────────────────────

/**
 * Spawn a child process with full UTF-8 support.
 * - Injects UTF8_ENV into the process environment
 * - Sets stdout/stderr to decode as UTF-8 strings
 * - Hides the console window on Windows
 */
export function spawnUtf8(
  command: string,
  args: string[],
  options?: Partial<SpawnOptions>,
): ChildProcess {
  const opts: SpawnOptions = {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, ...UTF8_ENV },
    ...options,
  }

  const child = spawn(command, args, opts)

  // Explicitly set encoding so 'data' events emit strings, not Buffers
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')

  return child
}

/**
 * Execute a PowerShell command with guaranteed UTF-8 I/O.
 * Automatically prepends the UTF-8 encoding prefix.
 */
export function spawnPowerShellUtf8(
  psCommand: string,
  options?: Partial<SpawnOptions>,
): ChildProcess {
  const fullCommand = PS_UTF8_PREFIX + psCommand
  return spawnUtf8('powershell.exe', [
    '-NoProfile',        // Skip user profile for speed & purity
    '-NonInteractive',   // Don't load PSReadLine (has Unicode issues)
    '-Command',
    fullCommand,
  ], options)
}

/**
 * execFile with UTF-8 encoding option.
 * Use for simple command→output cases (ffmpeg, whisper-cli, etc.)
 */
export function execFileUtf8(
  command: string,
  args: string[],
  options?: Partial<ExecFileOptions>,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const opts: ExecFileOptions = {
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
      encoding: 'utf8',     // Node decodes child output as UTF-8
      env: { ...process.env, ...UTF8_ENV },
      ...options,
    }

    execFile(command, args, opts, (err, stdout, stderr) => {
      const outText = typeof stdout === 'string' ? stdout : ''
      const errText = typeof stderr === 'string' ? stderr : ''
      if (err) reject(new Error(errText || err.message))
      else resolve({ stdout: outText.trim(), stderr: errText.trim() })
    })
  })
}
