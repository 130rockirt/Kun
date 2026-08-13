import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  defaultKunRuntimeSettings,
  normalizeAppSettings,
  type AppSettingsV1
} from '../../shared/app-settings'
import {
  beginBrowserUseHostShutdown,
  configureBrowserUseHost,
  ensureBrowserUseHostForRuntime,
  prepareBrowserUseHostForKunLaunch,
  reconcileBrowserUseHostForRuntime,
  stopBrowserUseHost,
  updateBrowserUseHostSettings
} from './browser-use-host'
import { BrowserUseBridgeService } from './browser-use-bridge-service'

function settings(
  enabled = true,
  mode: 'public' | 'local-development' = 'public',
  approvalMode: 'auto-safe' | 'always-ask' = 'auto-safe'
): AppSettingsV1 {
  const normalized = normalizeAppSettings({} as AppSettingsV1)
  return {
    ...normalized,
    agents: {
      kun: {
        ...defaultKunRuntimeSettings(),
        browserUse: {
          ...defaultKunRuntimeSettings().browserUse,
          enabled,
          mode,
          approvalMode
        }
      }
    }
  }
}

describe('Browser Use host lifecycle', () => {
  afterEach(async () => {
    vi.restoreAllMocks()
    await stopBrowserUseHost()
  })

  it('keeps the current binding for shared-runtime hot attach and rotates only for launch', async () => {
    configureBrowserUseHost({ settings: settings(), getMainWindow: () => null })
    const first = await ensureBrowserUseHostForRuntime()
    const reused = await ensureBrowserUseHostForRuntime()
    expect(reused).toEqual(first)

    const rotated = await prepareBrowserUseHostForKunLaunch(settings())
    expect(rotated?.token).not.toBe(first?.token)
  })

  it('stops and revokes the host when Browser Use is disabled', async () => {
    configureBrowserUseHost({ settings: settings(), getMainWindow: () => null })
    expect(await ensureBrowserUseHostForRuntime()).toBeDefined()
    updateBrowserUseHostSettings(settings(false))
    expect(await ensureBrowserUseHostForRuntime()).toBeUndefined()
  })

  it('rotates session authority when a session-scoped policy changes', async () => {
    configureBrowserUseHost({ settings: settings(), getMainWindow: () => null })
    const first = await ensureBrowserUseHostForRuntime()

    updateBrowserUseHostSettings(settings(true, 'local-development'))
    const rebound = await ensureBrowserUseHostForRuntime()

    expect(rebound?.token).not.toBe(first?.token)
  })

  it('rotates session authority when browser approval policy changes', async () => {
    configureBrowserUseHost({ settings: settings(), getMainWindow: () => null })
    const first = await ensureBrowserUseHostForRuntime()

    updateBrowserUseHostSettings(settings(true, 'public', 'always-ask'))
    const rebound = await ensureBrowserUseHostForRuntime()

    expect(rebound?.token).not.toBe(first?.token)
  })

  it('keeps S0 after a rapid S0 to S1 to S0 supersession', async () => {
    const s0 = settings(false)
    const s1 = settings(true)
    configureBrowserUseHost({ settings: s0, getMainWindow: () => null })
    let s1Checks = 0

    const stale = reconcileBrowserUseHostForRuntime(s1, () => {
      s1Checks += 1
      return s1Checks === 1
    })
    const current = reconcileBrowserUseHostForRuntime(s0)

    await expect(stale).resolves.toEqual({ current: false })
    await expect(current).resolves.toEqual({ current: true })
    await expect(ensureBrowserUseHostForRuntime()).resolves.toBeUndefined()
  })

  it('fences every authority issue path synchronously during shutdown', async () => {
    configureBrowserUseHost({ settings: settings(), getMainWindow: () => null })
    const issued = await ensureBrowserUseHostForRuntime()
    const stop = vi.spyOn(BrowserUseBridgeService.prototype, 'stop')

    expect(beginBrowserUseHostShutdown()).toEqual(issued)
    await vi.waitFor(() => expect(stop).toHaveBeenCalled())
    await expect(ensureBrowserUseHostForRuntime()).resolves.toBeUndefined()
    await expect(prepareBrowserUseHostForKunLaunch(settings())).resolves.toBeUndefined()
    await expect(reconcileBrowserUseHostForRuntime(settings())).resolves.toEqual({
      current: false
    })
  })

  it('revokes a binding whose listen completes after the shutdown fence', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    vi.spyOn(BrowserUseBridgeService.prototype, 'start').mockImplementationOnce(async () => {
      await gate
      return {
        url: 'http://127.0.0.1:23456',
        token: 'b'.repeat(43),
        approvalSigningKey: 's'.repeat(43)
      }
    })
    configureBrowserUseHost({ settings: settings(), getMainWindow: () => null })

    const issuing = ensureBrowserUseHostForRuntime()
    await Promise.resolve()
    expect(beginBrowserUseHostShutdown()).toBeUndefined()
    release()

    await expect(issuing).resolves.toBeUndefined()
    expect(beginBrowserUseHostShutdown()).toBeUndefined()
  })
})
