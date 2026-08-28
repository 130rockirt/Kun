import { describe, expect, it, vi } from 'vitest'
import { runMinimalUpdateProbe } from './update-health-probe'

vi.mock('electron', () => ({
  app: {
    whenReady: vi.fn(async () => undefined),
    getVersion: vi.fn(() => '0.2.0'),
    isPackaged: true
  }
}))

describe('runMinimalUpdateProbe', () => {
  const healthyInstall = { ok: true } as const

  function deps(overrides: Partial<Parameters<typeof runMinimalUpdateProbe>[0]> = {}) {
    return {
      isPackaged: () => true,
      executablePath: () => 'C:\\Program Files\\Kun\\Kun.exe',
      resourcesPath: () => 'C:\\Program Files\\Kun\\resources',
      inspectInstall: vi.fn(() => healthyInstall),
      loadRuntimeAdapter: vi.fn(async () => ({})),
      probeRendererWindow: vi.fn(async () => undefined),
      probeRuntimeServices: vi.fn(async () => undefined),
      createTempDir: vi.fn(async () => '/tmp/kun-update-health-1'),
      removeTempDir: vi.fn(async () => undefined),
      ...overrides
    }
  }

  it('loads the packaged runtime module without starting persistent services', async () => {
    const d = deps()

    await runMinimalUpdateProbe(d)

    expect(d.loadRuntimeAdapter).toHaveBeenCalledOnce()
    expect(d.probeRendererWindow).toHaveBeenCalledOnce()
    expect(d.probeRuntimeServices).toHaveBeenCalledOnce()
    expect(d.removeTempDir).toHaveBeenCalledWith('/tmp/kun-update-health-1')
  })

  it('rejects an incomplete candidate payload before loading runtime modules', async () => {
    const d = deps({
      inspectInstall: vi.fn(() => ({ ok: false, missing: ['Kun runtime entry'] }))
    })

    await expect(runMinimalUpdateProbe(d)).rejects.toThrow('Kun runtime entry')

    expect(d.loadRuntimeAdapter).not.toHaveBeenCalled()
    expect(d.probeRendererWindow).not.toHaveBeenCalled()
    expect(d.probeRuntimeServices).not.toHaveBeenCalled()
  })

  it('surfaces a packaged runtime module load failure', async () => {
    const d = deps({
      loadRuntimeAdapter: vi.fn(async () => {
        throw new Error('runtime entry could not load')
      })
    })

    await expect(runMinimalUpdateProbe(d)).rejects.toThrow('runtime entry could not load')
    expect(d.probeRendererWindow).not.toHaveBeenCalled()
  })

  it('fails the probe when the renderer surface is broken', async () => {
    const d = deps({
      probeRendererWindow: vi.fn(async () => {
        throw new Error('preload bridge missing')
      })
    })

    await expect(runMinimalUpdateProbe(d)).rejects.toThrow('preload bridge missing')
    expect(d.probeRuntimeServices).not.toHaveBeenCalled()
  })

  it('fails the probe when the runtime gateway is unhealthy', async () => {
    const d = deps({
      probeRuntimeServices: vi.fn(async () => {
        throw new Error('The candidate runtime gateway did not become healthy.')
      })
    })

    await expect(runMinimalUpdateProbe(d)).rejects.toThrow('gateway did not become healthy')
  })

  it('always removes the temporary data directory', async () => {
    const d = deps({
      probeRuntimeServices: vi.fn(async () => {
        throw new Error('storage failed')
      })
    })

    await expect(runMinimalUpdateProbe(d)).rejects.toThrow('storage failed')
    expect(d.removeTempDir).toHaveBeenCalledWith('/tmp/kun-update-health-1')
  })
})
