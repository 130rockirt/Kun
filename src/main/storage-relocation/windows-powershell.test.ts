import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const childProcessState = vi.hoisted(() => ({
  calls: [] as Array<{
    file: string
    args: readonly string[]
    options: { env?: NodeJS.ProcessEnv }
  }>
}))

const execFileMock = vi.hoisted(() => {
  const execFile = () => undefined
  Object.defineProperty(execFile, Symbol.for('nodejs.util.promisify.custom'), {
    value: (
      file: string,
      args: readonly string[],
      options: { env?: NodeJS.ProcessEnv }
    ) => {
      childProcessState.calls.push({ file, args, options })
      return Promise.resolve({
        stdout: '{"root":"C:\\\\","driveType":"Fixed","fileSystem":"NTFS","availableBytes":1}',
        stderr: ''
      })
    }
  })
  return execFile
})

vi.mock('node:child_process', () => ({
  execFile: execFileMock
}))

import {
  copyWindowsAcls,
  hardenStorageDestinationAcl,
  inspectWindowsVolume
} from './paths'

const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!

describe('Windows storage relocation PowerShell invocation', () => {
  beforeEach(() => {
    childProcessState.calls.length = 0
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', platformDescriptor)
  })

  it('passes the volume root through a private process environment', async () => {
    await expect(inspectWindowsVolume('C:\\Users\\Ada')).resolves.toMatchObject({
      root: 'C:\\',
      driveType: 'Fixed',
      fileSystem: 'NTFS',
      availableBytes: 1
    })

    const { args, file, options } = onlyCall()
    expect(file).toBe('powershell.exe')
    expect(args.slice(0, 5)).toEqual(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'])
    expect(args).toHaveLength(6)
    expect(args[5]).toContain('$env:KUN_STORAGE_RELOCATION_VOLUME_ROOT')
    expect(options.env).toMatchObject({ KUN_STORAGE_RELOCATION_VOLUME_ROOT: 'C:\\' })
  })

  it('passes the destination ACL path through a private process environment', async () => {
    await hardenStorageDestinationAcl('C:\\Kun Data; & unsafe')

    const { args, file, options } = onlyCall()
    expect(file).toBe('powershell.exe')
    expect(args.slice(0, 5)).toEqual(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'])
    expect(args).toHaveLength(6)
    expect(args[5]).toContain('$env:KUN_STORAGE_RELOCATION_DESTINATION_PATH')
    expect(options.env).toMatchObject({
      KUN_STORAGE_RELOCATION_DESTINATION_PATH: 'C:\\Kun Data; & unsafe'
    })
  })

  it('passes both source and target ACL paths through a private process environment', async () => {
    await copyWindowsAcls('C:\\Source; & unsafe', 'D:\\Target; & unsafe')

    const { args, file, options } = onlyCall()
    expect(file).toBe('powershell.exe')
    expect(args.slice(0, 5)).toEqual(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'])
    expect(args).toHaveLength(6)
    expect(args[5]).toContain('$env:KUN_STORAGE_RELOCATION_ACL_SOURCE_PATH')
    expect(args[5]).toContain('$env:KUN_STORAGE_RELOCATION_ACL_TARGET_PATH')
    expect(options.env).toMatchObject({
      KUN_STORAGE_RELOCATION_ACL_SOURCE_PATH: 'C:\\Source; & unsafe',
      KUN_STORAGE_RELOCATION_ACL_TARGET_PATH: 'D:\\Target; & unsafe'
    })
  })
})

function onlyCall(): { file: string; args: readonly string[]; options: { env?: NodeJS.ProcessEnv } } {
  expect(childProcessState.calls).toHaveLength(1)
  return childProcessState.calls[0]!
}
