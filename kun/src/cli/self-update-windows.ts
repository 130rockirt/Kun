import { spawn, type ChildProcess } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseTuiUpdateUpdater } from './self-update-transaction.js'

export type WindowsReplacementInput = {
  currentRoot: string
  nextRoot: string
  backupRoot: string
  stagingRoot: string
  transactionDir: string
  resultPath: string
  logPath: string
  lockPath: string
  scriptPath: string
  previousVersion: string
  targetVersion: string
  buildId: string
  target: string
  channel: string
  lockToken: string
  ackPath: string
  updaterStartedAt: string
  waitTimeoutMs?: number
}

const DEFAULT_WAIT_TIMEOUT_MS = 10 * 60 * 1_000
const WAIT_POLL_SECONDS = 2
const SWAP_MAX_ATTEMPTS = 5
const SWAP_RETRY_DELAY_SECONDS = 3
const DEFAULT_ACK_TIMEOUT_MS = 30_000
const ACK_POLL_MS = 200
const KILL_GRACE_MS = 5_000

function quote(value: string): string {
  return value.replaceAll("'", "''")
}

/**
 * Build the detached replacement script. Behavior contract (verified by unit
 * tests and the Windows integration suite):
 * - Every step is appended to the diagnostic log; the script never relies on
 *   inherited console output.
 * - The wait phase polls Win32_Process for any executable beneath the
 *   install root until none remain or the timeout expires. It deliberately
 *   avoids `Wait-Process -Id`: the launching pid may already be gone, and
 *   other Kun instances must be waited on as well.
 * - The swap retries Move-Item a bounded number of times so brief antivirus
 *   or indexer locks do not kill the update, and always restores the backup
 *   when the staged tree cannot be moved into place.
 * - The backup is only removed inside the branch where the current install
 *   root exists and is about to be moved into the backup slot, so a missing
 *   install root never causes the last healthy backup to be deleted.
 * - Activation verifies the staged release.json version, buildId, target, and
 *   channel before the success state is written; the backup is never cleaned
 *   before that verification.
 * - The terminal state is written atomically to update-result.json (temp file
 *   + FlushFileBuffers + rename) in every outcome; a write failure is a
 *   terminating error that never funnels into the failure branch.
 */
