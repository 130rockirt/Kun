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
    let revision = 4
    let deepseekConflictPending = true
    const latestFence = new Map<string, string>()
    const preparedCredentials = new Map<string, string>()
    const committedCredentials = new Map<string, string>()
    const snapshot = (revision: number) => ({
      schemaVersion: 1,
      revision,
      providers: [
        { id: 'deepseek', accountId: 'account:deepseek' },
        { id: 'minimax', accountId: 'account:minimax' }
      ]
    })
    const request = vi.fn(async (path: string, method?: string, body?: string) => {
      const payload = body ? JSON.parse(body) as Record<string, unknown> : {}
      if (path === '/v1/model-connections' && method === 'GET') {
        return { ok: true, status: 200, body: JSON.stringify(snapshot(revision)) }
      }
      const match = path.match(/^\/v1\/model-connections\/([^/]+)\/credential(?:\/(fence|commit))?$/u)
      if (match && method === 'POST' && match[2] === 'fence') {
        latestFence.set(match[1]!, String(payload.operationToken))
        return { ok: true, status: 200, body: JSON.stringify(snapshot(revision)) }
      }
      if (match && method === 'PUT' && !match[2]) {
        const providerId = match[1]!
        const operationToken = String(payload.operationToken)
        expect(operationToken).toBe(latestFence.get(providerId))
        if (providerId === 'deepseek' && deepseekConflictPending) {
          deepseekConflictPending = false
          revision = 5
          return {
            ok: false,
            status: 409,
            body: JSON.stringify({ snapshot: snapshot(revision) })
          }
        }
        expect(payload.expectedRevision).toBe(revision)
        preparedCredentials.set(operationToken, String(payload.credential))
        return { ok: true, status: 200, body: JSON.stringify(snapshot(revision)) }
      }
      if (match && method === 'POST' && match[2] === 'commit') {
        const providerId = match[1]!
        const operationToken = String(payload.operationToken)
        expect(operationToken).toBe(latestFence.get(providerId))
        expect(payload.expectedRevision).toBe(revision)
        committedCredentials.set(providerId, preparedCredentials.get(operationToken) ?? '')
        revision += 1
        return { ok: true, status: 200, body: JSON.stringify(snapshot(revision)) }
      }
      if (path === '/v1/model-connections/select' && method === 'POST') {
        expect(payload.expectedRevision).toBe(revision)
        revision += 1
        return { ok: true, status: 200, body: JSON.stringify(snapshot(revision)) }
      }
      throw new Error(`Unexpected request: ${method} ${path}`)
    })

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

    const calls = request.mock.calls.map(([path, method, body]) => [
      path,
      method,
      body ? JSON.parse(body) : undefined
    ] as const)
    const deepseekFence = calls.find(([path]) =>
      path === '/v1/model-connections/deepseek/credential/fence'
    )?.[2] as { operationToken: string }
    const minimaxFence = calls.find(([path]) =>
      path === '/v1/model-connections/minimax/credential/fence'
    )?.[2] as { operationToken: string }
    const fenceCalls = calls.filter(([path]) => path.endsWith('/credential/fence'))
    expect(fenceCalls.filter(([path, , body]) =>
      path.includes('/deepseek/') &&
      (body as { operationToken: string }).operationToken === deepseekFence.operationToken
    )).toHaveLength(3)
    expect(fenceCalls.filter(([path, , body]) =>
      path.includes('/minimax/') &&
      (body as { operationToken: string }).operationToken === minimaxFence.operationToken
    )).toHaveLength(2)
    expect(calls.filter(([path, method]) =>
      path === '/v1/model-connections/deepseek/credential' && method === 'PUT'
    ).map(([, , body]) => body)).toEqual([
      { expectedRevision: 4, credential: 'deepseek-new', operationToken: deepseekFence.operationToken },
      { expectedRevision: 5, credential: 'deepseek-new', operationToken: deepseekFence.operationToken }
    ])
    expect(calls.find(([path]) =>
      path === '/v1/model-connections/deepseek/credential/commit'
    )?.[2]).toEqual({ expectedRevision: 5, operationToken: deepseekFence.operationToken })
    expect(calls.find(([path]) =>
      path === '/v1/model-connections/minimax/credential'
    )?.[2]).toEqual({
      expectedRevision: 6,
      credential: 'minimax-new',
      operationToken: minimaxFence.operationToken
    })
    expect(calls.find(([path]) =>
      path === '/v1/model-connections/minimax/credential/commit'
    )?.[2]).toEqual({ expectedRevision: 6, operationToken: minimaxFence.operationToken })
    expect(calls.find(([path]) => path === '/v1/model-connections/select')?.[2]).toEqual({
      expectedRevision: 7,
      providerId: 'deepseek',
      accountId: 'account:deepseek',
      model: deepseek.models[0]
    })
    expect(committedCredentials).toEqual(new Map([
      ['deepseek', 'deepseek-new'],
      ['minimax', 'minimax-new']
    ]))
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

    let latestFence = ''
    const preparedCredentials = new Map<string, string>()
    const request = vi.fn(async (path: string, method?: string, body?: string) => {
      const snapshot = {
        schemaVersion: 1 as const,
        revision,
        providers: [{ id: 'deepseek', accountId: 'account:deepseek' }]
      }
      if (path === '/v1/model-connections' && method === 'GET') {
        return { ok: true, status: 200, body: JSON.stringify(snapshot) }
      }
      if (path === '/v1/model-connections/deepseek/credential/fence' && method === 'POST') {
        latestFence = (JSON.parse(body ?? '{}') as { operationToken: string }).operationToken
        return { ok: true, status: 200, body: JSON.stringify(snapshot) }
      }
      if (path === '/v1/model-connections/deepseek/credential' && method === 'PUT') {
        const payload = JSON.parse(body ?? '{}') as {
          expectedRevision: number
          credential: string
          operationToken: string
        }
        expect(payload.expectedRevision).toBe(revision)
        expect(payload.operationToken).toBe(latestFence)
        preparedCredentials.set(payload.operationToken, payload.credential)
        return {
          ok: true,
          status: 200,
          body: JSON.stringify(snapshot)
        }
      }
      if (path === '/v1/model-connections/deepseek/credential/commit' && method === 'POST') {
        const payload = JSON.parse(body ?? '{}') as {
          expectedRevision: number
          operationToken: string
        }
        expect(payload.expectedRevision).toBe(revision)
        expect(payload.operationToken).toBe(latestFence)
        storedCredential = preparedCredentials.get(payload.operationToken) ?? ''
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
    await Promise.resolve()
    expect(request.mock.calls.some(([path]) =>
      path === '/v1/model-connections/deepseek/credential/fence'
    )).toBe(true)
    expect(request.mock.calls.some(([path, method]) =>
      path === '/v1/model-connections/deepseek/credential' && method === 'PUT'
    )).toBe(false)

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
