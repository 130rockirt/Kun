import { constants } from 'node:fs'
import { access, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const osState = vi.hoisted(() => ({ home: '' }))
const childProcessState = vi.hoisted(() => ({
  calls: [] as Array<{ file: string; args: readonly string[] }>
}))

vi.mock('node:os', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:os')>()
  return { ...original, homedir: () => osState.home }
})

vi.mock('node:child_process', () => ({
  execFile: vi.fn((
    file: string,
    args: readonly string[],
    callback: (error: null, stdout: string, stderr: string) => void
  ) => {
    childProcessState.calls.push({ file, args })
    callback(null, '', '')
  })
}))

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '' },
  dialog: { showMessageBox: vi.fn() }
}))

import {
  cliInstallStatus,
  runCliInstallAction,
  terminalCommandPromptOptions
} from './cli-install-service'

const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
const hostPlatform = process.platform

describe('CLI install service on Linux', () => {
  let directory = ''
  let previousPath: string | undefined
  let previousShell: string | undefined
  let previousAppImage: string | undefined
  let previousExecPathDescriptor: PropertyDescriptor

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'kun-cli-install-'))
    osState.home = directory
    previousPath = process.env.PATH
    previousShell = process.env.SHELL
    previousAppImage = process.env.APPIMAGE
    previousExecPathDescriptor = Object.getOwnPropertyDescriptor(process, 'execPath')!
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    process.env.PATH = '/usr/bin:/bin'
    process.env.SHELL = '/bin/zsh'
    process.env.APPIMAGE = join(directory, 'Kun.AppImage')
    await writeFile(process.env.APPIMAGE, 'appimage')
  })

  afterEach(async () => {
    Object.defineProperty(process, 'platform', platformDescriptor)
    restoreEnv('PATH', previousPath)
    restoreEnv('SHELL', previousShell)
    restoreEnv('APPIMAGE', previousAppImage)
    Object.defineProperty(process, 'execPath', previousExecPathDescriptor)
    await rm(directory, { recursive: true, force: true })
  })

  it('installs an executable relocatable wrapper and a removable shell PATH block', async () => {
    const result = await runCliInstallAction('install')
    const commandPath = join(directory, '.local', 'bin', 'kun')

    expect(result).toMatchObject({
      ok: true,
      status: {
        state: 'installed', commandPath, targetPath: process.env.APPIMAGE, pathConfigured: false
      }
    })
    const wrapper = await readFile(commandPath, 'utf8')
    expect(wrapper).toContain('# Kun CLI launcher')
    expect(wrapper).toContain(`app_image='${process.env.APPIMAGE}'`)
    expect(wrapper).toContain('KUN_CLI_ENTRY=1 exec "$app_image" "$@"')
    if (hostPlatform !== 'win32') {
      expect((await lstat(commandPath)).mode & 0o111).not.toBe(0)
      await expect(access(commandPath, constants.X_OK)).resolves.toBeUndefined()
    }

    const shellConfig = await readFile(join(directory, '.zshrc'), 'utf8')
    expect(shellConfig).toContain('# >>> Kun CLI >>>')
    expect(shellConfig).toContain(`export PATH='${join(directory, '.local', 'bin')}':$PATH`)

    const removed = await runCliInstallAction('uninstall')
    expect(removed).toMatchObject({ ok: true, status: { state: 'not-installed' } })
    await expect(lstat(commandPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(directory, '.zshrc'), 'utf8')).not.toContain('# >>> Kun CLI >>>')
  })

  it('repairs a wrapper after the AppImage moves without duplicating PATH configuration', async () => {
    await runCliInstallAction('install')
    const originalConfig = await readFile(join(directory, '.zshrc'), 'utf8')
    process.env.APPIMAGE = join(directory, 'Kun-moved.AppImage')
    await writeFile(process.env.APPIMAGE, 'moved')

    await expect(cliInstallStatus()).resolves.toMatchObject({ state: 'stale' })
    const repaired = await runCliInstallAction('repair')
    expect(repaired).toMatchObject({
      ok: true,
      status: { state: 'installed', targetPath: process.env.APPIMAGE }
    })
    expect(await readFile(join(directory, '.zshrc'), 'utf8')).toBe(originalConfig)
    expect(await readFile(join(directory, '.local', 'bin', 'kun'), 'utf8'))
      .toContain(`app_image='${process.env.APPIMAGE}'`)
  })

  it('targets the product launcher instead of the renamed Electron payload for deb installs', async () => {
    delete process.env.APPIMAGE
    const productLauncher = join(directory, 'kun-gui')
    const electronPayload = `${productLauncher}.electron-bin`
    Object.defineProperty(process, 'execPath', {
      configurable: true,
      value: electronPayload
    })

    const result = await runCliInstallAction('install')
    expect(result).toMatchObject({
      ok: true,
      status: {
        state: 'installed',
        launcherPath: productLauncher,
        targetPath: productLauncher
      }
    })
    const wrapper = await readFile(join(directory, '.local', 'bin', 'kun'), 'utf8')
    expect(wrapper).toContain(`app_image='${productLauncher}'`)
    expect(wrapper).not.toContain(`app_image='${electronPayload}'`)
  })

  it('round-trips launcher paths containing shell-sensitive single quotes', async () => {
    process.env.APPIMAGE = join(directory, "Kun's builds", 'Kun.AppImage')
    await mkdir(join(directory, "Kun's builds"), { recursive: true })
    await writeFile(process.env.APPIMAGE, 'appimage')

    const installed = await runCliInstallAction('install')
    expect(installed).toMatchObject({
      ok: true,
      status: {
        state: 'installed',
        launcherPath: process.env.APPIMAGE,
        targetPath: process.env.APPIMAGE
      }
    })
    await expect(cliInstallStatus()).resolves.toMatchObject({
      state: 'installed',
      targetPath: process.env.APPIMAGE
    })
  })

  it('never overwrites or removes an unmanaged command', async () => {
    const commandPath = join(directory, '.local', 'bin', 'kun')
    await mkdir(join(directory, '.local', 'bin'), { recursive: true })
    await writeFile(commandPath, '#!/bin/sh\necho external\n', { mode: 0o755 })

    await expect(cliInstallStatus()).resolves.toMatchObject({ state: 'conflict' })
    const install = await runCliInstallAction('install')
    expect(install).toMatchObject({ ok: false, status: { state: 'conflict' } })
    expect(await readFile(commandPath, 'utf8')).toBe('#!/bin/sh\necho external\n')

    const uninstall = await runCliInstallAction('uninstall')
    expect(uninstall).toMatchObject({ ok: true, status: { state: 'conflict' } })
    expect(await readFile(commandPath, 'utf8')).toBe('#!/bin/sh\necho external\n')
  })
})