export function buildWindowsReplacementScript(input: WindowsReplacementInput): string {
  const waitTimeoutSeconds = Math.max(
    30,
    Math.ceil((input.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS) / 1_000)
  )
  const current = quote(input.currentRoot)
  const next = quote(input.nextRoot)
  const backup = quote(input.backupRoot)
  const staging = quote(input.stagingRoot)
  const result = quote(input.resultPath)
  const log = quote(input.logPath)
  const lock = quote(input.lockPath)
  const ack = quote(input.ackPath)
  const lockToken = quote(input.lockToken)
  const updaterStartedAt = quote(input.updaterStartedAt)
  const script = quote(input.scriptPath)
  const previousVersion = quote(input.previousVersion)
  const targetVersion = quote(input.targetVersion)
  const expectedBuildId = quote(input.buildId)
  const expectedTarget = quote(input.target)
  const expectedChannel = quote(input.channel)
  return [
    '$ErrorActionPreference = "Continue"',
    `$current = '${current}'`,
    `$next = '${next}'`,
    `$staging = '${staging}'`,
    `$backup = '${backup}'`,
    `$result = '${result}'`,
    `$log = '${log}'`,
    `$lock = '${lock}'`,
    `$ack = '${ack}'`,
    `$lockToken = '${lockToken}'`,
    `$updaterStartedAt = '${updaterStartedAt}'`,
    `$targetVersion = '${targetVersion}'`,
    `$expectedBuildId = '${expectedBuildId}'`,
    `$expectedTarget = '${expectedTarget}'`,
    `$expectedChannel = '${expectedChannel}'`,
    '$stage = "init"',
    'function Write-UpdateLog([string]$Message) {',
    '  $stamp = (Get-Date).ToUniversalTime().ToString("o")',
    '  Add-Content -LiteralPath $log -Value ($stamp + " " + $Message) -Encoding utf8',
    '}',
    'function Write-UpdateResult([string]$Status, [string]$Stage, [string]$Reason) {',
    '  $payload = [ordered]@{',
    '    schemaVersion = 1',
    '    status = $Status',
    `    previousVersion = '${previousVersion}'`,
    `    targetVersion = '${targetVersion}'`,
    '    stage = $Stage',
    '    error = $Reason',
    '    finishedAt = (Get-Date).ToUniversalTime().ToString("o")',
    '  }',
    '  try {',
    '    $resultTmp = $result + ".tmp-" + $PID',
    '    $resultJson = $payload | ConvertTo-Json -Compress',
    '    $resultBytes = [System.Text.Encoding]::UTF8.GetBytes($resultJson)',
    '    $fs = [System.IO.File]::Open($resultTmp, "Create", "Write", "None")',
    '    try {',
    '      $fs.Write($resultBytes, 0, $resultBytes.Length)',
    '      $fs.Flush($true)',
    '    } finally {',
    '      $fs.Dispose()',
    '    }',
    '    Move-Item -LiteralPath $resultTmp -Destination $result -Force -ErrorAction Stop',
    '  } catch {',
    "    Write-UpdateLog ('result write failed: ' + $_.Exception.GetType().Name + ': ' + $_.Exception.Message)",
    '    exit 1',
    '  }',
    '}',
    "  $stage = 'handoff'",
    '  $takeoverOk = $false',
    '  try {',
    '    $processIdentity = "win32-v1:" + (Get-CimInstance Win32_Process -Filter "ProcessId = $PID").CreationDate.ToUniversalTime().ToString("O")',
    '    $lockPayload = [ordered]@{',
    '      schemaVersion = 1',
    '      pid = $PID',
    '      token = $lockToken',
    '      startedAt = $updaterStartedAt',
    '      processIdentity = $processIdentity',
    '      root = $current',
    '    }',
    '    $lockTmp = $lock + ".tmp-" + $PID',
    '    $lockPayload | ConvertTo-Json -Compress | Set-Content -LiteralPath $lockTmp -Encoding utf8 -ErrorAction Stop',
    '    Move-Item -LiteralPath $lockTmp -Destination $lock -Force -ErrorAction Stop',
    '    $ackPayload = [ordered]@{',
    '      schemaVersion = 1',
    '      token = $lockToken',
    '      pid = $PID',
    '      processIdentity = $processIdentity',
    '      startedAt = $updaterStartedAt',
    '    }',
    '    $ackPayload | ConvertTo-Json -Compress | Set-Content -LiteralPath $ack -Encoding utf8 -ErrorAction Stop',
    '    $takeoverOk = $true',
    '  } catch {',
    "    Write-UpdateLog ('lock handoff failed: ' + $_.Exception.GetType().Name + ': ' + $_.Exception.Message)",
    '  }',
    '  if (-not $takeoverOk) { exit 1 }',
    'try {',
    "  Write-UpdateLog ('update staged for ' + $current)",
    "  $stage = 'wait'",
    '  $deadline = (Get-Date).AddSeconds(' + String(waitTimeoutSeconds) + ')',
    '  for (;;) {',
    "    $prefix = $current.TrimEnd('\\') + '\\'",
    '    $occupants = @(',
    '      Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |',
    '        Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) }',
    '    )',
    '    if ($occupants.Count -eq 0) { break }',
    '    if ((Get-Date) -ge $deadline) {',
    "      $names = ($occupants | Select-Object -First 3 -ExpandProperty Name) -join ', '",
    '      throw "install root is still occupied after ' + String(waitTimeoutSeconds) + 's: $names"',
    '    }',
    "    Write-UpdateLog ('waiting for ' + $occupants.Count + ' Kun process(es) to exit')",
    '    Start-Sleep -Seconds ' + String(WAIT_POLL_SECONDS),
    '  }',
    "  Write-UpdateLog 'install root is free; starting replacement'",
    "  $stage = 'swap'",
    '  $attempt = 0',
    '  $swapped = $false',
    '  while (-not $swapped -and $attempt -lt ' + String(SWAP_MAX_ATTEMPTS) + ') {',
    '    $attempt += 1',
    "    Write-UpdateLog ('replacement attempt ' + $attempt)",
    '    try {',
    "      $stage = 'swap-prepare'",
    "      if (-not (Test-Path -LiteralPath $next)) { throw 'the staged release is missing' }",
    '      if (Test-Path -LiteralPath $current) {',
    "        $stage = 'swap-backup'",
    '        if (Test-Path -LiteralPath $backup) {',
    '          Remove-Item -LiteralPath $backup -Recurse -Force -ErrorAction Stop',
    '        }',
    '        Move-Item -LiteralPath $current -Destination $backup -ErrorAction Stop',
    '      } elseif (Test-Path -LiteralPath $backup) {',
    "        $stage = 'swap-restore'",
    "        Write-UpdateLog 'install root is missing; restoring the backup before retrying'",
    '        Move-Item -LiteralPath $backup -Destination $current -ErrorAction Stop',
    "        throw 'backup restored; retrying activation'",
    '      }',
    "      $stage = 'swap-activate'",
    '      try {',
    '        Move-Item -LiteralPath $next -Destination $current -ErrorAction Stop',
    "        $stage = 'swap-verify'",
    "        $release = Get-Content -LiteralPath (Join-Path $current 'release.json') -Raw | ConvertFrom-Json",
    '        if ($release.version -ne $targetVersion -or $release.buildId -ne $expectedBuildId -or $release.target -ne $expectedTarget -or $release.channel -ne $expectedChannel) {',
    "          throw 'activated release.json does not match the staged release'",
    '        }',
    '      } catch {',
    '        if (Test-Path -LiteralPath $backup) {',
    '          if (Test-Path -LiteralPath $current) {',
    '            Remove-Item -LiteralPath $current -Recurse -Force -ErrorAction Stop',
    '          }',
    '          Move-Item -LiteralPath $backup -Destination $current -ErrorAction Stop',
    '        }',
    '        throw',
    '      }',
    '      $swapped = $true',
    '    } catch {',
    '      if (-not $swapped -and -not (Test-Path -LiteralPath $current) -and (Test-Path -LiteralPath $backup)) {',
    '        Move-Item -LiteralPath $backup -Destination $current -ErrorAction SilentlyContinue',
    '      }',
    '      if ($attempt -lt ' + String(SWAP_MAX_ATTEMPTS) + ') {',
    "        Write-UpdateLog ('attempt failed; retrying: ' + $_.Exception.GetType().Name)",
    '        Start-Sleep -Seconds ' + String(SWAP_RETRY_DELAY_SECONDS),
    '      }',
    '    }',
    '  }',
    "  if (-not $swapped) { throw 'replacement failed after " + String(SWAP_MAX_ATTEMPTS) + " attempts' }",
    "  $stage = 'finalize'",
    "  Set-Content -LiteralPath (Join-Path $current '.updated-from') -Value '" + previousVersion + "' -Encoding ascii",
    "  Write-UpdateResult 'succeeded' $stage ''",
    "  Write-UpdateLog 'replacement succeeded'",
    '  if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue }',
    '} catch {',
    "  $reason = $_.Exception.GetType().Name + ': ' + ($_.Exception.Message -replace [regex]::Escape($current), '<install>')",
    "  Write-UpdateLog ('update failed at ' + $stage + ': ' + $reason)",
    "  Write-UpdateResult 'failed' $stage $reason",
    '}',
    'Remove-Item -LiteralPath $lock -Force -ErrorAction SilentlyContinue',
    "Remove-Item -LiteralPath '" + script + "' -Force -ErrorAction SilentlyContinue",
    ''
  ].join('\r\n')
}

