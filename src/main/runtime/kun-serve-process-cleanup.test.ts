import { describe, expect, it, vi } from 'vitest'
import {
  WINDOWS_CURRENT_USER_PROCESS_SCRIPT,
  clearHistoricalKunServeProcesses,
  listCurrentUserProcesses,
  looksLikeKunServeCommand,
  looksLikeKunServeProcess,
  parseUnixProcessSnapshot,
  parseWindowsProcessSnapshot,
  type KunServeProcessSnapshot
} from './kun-serve-process-cleanup'

describe('Kun serve process snapshot parsing', () => {
  it('keeps only current-UID Unix processes and their full commands', () => {
    const stdout = [
      '  101     1   501 /usr/local/bin/node /old/serve-entry.js serve --port 18899',
      '  102     1   502 /usr/local/bin/node /other/serve-entry.js serve --port 18898',
      '  bad row',
      '  103   101   501 kun-runtime'
    ].join('\n')

    expect(parseUnixProcessSnapshot(stdout, 501)).toEqual([
      {
        pid: 101,
        parentPid: 1,
        command: '/usr/local/bin/node /old/serve-entry.js serve --port 18899'
      },
      { pid: 103, parentPid: 101, command: 'kun-runtime' }
    ])
  })

  it('accepts both one-object and array-shaped Windows JSON', () => {
    expect(parseWindowsProcessSnapshot(JSON.stringify({
      ProcessId: 201,
      ParentProcessId: 10,
      ExecutablePath: 'C:\\Program Files\\Kun\\Kun.exe',
      CommandLine: '"C:\\Program Files\\Kun\\Kun.exe" serve'
    }))).toEqual([{
      pid: 201,
      parentPid: 10,
      executable: 'C:\\Program Files\\Kun\\Kun.exe',
      command: '"C:\\Program Files\\Kun\\Kun.exe" serve'
    }])

    expect(parseWindowsProcessSnapshot(JSON.stringify([
      { ProcessId: 202, ParentProcessId: 10, CommandLine: null },
      { ProcessId: 203, ParentProcessId: 10, CommandLine: 'kun-runtime' }
    ]))).toEqual([{ pid: 203, parentPid: 10, command: 'kun-runtime' }])
  })

  it('uses UID-filtered ps on Unix and candidate-filtered CIM on Windows', async () => {
    const unixRun = vi.fn(async () => ({ stdout: '' }))
    await listCurrentUserProcesses({
      platform: 'linux',
      currentUid: 501,
      run: unixRun
    })
    expect(unixRun).toHaveBeenCalledWith(
      'ps',
      ['-axww', '-o', 'pid=', '-o', 'ppid=', '-o', 'uid=', '-o', 'command='],
      expect.objectContaining({ windowsHide: true })
    )

    const windowsRun = vi.fn(async () => ({ stdout: '[]' }))
    await listCurrentUserProcesses({ platform: 'win32', run: windowsRun })
    expect(windowsRun).toHaveBeenCalledWith(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_CURRENT_USER_PROCESS_SCRIPT],
      expect.objectContaining({ windowsHide: true })
    )
    expect(WINDOWS_CURRENT_USER_PROCESS_SCRIPT).toContain('-Filter')
    expect(WINDOWS_CURRENT_USER_PROCESS_SCRIPT).toContain("Name = 'node.exe'")
    expect(WINDOWS_CURRENT_USER_PROCESS_SCRIPT).toContain("Name = 'electron.exe'")
    expect(WINDOWS_CURRENT_USER_PROCESS_SCRIPT).toContain("Name LIKE 'kun%.exe'")
    expect(WINDOWS_CURRENT_USER_PROCESS_SCRIPT).not.toContain(
      'Get-CimInstance Win32_Process | ForEach-Object'
    )
    expect(WINDOWS_CURRENT_USER_PROCESS_SCRIPT).toContain('GetOwnerSid')
    expect(WINDOWS_CURRENT_USER_PROCESS_SCRIPT).toContain('$currentSid')
  })
})

