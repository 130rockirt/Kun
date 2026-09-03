import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
  execFileSync: vi.fn()
}))

import { spawn } from 'node:child_process'
import {
  buildWindowsReplacementScript,
  scheduleWindowsReplacement,
  WindowsReplacementHandoffError
} from './self-update-windows.js'

function input(overrides: Partial<Parameters<typeof buildWindowsReplacementScript>[0]> = {}) {
  return {
    currentRoot: 'C:\\Users\\me\\AppData\\Local\\KunTui\\kun',
    nextRoot: 'C:\\Users\\me\\AppData\\Local\\KunTui\\.kun-update-ab12\\kun',
    backupRoot: 'C:\\Users\\me\\AppData\\Local\\KunTui\\kun.previous',
    stagingRoot: 'C:\\Users\\me\\AppData\\Local\\KunTui\\.kun-update-ab12',
    transactionDir: 'C:\\Users\\me\\AppData\\Local\\KunTui\\.kun.kun-tui-update',
    resultPath: 'C:\\Users\\me\\AppData\\Local\\KunTui\\.kun.kun-tui-update\\update-result.json',
    logPath: 'C:\\Users\\me\\AppData\\Local\\KunTui\\.kun.kun-tui-update\\update.log',
    lockPath: 'C:\\Users\\me\\AppData\\Local\\KunTui\\.kun.kun-tui-update.lock',
    scriptPath: 'C:\\Users\\me\\AppData\\Local\\KunTui\\.kun.kun-tui-update\\apply-update.ps1',
    previousVersion: '1.2.3',
    targetVersion: '1.2.4',
    buildId: 'a'.repeat(64),
    target: 'win32-x64',
    channel: 'stable',
    lockToken: 'test-lock-token',
    ackPath: 'C:\\Users\\me\\AppData\\Local\\KunTui\\.kun.kun-tui-update\\updater.json',
    updaterStartedAt: '2026-09-03T00:00:00.000Z',
    ...overrides
  }
}