/** The detached updater did not confirm lock handoff within the ack window. */
export class WindowsReplacementHandoffError extends Error {
  readonly lockTakenOver: boolean
  constructor(message: string, lockTakenOver: boolean) {
    super(message)
    this.name = 'WindowsReplacementHandoffError'
    this.lockTakenOver = lockTakenOver
  }
}

function childExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null
}

async function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (!childExited(child)) {
    if (Date.now() >= deadline) return false
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50))
  }
  return true
}

/**
 * Launch the hidden detached replacement script, then wait for it to atomically
 * take over the update lock and write its acknowledgement. The caller keeps the
 * lock until this handoff completes: on success the lock is owned by the
 * updater from here on, and on failure the caller decides whether it may still
 * release the lock based on whether the updater survived.
 */
export async function scheduleWindowsReplacement(
  input: Omit<WindowsReplacementInput, 'scriptPath'> & {
    scriptPath?: string
    ackTimeoutMs?: number
    killGraceMs?: number
  }
): Promise<{ pid: number; processIdentity?: string; startedAt: string }> {
  const scriptPath = input.scriptPath ?? join(input.transactionDir, 'apply-update.ps1')
  const script = buildWindowsReplacementScript({ ...input, scriptPath })
  await writeFile(scriptPath, script, 'utf8')
  let spawnFailed = false
  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
    { detached: true, stdio: 'ignore', windowsHide: true }
  )
  child.once('error', () => { spawnFailed = true })
  child.unref()
  const deadline = Date.now() + (input.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS)
  for (;;) {
    const raw = await readFile(input.ackPath, 'utf8').catch(() => '')
    if (raw) {
      const parsed = parseTuiUpdateUpdater(raw)
      if (parsed && parsed.token === input.lockToken && parsed.pid === child.pid) {
        return {
          pid: child.pid as number,
          processIdentity: parsed.processIdentity,
          startedAt: input.updaterStartedAt
        }
      }
    }
    if (spawnFailed || Date.now() >= deadline) break
    await new Promise((resolvePromise) => setTimeout(resolvePromise, ACK_POLL_MS))
  }
  child.kill()
  const stopped = await waitForChildExit(child, input.killGraceMs ?? KILL_GRACE_MS)
  if (spawnFailed || stopped) {
    throw new WindowsReplacementHandoffError(
      'the detached updater did not confirm lock handoff and was stopped',
      false
    )
  }
  throw new WindowsReplacementHandoffError(
    'the detached updater did not confirm lock handoff and could not be stopped',
    true
  )
}
