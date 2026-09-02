import { spawn } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

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
  waitTimeoutMs?: number
}

const DEFAULT_WAIT_TIMEOUT_MS = 10 * 60 * 1_000
const WAIT_POLL_SECONDS = 2
const SWAP_MAX_ATTEMPTS = 5
const SWAP_RETRY_DELAY_SECONDS = 3

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
 * - The terminal state is written to update-result.json in every outcome.
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
  const script = quote(input.scriptPath)
  const previousVersion = quote(input.previousVersion)
  const targetVersion = quote(input.targetVersion)
  return [
    '$ErrorActionPreference = "Continue"',
    `$current = '${current}'`,
    `$next = '${next}'`,
    `$staging = '${staging}'`,
    `$backup = '${backup}'`,
    `$result = '${result}'`,
    `$log = '${log}'`,
    `$lock = '${lock}'`,
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
    '  $payload | ConvertTo-Json -Compress | Set-Content -LiteralPath $result -Encoding utf8',
    '}',
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
    '      if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Recurse -Force }',
    '      Move-Item -LiteralPath $current -Destination $backup -ErrorAction Stop',
    '      try {',
    '        Move-Item -LiteralPath $next -Destination $current -ErrorAction Stop',
    '        $swapped = $true',
    '      } catch {',
    "        Write-UpdateLog ('staged move failed; restoring backup: ' + $_.Exception.GetType().Name)",
    '        if (Test-Path -LiteralPath $current) { Remove-Item -LiteralPath $current -Recurse -Force }',
    '        Move-Item -LiteralPath $backup -Destination $current -ErrorAction Stop',
    '        throw',
    '      }',
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

/** Launch the hidden detached replacement script after writing it to disk. */
export async function scheduleWindowsReplacement(
  input: Omit<WindowsReplacementInput, 'scriptPath'> & { scriptPath?: string }
): Promise<void> {
  const scriptPath = input.scriptPath ?? join(input.transactionDir, 'apply-update.ps1')
  const script = buildWindowsReplacementScript({ ...input, scriptPath })
  await writeFile(scriptPath, script, 'utf8')
  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
    { detached: true, stdio: 'ignore', windowsHide: true }
  )
  child.unref()
}