describe('CLI install service on Windows', () => {
  let directory = ''
  let previousPath: string | undefined
  let previousExecPathDescriptor: PropertyDescriptor

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'kun-cli-install-win-'))
    osState.home = directory
    previousPath = process.env.PATH
    previousExecPathDescriptor = Object.getOwnPropertyDescriptor(process, 'execPath')!
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    Object.defineProperty(process, 'execPath', {
      configurable: true,
      value: join(directory, 'Kun.exe')
    })
    process.env.PATH = 'C:\\Windows\\System32'
    childProcessState.calls.length = 0
    await mkdir(join(directory, 'bin'), { recursive: true })
    await writeFile(join(directory, 'bin', 'kun.cmd'), '@echo off\r\n')
  })

  afterEach(async () => {
    Object.defineProperty(process, 'platform', platformDescriptor)
    Object.defineProperty(process, 'execPath', previousExecPathDescriptor)
    restoreEnv('PATH', previousPath)
    await rm(directory, { recursive: true, force: true })
  })

  it('reports PATH removal as not installed and can enable the command again', async () => {
    await expect(cliInstallStatus()).resolves.toMatchObject({
      state: 'not-installed',
      pathConfigured: false
    })

    const installed = await runCliInstallAction('install')
    expect(installed).toMatchObject({
      ok: true,
      status: { state: 'installed', pathConfigured: true }
    })
    expect(process.env.PATH).toContain(join(directory, 'bin'))
    expect(childProcessState.calls.at(-1)?.file).toBe('powershell.exe')

    const removed = await runCliInstallAction('uninstall')
    expect(removed).toMatchObject({
      ok: true,
      status: { state: 'not-installed', pathConfigured: false }
    })
    expect(process.env.PATH).not.toContain(join(directory, 'bin'))
  })

  it('recognizes an existing Windows PATH entry with a trailing separator', async () => {
    process.env.PATH = `${process.env.PATH};${join(directory, 'bin')}\\`

    await expect(cliInstallStatus()).resolves.toMatchObject({
      state: 'installed',
      pathConfigured: true
    })
  })

  it('refuses to enable a missing or non-regular packaged launcher', async () => {
    await rm(join(directory, 'bin', 'kun.cmd'))
    const missing = await runCliInstallAction('install')
    expect(missing).toMatchObject({ ok: false, status: { state: 'not-installed' } })

    await mkdir(join(directory, 'bin', 'kun.cmd'))
    await expect(cliInstallStatus()).resolves.toMatchObject({ state: 'conflict' })
    const conflict = await runCliInstallAction('repair')
    expect(conflict).toMatchObject({ ok: false, status: { state: 'conflict' } })
  })
})

describe('terminal command prompt copy', () => {
  it('explains that enabling the command does not install the bundled TUI', () => {
    expect(terminalCommandPromptOptions()).toMatchObject({
      title: 'Enable Kun terminal command',
      message: 'Enable the `kun` command?',
      detail: expect.stringContaining('TUI is already included'),
      buttons: ['Enable', 'Later']
    })
  })
})

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}
