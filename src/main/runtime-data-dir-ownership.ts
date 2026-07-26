import { execFileSync } from 'node:child_process'

type ProcessCommand = {
  pid: number
  command: string
}

function comparableCommand(value: string, platform: NodeJS.Platform): string {
  const normalized = value.replace(/\\/g, '/')
  return platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized
}

export function commandUsesKunDataDir(
  command: string,
  dataDir: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  const comparable = comparableCommand(command, platform)
  const comparableDataDir = comparableCommand(dataDir, platform)
  let flagIndex = comparable.indexOf('--data-dir')
  while (flagIndex >= 0) {
    const valueStart = comparable.indexOf(
      comparableDataDir,
      flagIndex + '--data-dir'.length
    )
    if (valueStart < 0) return false
    const between = comparable.slice(flagIndex + '--data-dir'.length, valueStart)
    const after = comparable[valueStart + comparableDataDir.length]
    if (
      /^(?:=|\s)+["']?$/.test(between) &&
      (after === undefined || /[\s"']/.test(after))
    ) {
      return true
    }
    flagIndex = comparable.indexOf('--data-dir', flagIndex + '--data-dir'.length)
  }
  return false
}

function posixProcessCommands(): ProcessCommand[] {
  const stdout = execFileSync('ps', ['-axo', 'pid=,command='], {
    encoding: 'utf8',
    timeout: 5_000,
    maxBuffer: 16 * 1024 * 1024
  })
  const commands: ProcessCommand[] = []
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(.+)$/)
    if (!match) continue
    const pid = Number(match[1])
    if (Number.isSafeInteger(pid) && pid > 0) {
      commands.push({ pid, command: match[2] })
    }
  }
  return commands
}

function windowsProcessCommands(): ProcessCommand[] {
  const stdout = execFileSync(
    'powershell',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress'
    ],
    {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 8_000,
      maxBuffer: 32 * 1024 * 1024
    }
  ).trim()
  if (!stdout) return []
  const parsed = JSON.parse(stdout) as
    | { ProcessId?: unknown; CommandLine?: unknown }
    | Array<{ ProcessId?: unknown; CommandLine?: unknown }>
  const rows = Array.isArray(parsed) ? parsed : [parsed]
  return rows.flatMap((row) => {
    const pid = Number(row.ProcessId)
    return Number.isSafeInteger(pid) && pid > 0 && typeof row.CommandLine === 'string'
      ? [{ pid, command: row.CommandLine }]
      : []
  })
}

export function activeKunRuntimePidsForDataDir(
  dataDir: string,
  options: {
    platform?: NodeJS.Platform
    processCommands?: () => ProcessCommand[]
  } = {}
): number[] {
  const platform = options.platform ?? process.platform
  const commands = options.processCommands
    ? options.processCommands()
    : platform === 'win32'
      ? windowsProcessCommands()
      : posixProcessCommands()
  return commands
    .filter(({ pid, command }) =>
      pid !== process.pid && commandUsesKunDataDir(command, dataDir, platform))
    .map(({ pid }) => pid)
}

export function assertNoActiveKunRuntimeUsingDataDir(
  dataDir: string,
  options: {
    platform?: NodeJS.Platform
    processCommands?: () => ProcessCommand[]
  } = {}
): void {
  const pids = activeKunRuntimePidsForDataDir(dataDir, options)
  if (pids.length === 0) return
  throw new Error(
    `an active Kun Runtime still owns the legacy data directory (pid${pids.length === 1 ? '' : 's'} ${pids.join(', ')})`
  )
}