describe('Windows replacement script', () => {
  it('waits on every process below the install root instead of a single pid', () => {
    const script = buildWindowsReplacementScript(input())
    expect(script).toContain('Get-CimInstance Win32_Process')
    expect(script).toContain('StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)')
    expect(script).toContain("$prefix = $current.TrimEnd('\\') + '\\'")
    expect(script).not.toContain('Wait-Process')
    expect(script).toContain('Start-Sleep -Seconds 2')
    expect(script).toContain('AddSeconds(600)')
  })

  it('honors a custom wait timeout', () => {
    const script = buildWindowsReplacementScript(input({ waitTimeoutMs: 45_000 }))
    expect(script).toContain('AddSeconds(45)')
  })

  it('retries the swap with backup restore on failure', () => {
    const script = buildWindowsReplacementScript(input())
    expect(script).toContain('while (-not $swapped -and $attempt -lt 5)')
    expect(script).toContain('Move-Item -LiteralPath $current -Destination $backup -ErrorAction Stop')
    expect(script).toContain('Move-Item -LiteralPath $next -Destination $current -ErrorAction Stop')
    expect(script).toContain('Move-Item -LiteralPath $backup -Destination $current -ErrorAction Stop')
    expect(script).toContain('Start-Sleep -Seconds 3')
    expect(script).toContain('replacement failed after 5 attempts')
    expect(script).toContain('Remove-Item -LiteralPath $backup -Recurse -Force -ErrorAction Stop')
    expect(script).toContain('install root is missing; restoring the backup before retrying')
    expect(script).toContain('the staged release is missing')
    expect(script).toContain('activated release.json does not match the staged release')
  })

  it('marks each swap phase as a diagnostic stage', () => {
    const script = buildWindowsReplacementScript(input())
    expect(script).toContain("$stage = 'swap-prepare'")
    expect(script).toContain("$stage = 'swap-backup'")
    expect(script).toContain("$stage = 'swap-restore'")
    expect(script).toContain("$stage = 'swap-activate'")
    expect(script).toContain("$stage = 'swap-verify'")
  })

  it('removes the backup only after confirming the install root exists', () => {
    const script = buildWindowsReplacementScript(input())
    const backupRemoval = script.indexOf('Remove-Item -LiteralPath $backup -Recurse -Force -ErrorAction Stop')
    const currentCheck = script.indexOf('if (Test-Path -LiteralPath $current) {')
    const stagedGuard = script.indexOf('the staged release is missing')
    expect(backupRemoval).toBeGreaterThan(-1)
    expect(currentCheck).toBeGreaterThan(-1)
    expect(stagedGuard).toBeGreaterThan(-1)
    expect(stagedGuard).toBeLessThan(backupRemoval)
    expect(currentCheck).toBeLessThan(backupRemoval)
  })

  it('writes update-result.json in both outcomes and appends a diagnostic log', () => {
    const script = buildWindowsReplacementScript(input())
    expect(script).toContain("Write-UpdateResult 'succeeded' $stage ''")
    expect(script).toContain("Write-UpdateResult 'failed' $stage $reason")
    expect(script).toContain('Add-Content -LiteralPath $log')
    expect(script).toContain('$resultJson = $payload | ConvertTo-Json -Compress')
    expect(script).toContain('$fs.Flush($true)')
    expect(script).toContain('Move-Item -LiteralPath $resultTmp -Destination $result -Force -ErrorAction Stop')
  })

  it('embeds and verifies the staged buildId, target, and channel', () => {
    const script = buildWindowsReplacementScript(input())
    const buildId = 'a'.repeat(64)
    expect(script).toContain(`$expectedBuildId = '${buildId}'`)
    expect(script).toContain("$expectedTarget = 'win32-x64'")
    expect(script).toContain("$expectedChannel = 'stable'")
    expect(script).toContain(
      '$release.version -ne $targetVersion -or $release.buildId -ne $expectedBuildId -or $release.target -ne $expectedTarget -or $release.channel -ne $expectedChannel'
    )
  })

  it('records wait and swap stages for diagnostics', () => {
    const script = buildWindowsReplacementScript(input())
    expect(script).toContain("$stage = 'wait'")
    expect(script).toContain("$stage = 'swap'")
    expect(script).toContain("$stage = 'finalize'")
    expect(script).toContain('waiting for ')
  })

  it('keeps the .updated-from marker for compatibility', () => {
    const script = buildWindowsReplacementScript(input())
    expect(script).toContain("Join-Path $current '.updated-from'")
    expect(script).toContain("-Value '1.2.3' -Encoding ascii")
  })

  it('sanitizes the install path out of recorded errors', () => {
    const script = buildWindowsReplacementScript(input())
    expect(script).toContain('[regex]::Escape($current)')
    expect(script).toContain("'<install>'")
  })

  it('removes the staging tree, the update lock, and the script itself on completion', () => {
    const script = buildWindowsReplacementScript(input())
    expect(script).toContain('Remove-Item -LiteralPath $staging -Recurse -Force')
    expect(script).toContain('Remove-Item -LiteralPath $lock -Force -ErrorAction SilentlyContinue')
    expect(script).toContain('apply-update.ps1')
  })

  it('uses CRLF line endings', () => {
    const script = buildWindowsReplacementScript(input())
    expect(script).toContain('\r\n')
    expect(script.replaceAll('\r\n', '')).not.toContain('\r')
    expect(script.replaceAll('\r\n', '')).not.toContain('\n')
  })

  it('escapes single quotes in every interpolated path', () => {
    const quoted = buildWindowsReplacementScript(input({
      currentRoot: "C:\\Install's\\kun",
      logPath: "C:\\Install's\\update.log"
    }))
    expect(quoted).toContain("$current = 'C:\\Install''s\\kun'")
    expect(quoted).toContain("$log = 'C:\\Install''s\\update.log'")
  })

  it('takes over the lock and writes an ack before entering the wait phase', () => {
    const script = buildWindowsReplacementScript(input())
    expect(script).toContain(
      '$processIdentity = "win32-v1:" + (Get-CimInstance Win32_Process -Filter "ProcessId = $PID").CreationDate.ToUniversalTime().ToString("O")'
    )
    expect(script).toContain("$lockToken = 'test-lock-token'")
    expect(script).toContain("$updaterStartedAt = '2026-09-03T00:00:00.000Z'")
    expect(script).toContain('Move-Item -LiteralPath $lockTmp -Destination $lock -Force -ErrorAction Stop')
    expect(script).toContain('Set-Content -LiteralPath $lockTmp -Encoding utf8 -ErrorAction Stop')
    expect(script).toContain('Set-Content -LiteralPath $ack -Encoding utf8 -ErrorAction Stop')
    expect(script).toContain('root = $current')
    expect(script).toContain('processIdentity = $processIdentity')
    expect(script).toContain('if (-not $takeoverOk) { exit 1 }')
    // The handoff runs before the wait/swap phase and still cleans the lock.
    expect(script.indexOf('if (-not $takeoverOk)')).toBeGreaterThan(-1)
    expect(script.indexOf('if (-not $takeoverOk)')).toBeLessThan(script.indexOf("$stage = 'wait'"))
    expect(script).toContain('Remove-Item -LiteralPath $lock -Force -ErrorAction SilentlyContinue')
  })

  it('aborts before the wait phase when the lock takeover fails', () => {
    const script = buildWindowsReplacementScript(input())
    const handoff = script.indexOf('if (-not $takeoverOk) { exit 1 }')
    const wait = script.indexOf("$stage = 'wait'")
    expect(handoff).toBeGreaterThan(-1)
    expect(handoff).toBeLessThan(wait)
    // Failure exits the process instead of falling through to the swap loop.
    expect(script.indexOf('exit 1')).toBeLessThan(wait)
  })
})

