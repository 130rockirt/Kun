import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  defaultModelProviderSettings,
  getModelProviderPreset,
  modelProviderPresetProfile
} from '@shared/app-settings'
import {
  canCloseInitialSetup,
  commitInitialSetupRegistryCredentials,
  completeInitialSetupAfterSave,
  dismissInitialSetup,
  isUnreadableCredentialKeyError
} from './InitialSetupDialog'
import {
  drainSharedProviderCredentialMutation,
  resetSharedProviderMutationCoordinatorForTests,
  stageSharedProviderCredentialMutation
} from './shared-provider-mutation-coordinator'

describe('InitialSetupDialog completion flow', () => {
  afterEach(() => resetSharedProviderMutationCoordinatorForTests())

  it('rotates onboarding credentials through the revisioned registry and retries one conflict', async () => {
    const snapshot = (revision: number) => ({
      schemaVersion: 1,
      revision,
      providers: [
        { id: 'deepseek', accountId: 'account:deepseek' },
        { id: 'minimax', accountId: 'account:minimax' }
      ]
    })
    const request = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, body: JSON.stringify(snapshot(4)) })
      .mockResolvedValueOnce({
        ok: false,
        status: 409,
        body: JSON.stringify({ snapshot: snapshot(5) })
      })
      .mockResolvedValueOnce({ ok: true, status: 200, body: JSON.stringify(snapshot(6)) })
      .mockResolvedValueOnce({ ok: true, status: 200, body: JSON.stringify(snapshot(6)) })
      .mockResolvedValueOnce({ ok: true, status: 200, body: JSON.stringify(snapshot(7)) })
      .mockResolvedValueOnce({ ok: true, status: 200, body: JSON.stringify(snapshot(7)) })
      .mockResolvedValueOnce({ ok: true, status: 200, body: JSON.stringify(snapshot(8)) })

    const deepseek = defaultModelProviderSettings().providers[0]!
    const minimax = modelProviderPresetProfile(getModelProviderPreset('minimax')!, '')!

    await commitInitialSetupRegistryCredentials({
      deepseek: { apiKey: 'deepseek-new', baseUrl: 'https://api.deepseek.com' },
      xiaomi: { apiKey: '', baseUrl: 'https://api.xiaomimimo.com/v1' },
      minimax: { apiKey: 'minimax-new', baseUrl: 'https://api.minimax.io/v1' }
    }, {
      profiles: [deepseek, minimax],
      selectedProviderId: 'deepseek',
      selectedModel: deepseek.models[0]!
    }, request)

    expect(request.mock.calls.map(([path, method, body]) => [
      path,
      method,
      body ? JSON.parse(body) : undefined
    ])).toEqual([
      ['/v1/model-connections', 'GET', undefined],
      ['/v1/model-connections/deepseek/credential', 'PUT', {
        expectedRevision: 4,
        credential: 'deepseek-new'
      }],
      ['/v1/model-connections/deepseek/credential', 'PUT', {
        expectedRevision: 5,
        credential: 'deepseek-new'
      }],
      ['/v1/model-connections', 'GET', undefined],
      ['/v1/model-connections/minimax/credential', 'PUT', {
        expectedRevision: 6,
        credential: 'minimax-new'
      }],
      ['/v1/model-connections', 'GET', undefined],
      ['/v1/model-connections/select', 'POST', {
        expectedRevision: 7,
        providerId: 'deepseek',
        accountId: 'account:deepseek',
        model: deepseek.models[0]
      }]
    ])
  })

  it('serializes onboarding behind an older provider-page generation so the newer key wins', async () => {
    let releaseOlder!: () => void
    const olderBlocked = new Promise<void>((resolve) => { releaseOlder = resolve })
    let olderStarted!: () => void
    const started = new Promise<void>((resolve) => { olderStarted = resolve })
    let revision = 1
    let storedCredential = ''
    const older = stageSharedProviderCredentialMutation('deepseek', 'older-key')
    const olderCommit = drainSharedProviderCredentialMutation(
      'deepseek',
      older.generation,
      async (credential) => {
        olderStarted()
        await olderBlocked
        storedCredential = credential
        revision += 1
        return revision
      }
    )
    await started

    const request = vi.fn(async (path: string, method?: string, body?: string) => {
      const snapshot = {
        schemaVersion: 1 as const,
        revision,
        providers: [{ id: 'deepseek', accountId: 'account:deepseek' }]
      }
      if (path === '/v1/model-connections' && method === 'GET') {
        return { ok: true, status: 200, body: JSON.stringify(snapshot) }
      }
      if (path === '/v1/model-connections/deepseek/credential' && method === 'PUT') {
        const payload = JSON.parse(body ?? '{}') as { expectedRevision: number; credential: string }
        expect(payload.expectedRevision).toBe(revision)
        storedCredential = payload.credential
        revision += 1
        return {
          ok: true,
          status: 200,
          body: JSON.stringify({ ...snapshot, revision })
        }
      }
      if (path === '/v1/model-connections/select' && method === 'POST') {
        revision += 1
        return {
          ok: true,
          status: 200,
          body: JSON.stringify({ ...snapshot, revision })
        }
      }
      throw new Error(`Unexpected request: ${method} ${path}`)
    })
    const onboardingCommit = commitInitialSetupRegistryCredentials({
      deepseek: { apiKey: 'newer-key', baseUrl: 'https://api.deepseek.com' }
    }, {
      profiles: defaultModelProviderSettings().providers,
      selectedProviderId: 'deepseek',
      selectedModel: defaultModelProviderSettings().providers[0]!.models[0]!
    }, request)
    await Promise.resolve()
    expect(request).not.toHaveBeenCalled()

    releaseOlder()
    await Promise.all([olderCommit, onboardingCommit])
    expect(storedCredential).toBe('newer-key')
  })

  it('keeps required first-run setup modal-only until the runtime is ready, then opens Code', async () => {
    const reloadUiSettings = vi.fn(async () => undefined)
    const probeRuntime = vi.fn(async () => undefined)
    const openCode = vi.fn(async () => undefined)
    const closeInitialSetup = vi.fn()
    const setDialogError = vi.fn()

    const completed = await completeInitialSetupAfterSave({
      mode: 'required',
      reloadUiSettings,
      probeRuntime,
      openCode,
      closeInitialSetup,
      getState: () => ({ runtimeConnection: 'ready', error: null }),
      setDialogError,
      fallbackRuntimeError: 'Could not reach Kun.'
    })

    expect(completed).toBe(true)
    expect(reloadUiSettings).toHaveBeenCalledTimes(1)
    expect(probeRuntime).toHaveBeenCalledWith('user')
    expect(openCode).toHaveBeenCalledTimes(1)
    expect(closeInitialSetup).toHaveBeenCalledTimes(1)
    expect(setDialogError).not.toHaveBeenCalled()
  })

  it('does not close required first-run setup when the runtime cannot connect', async () => {
    const closeInitialSetup = vi.fn()
    const openCode = vi.fn(async () => undefined)
    const setDialogError = vi.fn()

    const completed = await completeInitialSetupAfterSave({
      mode: 'required',
      reloadUiSettings: vi.fn(async () => undefined),
      probeRuntime: vi.fn(async () => undefined),
      openCode,
      closeInitialSetup,
      getState: () => ({ runtimeConnection: 'offline', error: 'Port is busy.' }),
      setDialogError,
      fallbackRuntimeError: 'Could not reach Kun.'
    })

    expect(completed).toBe(false)
    expect(openCode).not.toHaveBeenCalled()
    expect(closeInitialSetup).not.toHaveBeenCalled()
    expect(setDialogError).toHaveBeenCalledWith('Port is busy.')
  })

  it('keeps preview setup dismissible and avoids forcing the user into Code', async () => {
    const probeRuntime = vi.fn(async () => undefined)
    const openCode = vi.fn(async () => undefined)
    const closeInitialSetup = vi.fn()

    const completed = await completeInitialSetupAfterSave({
      mode: 'preview',
      reloadUiSettings: vi.fn(async () => undefined),
      probeRuntime,
      openCode,
      closeInitialSetup,
      getState: () => ({ runtimeConnection: 'offline', error: null }),
      setDialogError: vi.fn(),
      fallbackRuntimeError: 'Could not reach Kun.'
    })

    expect(completed).toBe(true)
    expect(probeRuntime).toHaveBeenCalledWith('background')
    expect(openCode).not.toHaveBeenCalled()
    expect(closeInitialSetup).toHaveBeenCalledTimes(1)
  })

  it('allows users to dismiss both required and preview setup flows', () => {
    expect(canCloseInitialSetup('required')).toBe(true)
    expect(canCloseInitialSetup('preview')).toBe(true)
  })

  it('persists a required dismissal and starts probing Kun after closing', async () => {
    const persistCompletion = vi.fn(async () => undefined)
    const reloadUiSettings = vi.fn(async () => undefined)
    const probeRuntime = vi.fn(async () => undefined)
    const closeInitialSetup = vi.fn()

    await dismissInitialSetup({
      mode: 'required',
      persistCompletion,
      reloadUiSettings,
      probeRuntime,
      closeInitialSetup
    })

    expect(persistCompletion).toHaveBeenCalledTimes(1)
    expect(reloadUiSettings).toHaveBeenCalledTimes(1)
    expect(closeInitialSetup).toHaveBeenCalledTimes(1)
    expect(probeRuntime).toHaveBeenCalledWith('user')
  })

  it('does not persist or start Kun when closing the settings preview', async () => {
    const persistCompletion = vi.fn(async () => undefined)
    const probeRuntime = vi.fn(async () => undefined)
    const closeInitialSetup = vi.fn()

    await dismissInitialSetup({
      mode: 'preview',
      persistCompletion,
      reloadUiSettings: vi.fn(async () => undefined),
      probeRuntime,
      closeInitialSetup
    })

    expect(persistCompletion).not.toHaveBeenCalled()
    expect(probeRuntime).not.toHaveBeenCalled()
    expect(closeInitialSetup).toHaveBeenCalledTimes(1)
  })

  it('recognizes unreadable protected credential errors across the Electron IPC wrapper', () => {
    expect(isUnreadableCredentialKeyError(new Error(
      "Error invoking remote method 'settings:set': credential_key_unreadable: existing key is unavailable"
    ))).toBe(true)
    expect(isUnreadableCredentialKeyError(new Error('Kun runtime is offline'))).toBe(false)
  })
})
