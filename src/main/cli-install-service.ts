import {
  app,
  dialog,
  type BrowserWindow,
  type IpcMain,
  type MessageBoxOptions
} from 'electron'
import { execFile } from 'node:child_process'
import {
  appendFile,
  chmod,
  lstat,
  mkdir,
  readFile,
  readlink,
  unlink,
  writeFile
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import type {
  CliInstallAction,
  CliInstallResult,
  CliInstallStatus
} from '../shared/cli-install'

const execFileAsync = promisify(execFile)
const LINUX_MARKER = '# Kun CLI launcher — managed by Kun'
const PATH_BLOCK_START = '# >>> Kun CLI >>>'
const PATH_BLOCK_END = '# <<< Kun CLI <<<'

export function registerCliInstallIpc(ipcMain: IpcMain): void {
  ipcMain.handle('cli-install:status', () => cliInstallStatus())
  ipcMain.handle('cli-install:action', (_event, action: CliInstallAction) =>
    runCliInstallAction(action)
  )
}

export async function maybePromptCliInstall(getWindow: () => BrowserWindow | null): Promise<void> {
  if (!app.isPackaged || (process.platform !== 'darwin' && process.platform !== 'linux')) return
  const marker = join(app.getPath('userData'), '.cli-install-prompted')
  try {
    await lstat(marker)
    return
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') return
  }
  const status = await cliInstallStatus()
  if (status.state === 'installed' || status.state === 'conflict') return
  await writeFile(marker, `${new Date().toISOString()}\n`, { mode: 0o600 }).catch(() => undefined)
  const parent = getWindow()
  const options: MessageBoxOptions = {
    type: 'question',
    title: 'Install Kun terminal command',
    message: 'Use Kun from your terminal?',
    detail: 'Install the `kun` command so a new terminal can open the Kun TUI directly.',
    buttons: ['Install', 'Later'],
    defaultId: 0,
    cancelId: 1
  }
  const result = parent
    ? await dialog.showMessageBox(parent, options)
    : await dialog.showMessageBox(options)
  if (result.response === 0) await runCliInstallAction(status.state === 'stale' ? 'repair' : 'install')
}

export async function cliInstallStatus(): Promise<CliInstallStatus> {
  if (process.platform === 'darwin') return macStatus()
  if (process.platform === 'linux') return linuxStatus()
  if (process.platform === 'win32') return windowsStatus()
  return { state: 'unsupported', message: `Unsupported platform: ${process.platform}` }
}

export async function runCliInstallAction(action: CliInstallAction): Promise<CliInstallResult> {
  if (action !== 'install' && action !== 'repair' && action !== 'uninstall') {
    return { ok: false, status: await cliInstallStatus(), message: 'Invalid CLI install action.' }
  }
  try {
    if (process.platform === 'darwin') await mutateMac(action)
    else if (process.platform === 'linux') await mutateLinux(action)
    else if (process.platform === 'win32') await mutateWindows(action)
    else throw new Error(`Unsupported platform: ${process.platform}`)
    return { ok: true, status: await cliInstallStatus() }
  } catch (error) {
    return {
      ok: false,
      status: await cliInstallStatus(),
      message: error instanceof Error ? error.message : String(error)
    }
  }
}

function macLauncherPath(): string {
  return join(process.resourcesPath, 'bin', 'kun')
}

async function macStatus(): Promise<CliInstallStatus> {
  const commandPath = '/usr/local/bin/kun'
  const launcherPath = macLauncherPath()
  try {
    const details = await lstat(commandPath)
    if (!details.isSymbolicLink()) {
      return { state: 'conflict', commandPath, launcherPath, message: 'A non-symlink file already exists.' }
    }
    const rawTarget = await readlink(commandPath)
    const targetPath = resolve(dirname(commandPath), rawTarget)
    if (targetPath === launcherPath) return { state: 'installed', commandPath, launcherPath, targetPath }
    return { state: 'stale', commandPath, launcherPath, targetPath }
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { state: 'not-installed', commandPath, launcherPath }
    throw error
  }
}

async function mutateMac(action: CliInstallAction): Promise<void> {
  const status = await macStatus()
  const commandPath = status.commandPath!
  if (action === 'uninstall') {
    if (status.state === 'not-installed') return
    if (status.state === 'conflict') throw new Error('Refusing to remove a non-symlink /usr/local/bin/kun.')
    await privilegedMacCommand(`/bin/rm -f ${shellQuote(commandPath)}`)
    return
  }
  if (status.state === 'conflict') throw new Error('Refusing to overwrite a non-symlink /usr/local/bin/kun.')
  const launcher = macLauncherPath()
  const command = `/bin/mkdir -p ${shellQuote(dirname(commandPath))} && /bin/ln -sfn ${shellQuote(launcher)} ${shellQuote(commandPath)}`
  await privilegedMacCommand(command)
}

async function privilegedMacCommand(command: string): Promise<void> {
  try {
    await execFileAsync('/usr/bin/osascript', [
      '-e',
      `do shell script ${appleScriptString(command)} with administrator privileges`
    ])
  } catch (error) {
    throw new Error(`Unable to update the terminal command: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function linuxAppImagePath(): string {
  return process.env.APPIMAGE?.trim() || process.execPath
}

function linuxCommandPath(): string {
  return join(homedir(), '.local', 'bin', 'kun')
}

async function linuxStatus(): Promise<CliInstallStatus> {
  const commandPath = linuxCommandPath()
  const launcherPath = linuxAppImagePath()
  try {
    const contents = await readFile(commandPath, 'utf8')
    if (!contents.includes(LINUX_MARKER)) {
      return { state: 'conflict', commandPath, launcherPath, message: 'An unmanaged command already exists.' }
    }
    const target = /^app_image=(.+)$/mu.exec(contents)?.[1]?.trim().replace(/^'|'$/gu, '')
    const targetPath = target || undefined
    const state = targetPath === launcherPath ? 'installed' : 'stale'
    return {
      state,
      commandPath,
      launcherPath,
      targetPath,
      pathConfigured: pathContains(dirname(commandPath))
    }
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return {
        state: 'not-installed',
        commandPath,
        launcherPath,
        pathConfigured: pathContains(dirname(commandPath))
      }
    }
    throw error
  }
}

async function mutateLinux(action: CliInstallAction): Promise<void> {
  const status = await linuxStatus()
  const commandPath = status.commandPath!
  if (action === 'uninstall') {
    if (status.state !== 'not-installed' && status.state !== 'conflict') await unlink(commandPath)
    await removeLinuxPathBlock()
    return
  }
  if (status.state === 'conflict') throw new Error(`Refusing to overwrite ${commandPath}.`)
  await mkdir(dirname(commandPath), { recursive: true, mode: 0o755 })
  const appImage = linuxAppImagePath()
  await writeFile(commandPath, `#!/bin/sh
${LINUX_MARKER}
app_image=${shellQuote(appImage)}
KUN_CLI_ENTRY=1 exec "$app_image" "$@"
`, { mode: 0o755 })
  await chmod(commandPath, 0o755)
  if (!pathContains(dirname(commandPath))) await installLinuxPathBlock(dirname(commandPath))
}

async function windowsStatus(): Promise<CliInstallStatus> {
  const commandPath = join(dirname(process.execPath), 'bin', 'kun.cmd')
  try {
    await lstat(commandPath)
    const pathConfigured = pathContains(dirname(commandPath))
    return {
      state: pathConfigured ? 'installed' : 'stale',
      commandPath,
      launcherPath: commandPath,
      pathConfigured
    }
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { state: 'not-installed', commandPath, launcherPath: commandPath }
    throw error
  }
}

async function mutateWindows(action: CliInstallAction): Promise<void> {
  const binDir = join(dirname(process.execPath), 'bin')
  const escaped = powerShellString(binDir)
  const command = action === 'uninstall'
    ? `$p=[Environment]::GetEnvironmentVariable('Path','User');$parts=@($p -split ';' | ? {$_.Trim() -ne '' -and -not $_.TrimEnd('\\').Equals('${escaped}'.TrimEnd('\\'),'OrdinalIgnoreCase')});[Environment]::SetEnvironmentVariable('Path',($parts -join ';'),'User')`
    : `$p=[Environment]::GetEnvironmentVariable('Path','User');$parts=@($p -split ';' | ? {$_.Trim() -ne ''});if(-not ($parts | ? {$_.TrimEnd('\\').Equals('${escaped}'.TrimEnd('\\'),'OrdinalIgnoreCase')})){[Environment]::SetEnvironmentVariable('Path',(($parts + '${escaped}') -join ';'),'User')}`
  await execFileAsync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command])
  const entries = (process.env.PATH ?? '').split(';').filter(Boolean)
  const without = entries.filter((entry) => entry.replace(/[\\/]+$/u, '').toLowerCase() !== binDir.replace(/[\\/]+$/u, '').toLowerCase())
  process.env.PATH = (action === 'uninstall' ? without : [...without, binDir]).join(';')
}

async function installLinuxPathBlock(binDir: string): Promise<void> {
  const config = shellConfigPath()
  if (!config) return
  await mkdir(dirname(config.path), { recursive: true })
  const current = await readFile(config.path, 'utf8').catch((error) => errorCode(error) === 'ENOENT' ? '' : Promise.reject(error))
  if (current.includes(PATH_BLOCK_START)) return
  const line = config.kind === 'fish'
    ? `set -gx PATH ${shellQuote(binDir)} $PATH`
    : `export PATH=${shellQuote(binDir)}:$PATH`
  await appendFile(config.path, `\n${PATH_BLOCK_START}\n${line}\n${PATH_BLOCK_END}\n`, 'utf8')
}

async function removeLinuxPathBlock(): Promise<void> {
  const config = shellConfigPath()
  if (!config) return
  const current = await readFile(config.path, 'utf8').catch((error) => errorCode(error) === 'ENOENT' ? '' : Promise.reject(error))
  const escapedStart = escapeRegExp(PATH_BLOCK_START)
  const escapedEnd = escapeRegExp(PATH_BLOCK_END)
  const next = current.replace(new RegExp(`\\n?${escapedStart}[\\s\\S]*?${escapedEnd}\\n?`, 'gu'), '\n')
  if (next !== current) await writeFile(config.path, next, 'utf8')
}

function shellConfigPath(): { path: string; kind: 'posix' | 'fish' } | null {
  const shell = basename(process.env.SHELL || '')
  if (shell === 'fish') return { path: join(homedir(), '.config', 'fish', 'config.fish'), kind: 'fish' }
  if (shell === 'zsh') return { path: join(homedir(), '.zshrc'), kind: 'posix' }
  if (shell === 'bash') return { path: join(homedir(), '.bashrc'), kind: 'posix' }
  return null
}

function pathContains(path: string): boolean {
  const expected = process.platform === 'win32' ? path.toLowerCase() : path
  return (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')
    .some((entry) => (process.platform === 'win32' ? entry.toLowerCase() : entry) === expected)
}

function errorCode(error: unknown): string {
  return String((error as { code?: unknown })?.code ?? '')
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

function appleScriptString(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

function powerShellString(value: string): string {
  return value.replaceAll("'", "''")
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}