describe('Kun serve process matching', () => {
  it.each([
    ['kun-runtime', ''],
    ['kun-dv-runtime', ''],
    ['/usr/local/bin/node /Applications/Kun/serve-entry.js serve --port 18899', ''],
    ['"/Applications/Kun.app/Contents/MacOS/Kun" "/old/serve-entry.js" serve --port 18899', ''],
    ['"C:\\Program Files\\Kun\\Kun.exe" "C:\\old\\serve-entry.js" serve --port 18899', 'C:\\Program Files\\Kun\\Kun.exe'],
    ['C:\\tools\\kun-cli.exe serve --port 18899', 'C:\\tools\\kun-cli.exe']
  ])('matches a real serve command: %s', (command, executable) => {
    expect(looksLikeKunServeCommand(command, executable)).toBe(true)
  })

  it.each([
    ['kun-service-manager', ''],
    ['/Applications/Kun.app/Contents/MacOS/Kun', ''],
    ['/usr/local/bin/node unrelated-service.js serve', ''],
    ['/bin/sh -c "node /old/serve-entry.js serve"', ''],
    ['python worker.py --label kun-runtime', ''],
    ['node /old/serve-entry.js status', ''],
    ['C:\\Program Files\\Kun\\Kun.exe --type=utility serve', 'C:\\Program Files\\Kun\\Kun.exe']
  ])('rejects an unrelated command: %s', (command, executable) => {
    expect(looksLikeKunServeCommand(command, executable)).toBe(false)
  })

  it('always excludes the current Electron PID', () => {
    expect(looksLikeKunServeProcess({
      pid: 500,
      parentPid: 1,
      command: 'kun-runtime'
    }, 500)).toBe(false)
  })
})

describe('historical Kun serve cleanup', () => {
  const processes: KunServeProcessSnapshot[] = [
    { pid: 301, parentPid: 1, command: 'kun-runtime' },
    { pid: 302, parentPid: 1, command: '/usr/bin/node /old/serve-entry.js serve --port 19000' },
    { pid: 303, parentPid: 1, command: '/usr/bin/node unrelated.js' }
  ]

  it('terminates verified matches and tolerates a process that already exited', async () => {
    const listProcesses = vi.fn(async () => processes)
    const waitForExit = vi.fn(async (pid: number) => pid === 302)
    const terminate = vi.fn(async (_pid: number, verify: () => Promise<boolean>) => verify())
    const log = vi.fn(async () => undefined)

    await expect(clearHistoricalKunServeProcesses({
      currentPid: 999,
      listProcesses,
      waitForExit,
      terminate,
      log
    })).resolves.toEqual({
      matchedPids: [301, 302],
      terminatedPids: [301],
      alreadyExitedPids: [302],
      failedPids: []
    })

    expect(terminate).toHaveBeenCalledOnce()
    expect(terminate.mock.calls[0]?.[0]).toBe(301)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('scan found 2'))
  })

  it('fails closed when a matched PID changes identity before signaling', async () => {
    let reads = 0
    const listProcesses = vi.fn(async () => {
      reads += 1
      return reads === 1
        ? [{ pid: 401, parentPid: 1, command: 'kun-runtime' }]
        : [{ pid: 401, parentPid: 1, command: '/usr/bin/node unrelated.js' }]
    })
    const waitForExit = vi.fn(async () => false)
    const terminate = vi.fn(async (_pid: number, verify: () => Promise<boolean>) => {
      expect(await verify()).toBe(false)
      return false
    })

    await expect(clearHistoricalKunServeProcesses({
      currentPid: 999,
      listProcesses,
      waitForExit,
      terminate,
      log: vi.fn(async () => undefined)
    })).rejects.toThrow(/401.*replacement was not started/i)
  })
})
