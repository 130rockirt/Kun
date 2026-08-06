import { afterEach, describe, expect, it, vi } from 'vitest'

type InstallerModule = typeof import('./agent-sdk-installer')

async function loadInstaller(): Promise<InstallerModule> {
  vi.resetModules()
  return import('./agent-sdk-installer')
}

async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.resetModules()
})

describe('startAgentSdkInstall', () => {
  it('does not mark the SDK ready until Kun finishes restarting', async () => {
    const installer = await loadInstaller()
    let finishRestart: (() => void) | undefined
    const restartRuntime = vi.fn(() => new Promise<void>((resolve) => { finishRestart = resolve }))
    const installBinary = vi.fn(async () => ({ ok: true as const, path: '/tmp/claude' }))
    const states: string[] = []

    const initial = installer.startAgentSdkInstall(
      { userDataDir: '/tmp/kun-agent-sdk-test', restartRuntime },
      (state) => states.push(state.status),
      { installBinary: installBinary as typeof installer.installClaudeBinary, hasDownloadedBinary: () => false }
    )

    expect(initial.status).toBe('downloading')
    await settle()
    expect(states).toEqual(['downloading', 'restarting'])
    expect(installer.agentSdkDownloadState()?.status).toBe('restarting')
    expect(restartRuntime).toHaveBeenCalledTimes(1)

    finishRestart?.()
    await settle()
    expect(states).toEqual(['downloading', 'restarting', 'done'])
    expect(installer.agentSdkDownloadState()?.status).toBe('done')
  })

  it('shares an in-flight restart instead of starting a second download', async () => {
    const installer = await loadInstaller()
    let finishRestart: (() => void) | undefined
    const restartRuntime = vi.fn(() => new Promise<void>((resolve) => { finishRestart = resolve }))
    const installBinary = vi.fn(async () => ({ ok: true as const, path: '/tmp/claude' }))
    const options = { userDataDir: '/tmp/kun-agent-sdk-test', restartRuntime }
    const dependencies = {
      installBinary: installBinary as typeof installer.installClaudeBinary,
      hasDownloadedBinary: () => false
    }

    installer.startAgentSdkInstall(options, undefined, dependencies)
    await settle()
    const repeated = installer.startAgentSdkInstall(options, undefined, dependencies)

    expect(repeated.status).toBe('restarting')
    expect(installBinary).toHaveBeenCalledTimes(1)
    expect(restartRuntime).toHaveBeenCalledTimes(1)

    finishRestart?.()
    await settle()
    expect(installer.agentSdkDownloadState()?.status).toBe('done')
  })

  it('reports restart failure and retries with the existing binary without downloading again', async () => {
    const installer = await loadInstaller()
    const restartRuntime = vi.fn()
      .mockRejectedValueOnce(new Error('health check timed out'))
      .mockResolvedValueOnce(undefined)
    const installBinary = vi.fn(async () => ({ ok: true as const, path: '/tmp/claude' }))
    const states: string[] = []
    const options = { userDataDir: '/tmp/kun-agent-sdk-test', restartRuntime }

    installer.startAgentSdkInstall(
      options,
      (state) => states.push(state.status),
      { installBinary: installBinary as typeof installer.installClaudeBinary, hasDownloadedBinary: () => false }
    )
    await settle()

    expect(installer.agentSdkDownloadState()).toMatchObject({
      status: 'error',
      message: expect.stringContaining('health check timed out')
    })

    const retried = installer.startAgentSdkInstall(
      options,
      (state) => states.push(state.status),
      { installBinary: installBinary as typeof installer.installClaudeBinary, hasDownloadedBinary: () => true }
    )

    expect(retried.status).toBe('restarting')
    await settle()
    expect(states).toEqual(['downloading', 'restarting', 'error', 'restarting', 'done'])
    expect(installBinary).toHaveBeenCalledTimes(1)
    expect(restartRuntime).toHaveBeenCalledTimes(2)
  })

  it('does not restart Kun when the binary download fails', async () => {
    const installer = await loadInstaller()
    const restartRuntime = vi.fn(async () => undefined)
    const installBinary = vi.fn(async () => ({ ok: false as const, message: 'registry unavailable' }))

    installer.startAgentSdkInstall(
      { userDataDir: '/tmp/kun-agent-sdk-test', restartRuntime },
      undefined,
      { installBinary: installBinary as typeof installer.installClaudeBinary, hasDownloadedBinary: () => false }
    )
    await settle()

    expect(installer.agentSdkDownloadState()).toEqual({
      status: 'error',
      receivedBytes: 0,
      totalBytes: 0,
      message: 'registry unavailable'
    })
    expect(restartRuntime).not.toHaveBeenCalled()
  })
})