describe('Windows replacement scheduling', () => {
  it('reports a stopped updater with no lock takeover when the ack never arrives', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kun-win-ack-test-'))
    const transactionDir = join(dir, 'txn')
    await mkdir(transactionDir, { recursive: true })
    const ackPath = join(transactionDir, 'updater.json')
    const child = {
      pid: 99999,
      exitCode: null as number | null,
      signalCode: null as string | null,
      kill: () => {
        child.exitCode = 1
        return true
      },
      unref: () => undefined,
      once: () => undefined
    }
    vi.mocked(spawn).mockReturnValue(child as never)
    try {
      const error = await scheduleWindowsReplacement({
        currentRoot: join(dir, 'kun'),
        nextRoot: join(dir, 'next', 'kun'),
        backupRoot: join(dir, 'kun.previous'),
        stagingRoot: join(dir, 'next'),
        transactionDir,
        resultPath: join(transactionDir, 'update-result.json'),
        logPath: join(transactionDir, 'update.log'),
        lockPath: join(dir, 'kun.lock'),
        previousVersion: '1.2.3',
        targetVersion: '1.2.4',
        buildId: 'a'.repeat(64),
        target: 'win32-x64',
        channel: 'stable',
        lockToken: 'token',
        ackPath,
        updaterStartedAt: new Date().toISOString(),
        ackTimeoutMs: 50
      }).catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(WindowsReplacementHandoffError)
      expect((error as WindowsReplacementHandoffError).lockTakenOver).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('reports a surviving updater as having taken over the lock when it cannot be stopped', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kun-win-ack-test-'))
    const transactionDir = join(dir, 'txn')
    await mkdir(transactionDir, { recursive: true })
    const ackPath = join(transactionDir, 'updater.json')
    const child = {
      pid: 99999,
      exitCode: null as number | null,
      signalCode: null as string | null,
      kill: () => false,
      unref: () => undefined,
      once: () => undefined
    }
    vi.mocked(spawn).mockReturnValue(child as never)
    try {
      const error = await scheduleWindowsReplacement({
        currentRoot: join(dir, 'kun'),
        nextRoot: join(dir, 'next', 'kun'),
        backupRoot: join(dir, 'kun.previous'),
        stagingRoot: join(dir, 'next'),
        transactionDir,
        resultPath: join(transactionDir, 'update-result.json'),
        logPath: join(transactionDir, 'update.log'),
        lockPath: join(dir, 'kun.lock'),
        previousVersion: '1.2.3',
        targetVersion: '1.2.4',
        buildId: 'a'.repeat(64),
        target: 'win32-x64',
        channel: 'stable',
        lockToken: 'token',
        ackPath,
        updaterStartedAt: new Date().toISOString(),
        ackTimeoutMs: 50,
        killGraceMs: 50
      }).catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(WindowsReplacementHandoffError)
      expect((error as WindowsReplacementHandoffError).lockTakenOver).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
