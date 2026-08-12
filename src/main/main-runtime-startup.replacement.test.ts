import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  defaultKunRuntimeSettings,
  normalizeAppSettings,
  type AppSettingsV1
} from '../shared/app-settings'

const harness = vi.hoisted(() => {
  let latest: unknown
  const stopSharedAndWait = vi.fn(async () => undefined)
  const stopSharedForReplacementAndWait = vi.fn(async () => undefined)
  const ensureRunning = vi.fn(async () => undefined)
  const ensureReplacementRunning = vi.fn(async () => undefined)
  const requiresBundledBuildReplacement = vi.fn(async () => false)
  const waitForHealthy = vi.fn(async () => true)
  const probeRuntimeApi = vi.fn(async () => ({ ok: true as const }))
  const noteRuntimeHealthy = vi.fn()
  const waitForKunStartupSettled = vi.fn(async () => undefined)
  const mainState = {
    assertCanonicalRuntimeMigrationReady: vi.fn()
  }
  const runtimeSupervisor = {
    latestOr: <Settings>(fallback: Settings): Settings => (latest ?? fallback) as Settings,
    setManagedRuntimeExpected: vi.fn(),
    restart: vi.fn(async (operation: () => Promise<void>) => operation()),
    replace: vi.fn(async (operation: () => Promise<void>) => operation()),
    ensure: vi.fn()
  }

  return {
    ensureReplacementRunning,
    ensureRunning,
    mainState,
    noteRuntimeHealthy,
    probeRuntimeApi,
    requiresBundledBuildReplacement,
    runtimeSupervisor,
    setLatest: (settings: unknown): void => { latest = settings },
    stopSharedAndWait,
    stopSharedForReplacementAndWait,
    waitForHealthy,
    waitForKunStartupSettled
  }
})

vi.mock('./runtime/kun-adapter', () => ({
  kunRuntimeAdapter: {
    ensureRunning: harness.ensureRunning,
    ensureReplacementRunning: harness.ensureReplacementRunning,
    isChildRunning: () => false,
    requiresBundledBuildReplacement: harness.requiresBundledBuildReplacement,
    resolveConnection: vi.fn(async () => false),
    stopSharedAndWait: harness.stopSharedAndWait,
    stopSharedForReplacementAndWait: harness.stopSharedForReplacementAndWait
  }
}))
vi.mock('./kun-process', () => ({
  isKunChildRunning: () => false,
  waitForKunStartupSettled: harness.waitForKunStartupSettled
}))
vi.mock('./managed-runtime-startup-policy', () => ({
  managedKunHostCanAutoStart: (settings: AppSettingsV1) => settings.agents.kun.autoStart
}))
vi.mock('./logger', () => ({ logWarn: vi.fn() }))
vi.mock('./main-app-context', () => ({
  mainState: harness.mainState,
  runtimeJsonError: (code: string, message: string) => Object.assign(new Error(message), { code })
}))
vi.mock('./main-runtime-health', () => ({
  kunRuntimeHealthMonitor: { waitForHealthy: harness.waitForHealthy },
  noteRuntimeHealthy: harness.noteRuntimeHealthy,
  probeRuntimeApi: harness.probeRuntimeApi,
  RUNTIME_HUNG_CONFIRM_MS: 10_000,
  runtimeFingerprint: () => 'runtime',
  runtimeSupervisor: harness.runtimeSupervisor
}))

import {
  reconcileBundledRuntimeAfterInstall,
  replaceKunServe
} from './main-runtime-startup'

function settings(): AppSettingsV1 {
  const base = normalizeAppSettings({} as AppSettingsV1)
  return {
    ...base,
    agents: {
      kun: {
        ...defaultKunRuntimeSettings(),
        autoStart: true
      }
    }
  }
}

beforeEach(() => {
  harness.setLatest(undefined)
  harness.stopSharedAndWait.mockClear()
  harness.stopSharedForReplacementAndWait.mockClear()
  harness.ensureRunning.mockClear()
  harness.ensureReplacementRunning.mockClear()
  harness.requiresBundledBuildReplacement.mockReset()
  harness.requiresBundledBuildReplacement.mockResolvedValue(false)
  harness.waitForHealthy.mockClear()
  harness.probeRuntimeApi.mockClear()
  harness.noteRuntimeHealthy.mockClear()
  harness.waitForKunStartupSettled.mockClear()
  harness.mainState.assertCanonicalRuntimeMigrationReady.mockClear()
  harness.runtimeSupervisor.restart.mockClear()
  harness.runtimeSupervisor.replace.mockClear()
  harness.runtimeSupervisor.setManagedRuntimeExpected.mockClear()
})

describe('explicit Kun serve replacement', () => {
  it('uses the verified replacement stop and launch path instead of ordinary restart', async () => {
    const current = settings()

    await expect(replaceKunServe(current)).resolves.toBeUndefined()

    expect(harness.runtimeSupervisor.replace).toHaveBeenCalledOnce()
    expect(harness.runtimeSupervisor.restart).not.toHaveBeenCalled()
    expect(harness.stopSharedForReplacementAndWait).toHaveBeenCalledWith(current)
    expect(harness.stopSharedAndWait).not.toHaveBeenCalled()
    expect(harness.ensureReplacementRunning).toHaveBeenCalledWith(current)
    expect(harness.ensureRunning).not.toHaveBeenCalled()
    expect(harness.waitForHealthy).toHaveBeenCalledWith(current, 20_000)
    expect(harness.probeRuntimeApi).toHaveBeenCalledWith(current)
  })

  it('hands a packaged build mismatch to the same explicit replacement path before startup attach', async () => {
    const current = settings()
    harness.requiresBundledBuildReplacement.mockResolvedValue(true)

    await expect(reconcileBundledRuntimeAfterInstall(current)).resolves.toBeUndefined()

    expect(harness.requiresBundledBuildReplacement).toHaveBeenCalledWith(current)
    expect(harness.runtimeSupervisor.replace).toHaveBeenCalledOnce()
    expect(harness.stopSharedForReplacementAndWait).toHaveBeenCalledWith(current)
    expect(harness.ensureReplacementRunning).toHaveBeenCalledWith(current)
    expect(harness.ensureRunning).not.toHaveBeenCalled()
  })
})
