import { constants } from 'node:fs'
import { access, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const osState = vi.hoisted(() => ({ home: '' }))

vi.mock('node:os', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:os')>()
  return { ...original, homedir: () => osState.home }
})

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '' },
  dialog: { showMessageBox: vi.fn() }
}))

import { cliInstallStatus, runCliInstallAction } from './cli-install-service'

const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!

describe('CLI install service on Linux', () => {
  let directory = ''
  let previousPath: string | undefined
  let previousShell: string | undefined
  let previousAppImage: string | undefined

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'kun-cli-install-'))
    osState.home = directory
    previousPath = process.env.PATH
    previousShell = process.env.SHELL
    previousAppImage = process.env.APPIMAGE
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
    expect((await lstat(commandPath)).mode & 0o111).not.toBe(0)
    await expect(access(commandPath, constants.X_OK)).resolves.toBeUndefined()

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

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}
