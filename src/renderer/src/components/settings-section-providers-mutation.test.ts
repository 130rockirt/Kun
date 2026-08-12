import {
  defaultModelProviderSettings,
  type ModelProviderModelProfileV1
} from '@shared/app-settings'
import { describe, expect, it, vi } from 'vitest'
import {
  clearPendingSharedProviderDeletionForExplicitAdd,
  createSharedModelMutationQueue,
  projectSharedModelConnections,
  selectSharedModelConnection,
  sharedProvidersEligibleForSync
} from './settings-section-providers'
import {
  drainSharedProviderCredentialMutation,
  enqueueSharedModelMutation,
  resetSharedProviderMutationCoordinatorForTests,
  sharedProviderMutationCoordinator,
  stageSharedProviderCredentialMutation
} from './shared-provider-mutation-coordinator'

const textModelProfile: ModelProviderModelProfileV1 = {
  inputModalities: ['text'],
  outputModalities: ['text'],
  supportsToolCalling: true,
  messageParts: ['text']
}

describe('shared model connection mutation ordering', () => {
  it('continues processing after an earlier queued mutation fails', async () => {
    const enqueue = createSharedModelMutationQueue()
    const operations: string[] = []

    await expect(enqueue(async () => {
      operations.push('failed')
      throw new Error('expected failure')
    })).rejects.toThrow('expected failure')
    await expect(enqueue(async () => {
      operations.push('continued')
      return 'ok'
    })).resolves.toBe('ok')

    expect(operations).toEqual(['failed', 'continued'])
  })

  it('lets an immediate credential fence settle but cancels its queued mutation before deletion', async () => {
    resetSharedProviderMutationCoordinatorForTests()
    let releaseFence!: () => void
    const fenceGate = new Promise<void>((resolve) => { releaseFence = resolve })
    let pendingDeletion = false
    const operations: string[] = []
    const staged = stageSharedProviderCredentialMutation(
      'deepseek',
      'stale-secret',
      async () => fenceGate
    )
    const credentialDrain = drainSharedProviderCredentialMutation(
      'deepseek',
      staged.generation,
      async () => {
        if (pendingDeletion) throw new Error('provider is pending deletion')
        operations.push('credential')
      }
    )
    const credentialExpectation = expect(credentialDrain).rejects.toThrow('pending deletion')

    pendingDeletion = true
    const deletion = enqueueSharedModelMutation(async () => {
      operations.push('delete')
      sharedProviderMutationCoordinator.pendingCredentials.delete('deepseek')
    })
    releaseFence()

    await credentialExpectation
    await deletion
    expect(operations).toEqual(['delete'])
    expect(sharedProviderMutationCoordinator.pendingCredentials.has('deepseek')).toBe(false)
  })

  it('lets an immediate credential fence make an in-flight catalog drain conflict safely', async () => {
    resetSharedProviderMutationCoordinatorForTests()
    const operations: string[] = []
    let fenceInstalled = false
    let catalogStarted!: () => void
    const started = new Promise<void>((resolve) => { catalogStarted = resolve })
    let releaseCatalog!: () => void
    const catalogGate = new Promise<void>((resolve) => { releaseCatalog = resolve })
    const catalog = enqueueSharedModelMutation(async () => {
      operations.push('catalog:start')
      catalogStarted()
      await catalogGate
      if (fenceInstalled) {
        operations.push('catalog:conflict')
        throw new Error('provider credential replacement is pending')
      }
      operations.push('catalog:commit')
    })
    const catalogExpectation = expect(catalog).rejects.toThrow('replacement is pending')
    await started

    const staged = stageSharedProviderCredentialMutation(
      'deepseek',
      'new-secret',
      async () => {
        operations.push('fence')
        fenceInstalled = true
      }
    )
    await staged.fence
    const credential = drainSharedProviderCredentialMutation(
      'deepseek',
      staged.generation,
      async () => { operations.push('credential:commit') }
    )
    releaseCatalog()

    await catalogExpectation
    await expect(credential).resolves.toMatchObject({ committed: true })
    expect(operations).toEqual([
      'catalog:start',
      'fence',
      'catalog:conflict',
      'credential:commit'
    ])
  })

  it('finishes an in-flight stale connect before deletion and blocks queued stale reconnects', async () => {
    const enqueue = createSharedModelMutationQueue()
    const pendingDeletions = new Set<string>()
    const providers = [{ id: 'custom-provider-2' }]
    const operations: string[] = []
    let releaseConnect!: () => void
    let markConnectStarted!: () => void
    const connectGate = new Promise<void>((resolve) => { releaseConnect = resolve })
    const connectStarted = new Promise<void>((resolve) => { markConnectStarted = resolve })
    const inFlightSync = enqueue(async () => {
      operations.push('connect:start')
      markConnectStarted()
      await connectGate
      operations.push('connect:finish')
    })
    await connectStarted

    pendingDeletions.add(providers[0]!.id)
    const deletion = enqueue(async () => { operations.push('delete') })
    const queuedStaleSync = enqueue(async () => {
      for (const provider of sharedProvidersEligibleForSync(providers, pendingDeletions)) {
        operations.push(`connect:after-delete:${provider.id}`)
      }
    })
    releaseConnect()
    await Promise.all([inFlightSync, deletion, queuedStaleSync])

    expect(operations).toEqual(['connect:start', 'connect:finish', 'delete'])
  })

  it('queues the selection read and commit between sync and deletion without interleaving', async () => {
    const enqueue = createSharedModelMutationQueue()
    const operations: string[] = []
    let releaseSync!: () => void
    let markSyncStarted!: () => void
    const syncGate = new Promise<void>((resolve) => { releaseSync = resolve })
    const syncStarted = new Promise<void>((resolve) => { markSyncStarted = resolve })
    const provider = {
      id: 'custom-provider-2',
      accountId: 'account:custom-provider-2',
      name: 'Custom Provider',
      kind: 'http',
      authType: 'api-key',
      configured: true,
      models: ['custom-model']
    }
    const snapshot = (revision: number) => ({
      schemaVersion: 1,
      revision,
      providers: [provider]
    })
    const runtimeRequest = vi.fn(async (path: string, method: string, _body?: string) => {
      operations.push(method === 'GET' ? 'select:read' : 'select:commit')
      return {
        ok: true,
        status: 200,
        body: JSON.stringify(method === 'GET' ? snapshot(13) : snapshot(14))
      }
    })
    vi.stubGlobal('window', { kunGui: { runtimeRequest } })

    try {
      const sync = enqueue(async () => {
        operations.push('sync:start')
        markSyncStarted()
        await syncGate
        operations.push('sync:finish')
      })
      await syncStarted
      const selection = enqueue(() => selectSharedModelConnection(
        provider.id,
        'custom-model'
      ))
      const deletion = enqueue(async () => { operations.push('delete') })

      expect(runtimeRequest).not.toHaveBeenCalled()
      releaseSync()
      await Promise.all([sync, selection, deletion])

      expect(operations).toEqual([
        'sync:start',
        'sync:finish',
        'select:read',
        'select:commit',
        'delete'
      ])
      expect(JSON.parse(runtimeRequest.mock.calls[1]![2] ?? '{}')).toMatchObject({ expectedRevision: 13 })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('makes an explicitly re-added provider eligible for sync again', () => {
    const provider = { id: 'custom-provider-2' }
    const pendingDeletions = new Map([[
      provider.id,
      { generation: 1, committedRevision: 17 }
    ]])

    clearPendingSharedProviderDeletionForExplicitAdd(pendingDeletions, provider.id)

    expect(pendingDeletions.has(provider.id)).toBe(false)
    expect(sharedProvidersEligibleForSync([provider], pendingDeletions)).toEqual([provider])
  })
})

describe('shared model connection settings projection', () => {
  it('projects a TUI-owned default without clearing existing protected compatibility credentials', () => {
    const current = defaultModelProviderSettings()
    current.providers[0]!.apiKey = 'legacy-plaintext'

    const projected = projectSharedModelConnections(current, {
      schemaVersion: 1,
      revision: 4,
      providers: [{
        id: 'codex',
        accountId: 'account:codex',
        name: 'Codex',
        kind: 'http',
        authType: 'subscription',
        baseUrl: 'https://example.test/codex',
        endpointFormat: 'responses',
        configured: true,
        models: ['gpt-live'],
        selectedModel: 'gpt-live'
      }],
      defaultProviderId: 'codex',
      defaultAccountId: 'account:codex',
      defaultModel: 'gpt-live',
      proxy: { enabled: false, url: '' },
      routePools: [],
      localModelGateway: { enabled: false }
    })

    expect(projected.kun).toEqual({ providerId: 'codex', model: 'gpt-live' })
    expect(projected.provider.providers.find((provider) => provider.id === 'codex')).toMatchObject({
      apiKey: '',
      models: ['gpt-live']
    })
    expect(projected.provider.providers.find((provider) => provider.id === 'deepseek')?.apiKey)
      .toBe('legacy-plaintext')
  })

  it('clears an existing settings credential while applying shared registry metadata', () => {
    const current = defaultModelProviderSettings()
    current.providers.push({
      ...current.providers[0]!,
      id: 'custom',
      name: 'Old name',
      apiKey: 'protected-runtime-value',
      baseUrl: 'https://old.example/v1',
      models: ['old-model']
    })

    const projected = projectSharedModelConnections(current, {
      schemaVersion: 1,
      revision: 7,
      providers: [{
        id: 'custom',
        accountId: 'account:custom',
        name: 'Shared name',
        kind: 'http',
        authType: 'api-key',
        baseUrl: 'https://new.example/v1',
        endpointFormat: 'chat_completions',
        configured: true,
        models: ['new-model']
      }]
    })

    expect(projected.provider.providers.find((provider) => provider.id === 'custom')).toMatchObject({
      apiKey: '',
      baseUrl: 'https://new.example/v1',
      models: ['new-model']
    })
  })

  it('clears the GUI provider without emitting an invalid empty model', () => {
    const projected = projectSharedModelConnections(defaultModelProviderSettings(), {
      schemaVersion: 1,
      revision: 5,
      providers: [],
      proxy: { enabled: false, url: '' },
      routePools: [],
      localModelGateway: { enabled: false }
    })

    expect(projected.kun).toEqual({ providerId: '' })
  })

  it('keeps the in-progress route and local gateway configuration over a stale registry snapshot', () => {
    const current = defaultModelProviderSettings()
    current.localGateway = { name: 'My local relay', enabled: true }
    current.routePools = [{
      id: 'local-route-1',
      name: 'Local route',
      modelId: 'local-chat',
      enabled: true,
      strategy: 'priority',
      targets: [{ id: 'target-1', providerId: 'deepseek', modelId: 'deepseek-chat', enabled: true, weight: 1 }],
      failurePolicy: { failoverHttpStatusCodes: [429, 503], failoverOnNetworkError: true, failoverOnTimeout: true, failoverOnAuthError: true },
      healthPolicy: { failureThreshold: 3, cooldownMs: 60_000, halfOpenMaxAttempts: 1 }
    }]

    const projected = projectSharedModelConnections(current, {
      schemaVersion: 1,
      revision: 9,
      providers: [],
      routePools: [],
      localModelGateway: { enabled: false }
    })

    expect(projected.provider.routePools).toEqual(current.routePools)
    expect(projected.provider.localGateway).toEqual(current.localGateway)
  })

  it('drops invalid shared capability limits before projecting AppSettings', () => {
    const projected = projectSharedModelConnections(defaultModelProviderSettings(), {
      schemaVersion: 1,
      revision: 6,
      providers: [{
        id: 'zenmux',
        accountId: 'account:zenmux',
        name: 'ZenMux',
        kind: 'http',
        authType: 'api-key',
        baseUrl: 'https://zenmux.ai/api/v1',
        endpointFormat: 'chat_completions',
        configured: true,
        models: ['qwen/qwen3.5-flash'],
        modelCapabilities: {
          'qwen/qwen3.5-flash': {
            id: 'qwen/qwen3.5-flash',
            inputModalities: ['text', 'image'],
            outputModalities: ['text'],
            supportsToolCalling: true,
            messageParts: ['text', 'image_url'],
            contextWindowTokens: 1_020_000,
            maxOutputTokens: 1_020_000
          }
        }
      }]
    })
    const profile = projected.provider.providers.find((provider) => provider.id === 'zenmux')
      ?.modelProfiles['qwen/qwen3.5-flash']

    expect(profile).toMatchObject({
      contextWindowTokens: 1_020_000,
      inputModalities: ['text', 'image']
    })
    expect(profile?.maxOutputTokens).toBeUndefined()
  })

  it('does not restore a provider while its canonical deletion is pending', () => {
    const current = defaultModelProviderSettings()
    const projected = projectSharedModelConnections(current, {
      schemaVersion: 1,
      revision: 8,
      providers: [{
        id: 'custom-provider-2',
        accountId: 'account:custom-provider-2',
        name: 'Custom Provider',
        kind: 'http',
        authType: 'api-key',
        baseUrl: 'https://api.example.com/v1',
        endpointFormat: 'chat_completions',
        configured: true,
        models: ['custom-model'],
        selectedModel: 'custom-model'
      }],
      defaultProviderId: 'custom-provider-2',
      defaultAccountId: 'account:custom-provider-2',
      defaultModel: 'custom-model'
    }, new Map([['custom-provider-2', { generation: 1, committedRevision: 8 }]]))

    expect(projected.provider.providers.map((provider) => provider.id)).toEqual(['deepseek'])
    expect(projected.kun).toEqual({ providerId: '' })
  })
})
