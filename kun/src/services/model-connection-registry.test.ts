import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ExtensionCredentialStore } from './extension-credential-store.js'
import {
  ModelConnectionConflictError,
  ModelConnectionRegistry
} from './model-connection-registry.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function registry(modelCapabilities?: ConstructorParameters<typeof ModelConnectionRegistry>[0]['modelCapabilities']) {
  const dataDir = await mkdtemp(join(tmpdir(), 'kun-model-connections-'))
  roots.push(dataDir)
  const credentials = new ExtensionCredentialStore({ dataDir, profileId: 'test' })
  const applied: string[] = []
  const value = new ModelConnectionRegistry({
    dataDir,
    credentials,
    ...(modelCapabilities ? { modelCapabilities } : {}),
    onChanged: (connections) => {
      if (connections.selected) applied.push(`${connections.selected.profile.id}/${connections.selected.model}`)
    }
  })
  await value.initialize()
  return { dataDir, value, applied }
}

describe('ModelConnectionRegistry', () => {
  it('applies concurrent GUI/TUI revisions to the live runtime in durable order', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'kun-model-connections-'))
    roots.push(dataDir)
    const credentials = new ExtensionCredentialStore({ dataDir, profileId: 'test' })
    const applied: string[] = []
    let releaseFirst!: () => void
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let markFirstStarted!: () => void
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve
    })
    const value = new ModelConnectionRegistry({
      dataDir,
      credentials,
      onChanged: async (connections) => {
        const model = connections.selected?.model
        if (!model) return
        if (model === 'model-a') {
          markFirstStarted()
          await firstBlocked
        }
        applied.push(model)
      }
    })
    await value.initialize()

    const first = value.connect({
      expectedRevision: 0,
      id: 'shared',
      name: 'Shared provider',
      kind: 'http',
      authType: 'api-key',
      baseUrl: 'https://provider.example/v1',
      endpointFormat: 'chat_completions',
      credential: 'secret',
      models: ['model-a', 'model-b'],
      selectedModel: 'model-a',
      probe: false,
      select: true
    })
    await firstStarted
    const revisionOne = await value.snapshot()
    const second = value.select({
      expectedRevision: revisionOne.revision,
      providerId: 'shared',
      accountId: 'account:shared',
      model: 'model-b'
    })
    await vi.waitFor(async () => {
      expect((await value.snapshot()).revision).toBe(2)
    })

    releaseFirst()
    await Promise.all([first, second])

    expect(applied).toEqual(['model-a', 'model-b'])
    expect((await value.snapshot()).defaultModel).toBe('model-b')
  })

  it('stores secrets only in protected storage and allocates stable account names', async () => {
    const { dataDir, value } = await registry()
    const first = await value.connect({
      expectedRevision: 0,
      name: 'Kimi Code',
      presetSource: 'kimi-code',
      kind: 'http',
      authType: 'subscription',
      baseUrl: 'https://api.kimi.com/coding/v1',
      endpointFormat: 'chat_completions',
      credential: 'sk-secret-one',
      models: ['kimi-k2.5'],
      selectedModel: 'kimi-k2.5',
      probe: false,
      select: true
    })
    const second = await value.connect({
      expectedRevision: first.revision,
      name: 'Kimi Code',
      presetSource: 'kimi-code',
      kind: 'http',
      authType: 'subscription',
      baseUrl: 'https://api.kimi.com/coding/v1',
      endpointFormat: 'chat_completions',
      credential: 'sk-secret-two',
      models: ['kimi-k2.5'],
      probe: false,
      select: false
    })

    expect(second.providers.map((provider) => provider.id)).toEqual(['kimi-code', 'kimi-code-2'])
    expect(JSON.stringify(second)).not.toContain('sk-secret')
    expect(await readFile(join(dataDir, 'model-connections.v1.json'), 'utf8')).not.toContain('sk-secret')
    expect(await readFile(join(dataDir, 'credentials', 'credentials.enc.json'), 'utf8')).not.toContain('sk-secret')
  })

  it('rejects a provider selection carrying another account identifier', async () => {
    const { value } = await registry()
    const connected = await value.connect({
      expectedRevision: 0,
      id: 'provider-a',
      name: 'Provider A',
      baseUrl: 'https://provider.example/v1',
      credential: 'secret',
      models: ['model-a'],
      selectedModel: 'model-a',
      probe: false,
      select: true
    })

    await expect(value.select({
      expectedRevision: connected.revision,
      providerId: 'provider-a',
      accountId: 'account:provider-b',
      model: 'model-a'
    })).rejects.toThrow('account does not belong')
  })

  it('clears a disconnected HTTP credential without deleting the provider catalog', async () => {
    const { value } = await registry()
    const connected = await value.connect({
      expectedRevision: 0,
      id: 'custom',
      name: 'Custom',
      baseUrl: 'https://example.test/v1',
      credential: 'secret',
      models: ['model-a'],
      selectedModel: 'model-a',
      probe: false,
      select: true
    })

    const cleared = await value.clearCredential('custom', connected.revision)
    expect(cleared.providers[0]).toMatchObject({
      id: 'custom',
      configured: false,
      models: ['model-a']
    })
    expect(cleared.defaultProviderId).toBeUndefined()
    expect(cleared.defaultModel).toBeUndefined()
    expect((await value.materialize()).providers.get('custom')?.apiKey).toBe('')
  })

  it('moves the shared default to another connected provider when its credential is cleared', async () => {
    const { value } = await registry()
    const fallback = await value.connect({
      expectedRevision: 0,
      id: 'fallback',
      name: 'Fallback',
      baseUrl: 'https://fallback.example/v1',
      credential: 'fallback-secret',
      models: ['model-f'],
      selectedModel: 'model-f',
      probe: false,
      select: false
    })
    const selected = await value.connect({
      expectedRevision: fallback.revision,
      id: 'selected',
      name: 'Selected',
      baseUrl: 'https://selected.example/v1',
      credential: 'selected-secret',
      models: ['model-s'],
      selectedModel: 'model-s',
      probe: false,
      select: true
    })

    const cleared = await value.clearCredential('selected', selected.revision)
    expect(cleared).toMatchObject({
      defaultProviderId: 'fallback',
      defaultAccountId: 'account:fallback',
      defaultModel: 'model-f'
    })
    expect(cleared.providers.find((provider) => provider.id === 'selected')).toMatchObject({
      configured: false
    })
  })

  it('synchronizes an explicit configured default without changing it during ordinary catalog initialization', async () => {
    const { value, applied } = await registry()
    const first = await value.connect({
      expectedRevision: 0,
      id: 'deepseek',
      name: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com',
      credential: 'deepseek-secret',
      models: ['deepseek-chat'],
      selectedModel: 'deepseek-chat',
      probe: false,
      select: true
    })
    const second = await value.connect({
      expectedRevision: first.revision,
      id: 'codex',
      name: 'Codex',
      baseUrl: 'https://example.test/codex',
      credential: 'codex-secret',
      models: ['gpt-next'],
      selectedModel: 'gpt-next',
      probe: false,
      select: false
    })

    const imported = await value.initialize([{
      expectedRevision: second.revision,
      id: 'codex',
      name: 'Codex',
      kind: 'http',
      authType: 'subscription',
      baseUrl: 'https://example.test/codex',
      endpointFormat: 'responses',
      models: ['gpt-next'],
      selectedModel: 'gpt-next',
      probe: false,
      select: true
    }])
    expect(imported).toMatchObject({
      defaultProviderId: 'deepseek',
      defaultModel: 'deepseek-chat'
    })

    const synchronized = await value.synchronizeDefaultSelection({
      providerId: 'codex',
      model: 'gpt-next'
    })
    expect(synchronized).toMatchObject({
      revision: imported.revision + 1,
      defaultProviderId: 'codex',
      defaultAccountId: 'account:codex',
      defaultModel: 'gpt-next'
    })
    expect(applied.at(-1)).toBe('codex/gpt-next')
    await expect(value.synchronizeDefaultSelection({
      providerId: 'codex',
      model: 'gpt-next'
    })).resolves.toMatchObject({ revision: synchronized.revision })
  })

  it('does not commit a custom provider when model discovery fails and can explicitly use supplied models', async () => {
    const { dataDir, value } = await registry()
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('not found', { status: 404 }))
    try {
      await expect(value.connect({
        expectedRevision: 0,
        id: 'company-proxy',
        name: 'Company Proxy',
        baseUrl: 'https://models.company.test/v1',
        endpointFormat: 'responses',
        credential: 'probe-secret',
        models: ['company-model'],
        selectedModel: 'company-model',
        probe: true,
        select: true
      })).rejects.toThrow('provider probe failed with HTTP 404')

      const failed = await value.snapshot()
      expect(failed).toMatchObject({ revision: 0, providers: [] })
      expect(await readFile(join(dataDir, 'model-connections.v1.json'), 'utf8').catch(() => ''))
        .not.toContain('company-proxy')

      const connected = await value.connect({
        expectedRevision: failed.revision,
        id: 'company-proxy',
        name: 'Company Proxy',
        baseUrl: 'https://models.company.test/v1',
        endpointFormat: 'responses',
        credential: 'probe-secret',
        models: ['company-model'],
        selectedModel: 'company-model',
        probe: false,
        select: true
      })
      expect(connected).toMatchObject({
        revision: 1,
        defaultProviderId: 'company-proxy',
        defaultModel: 'company-model'
      })
      expect(JSON.stringify(connected)).not.toContain('probe-secret')
      expect(await readFile(join(dataDir, 'model-connections.v1.json'), 'utf8')).not.toContain('probe-secret')
    } finally {
      fetchMock.mockRestore()
    }
  })

  it('projects secret-free per-model capabilities without persisting derived metadata', async () => {
    const { dataDir, value } = await registry((model) => ({
      id: model,
      inputModalities: ['text'],
      outputModalities: ['text'],
      supportsToolCalling: true,
      messageParts: ['text'],
      reasoning: {
        supportedEfforts: ['off', 'low', 'high'],
        defaultEffort: 'high',
        requestProtocol: 'deepseek-chat-completions'
      }
    }))
    const snapshot = await value.connect({
      expectedRevision: 0,
      name: 'Reasoning provider',
      baseUrl: 'https://example.com/v1',
      credential: 'secret',
      models: ['reasoning-model'],
      selectedModel: 'reasoning-model',
      probe: false
    })

    expect(snapshot.providers[0]?.modelCapabilities?.['reasoning-model']?.reasoning).toMatchObject({
      supportedEfforts: ['off', 'low', 'high'], defaultEffort: 'high'
    })
    expect(await readFile(join(dataDir, 'model-connections.v1.json'), 'utf8')).not.toContain('modelCapabilities')
  })

  it('persists provider-authored secret-free capabilities and keeps them authoritative', async () => {
    const { dataDir, value } = await registry(() => ({
      id: 'reasoning-model',
      inputModalities: ['text'],
      outputModalities: ['text'],
      supportsToolCalling: true,
      messageParts: ['text'],
      reasoning: {
        supportedEfforts: ['high'],
        defaultEffort: 'high',
        requestProtocol: 'none'
      }
    }))
    const snapshot = await value.connect({
      expectedRevision: 0,
      name: 'GUI-configured provider',
      baseUrl: 'https://example.com/v1',
      credential: 'secret',
      models: ['reasoning-model'],
      modelCapabilities: {
        'reasoning-model': {
          id: 'reasoning-model',
          inputModalities: ['text'],
          outputModalities: ['text'],
          supportsToolCalling: true,
          messageParts: ['text'],
          reasoning: {
            supportedEfforts: ['low', 'medium', 'high'],
            defaultEffort: 'medium',
            requestProtocol: 'openai-responses'
          }
        }
      },
      selectedModel: 'reasoning-model',
      probe: false
    })

    expect(snapshot.providers[0]?.modelCapabilities?.['reasoning-model']?.reasoning).toEqual({
      supportedEfforts: ['low', 'medium', 'high'],
      defaultEffort: 'medium',
      requestProtocol: 'openai-responses'
    })
    const stored = await readFile(join(dataDir, 'model-connections.v1.json'), 'utf8')
    expect(stored).toContain('"modelCapabilities"')
    expect(stored).not.toContain('secret')
    const materialized = await value.materialize()
    expect(materialized.selected?.config).toMatchObject({
      models: ['reasoning-model'],
      selectedModel: 'reasoning-model',
      modelCapabilities: {
        'reasoning-model': {
          reasoning: {
            supportedEfforts: ['low', 'medium', 'high'],
            requestProtocol: 'openai-responses'
          }
        }
      }
    })
  })

  it('fills missing reasoning from the selected provider without replacing stored model metadata', async () => {
    const { value } = await registry((model, profile) => ({
      id: model,
      inputModalities: ['text'],
      outputModalities: ['text'],
      supportsToolCalling: true,
      messageParts: ['text'],
      reasoning: {
        supportedEfforts: profile?.id === 'zenmux' ? ['low', 'medium', 'high'] : ['high'],
        defaultEffort: 'medium',
        requestProtocol: 'openai-chat-completions'
      }
    }))
    const snapshot = await value.connect({
      expectedRevision: 0,
      id: 'zenmux',
      name: 'ZenMux',
      baseUrl: 'https://zenmux.ai/api/v1',
      credential: 'secret',
      models: ['openai/gpt-5.4'],
      modelCapabilities: {
        'openai/gpt-5.4': {
          id: 'openai/gpt-5.4',
          inputModalities: ['text', 'image'],
          outputModalities: ['text'],
          supportsToolCalling: true,
          messageParts: ['text', 'image_url']
        }
      },
      selectedModel: 'openai/gpt-5.4',
      probe: false
    })

    expect(snapshot.providers[0]?.modelCapabilities?.['openai/gpt-5.4']).toMatchObject({
      inputModalities: ['text', 'image'],
      reasoning: {
        supportedEfforts: ['low', 'medium', 'high'],
        requestProtocol: 'openai-chat-completions'
      }
    })
  })

  it('preserves Gemini Code Assist transport and protected OAuth material', async () => {
    const { dataDir, value } = await registry()
    const credential = JSON.stringify({
      kind: 'gemini-oauth',
      accessToken: 'gemini-access',
      refreshToken: 'gemini-refresh',
      expiresAt: Date.now() + 60_000,
      projectId: 'project-1',
      userTier: 'standard'
    })
    const snapshot = await value.connect({
      expectedRevision: 0,
      id: 'gemini-subscription',
      name: 'Gemini subscription',
      kind: 'gemini-code-assist',
      authType: 'subscription',
      baseUrl: 'https://cloudcode-pa.googleapis.com',
      endpointFormat: 'custom_endpoint',
      credential,
      models: ['gemini-3.1-pro-preview'],
      selectedModel: 'gemini-3.1-pro-preview',
      probe: false,
      select: true
    })

    expect(snapshot.providers[0]).toMatchObject({
      id: 'gemini-subscription',
      kind: 'gemini-code-assist',
      configured: true
    })
    expect(JSON.stringify(snapshot)).not.toContain('gemini-access')
    expect(await readFile(join(dataDir, 'model-connections.v1.json'), 'utf8')).not.toContain('gemini-access')
    const materialized = await value.materialize()
    expect(materialized.selected?.config).toMatchObject({
      kind: 'gemini-code-assist',
      apiKey: 'gemini-access',
      geminiAuth: {
        kind: 'gemini-oauth',
        refreshToken: 'gemini-refresh',
        projectId: 'project-1'
      }
    })
  })

  it('atomically migrates the legacy Gemini subscription transport without changing identity or default', async () => {
    const { dataDir, value } = await registry()
    const codex = await value.connect({
      expectedRevision: 0,
      id: 'codex',
      name: 'ChatGPT subscription',
      kind: 'agent-sdk',
      authType: 'subscription',
      endpointFormat: 'responses',
      models: ['gpt-5.6-luna'],
      selectedModel: 'gpt-5.6-luna',
      probe: false,
      select: true
    })
    const legacy = await value.connect({
      expectedRevision: codex.revision,
      id: 'gemini-subscription',
      name: 'Gemini subscription',
      presetSource: 'gemini-subscription',
      kind: 'gemini-code-assist',
      authType: 'subscription',
      baseUrl: 'https://cloudcode-pa.googleapis.com',
      endpointFormat: 'custom_endpoint',
      credential: JSON.stringify({
        kind: 'gemini-oauth',
        accessToken: 'gemini-access',
        refreshToken: 'gemini-refresh'
      }),
      models: ['gemini-3.1-pro-preview'],
      selectedModel: 'gemini-3.1-pro-preview',
      probe: false,
      select: false
    })
    const registryPath = join(dataDir, 'model-connections.v1.json')
    const before = JSON.parse(await readFile(registryPath, 'utf8')) as {
      profiles: Record<string, { credentialRef?: string }>
    }
    const credentialRef = before.profiles['gemini-subscription']?.credentialRef

    const migrated = await value.initialize([{
      expectedRevision: legacy.revision,
      id: 'gemini-subscription',
      name: 'Gemini subscription',
      presetSource: 'gemini-subscription',
      kind: 'antigravity-cli',
      authType: 'subscription',
      endpointFormat: 'chat_completions',
      models: ['gemini-3.1-pro-preview', 'gemini-3-flash-preview'],
      selectedModel: 'gemini-3.1-pro-preview',
      probe: false,
      select: false
    }])

    expect(migrated).toMatchObject({
      revision: legacy.revision + 1,
      defaultProviderId: 'codex',
      defaultAccountId: 'account:codex',
      defaultModel: 'gpt-5.6-luna'
    })
    expect(migrated.providers.find((profile) => profile.id === 'gemini-subscription')).toMatchObject({
      accountId: 'account:gemini-subscription',
      kind: 'antigravity-cli',
      configured: true,
      models: ['gemini-3.1-pro-preview', 'gemini-3-flash-preview'],
      selectedModel: 'gemini-3.1-pro-preview'
    })
    const after = JSON.parse(await readFile(registryPath, 'utf8')) as {
      profiles: Record<string, { credentialRef?: string; baseUrl?: string }>
    }
    expect(after.profiles['gemini-subscription']?.credentialRef).toBe(credentialRef)
    expect(after.profiles['gemini-subscription']?.baseUrl).toBeUndefined()
    const materialized = await value.materialize()
    expect(materialized.providers.get('gemini-subscription')).toMatchObject({
      kind: 'antigravity-cli',
      models: ['gemini-3.1-pro-preview', 'gemini-3-flash-preview']
    })

    const reapplied = await value.initialize([{
      expectedRevision: migrated.revision,
      id: 'gemini-subscription',
      name: 'Gemini subscription',
      presetSource: 'gemini-subscription',
      kind: 'antigravity-cli',
      authType: 'subscription',
      endpointFormat: 'chat_completions',
      models: ['gemini-3.1-pro-preview', 'gemini-3-flash-preview'],
      selectedModel: 'gemini-3.1-pro-preview',
      probe: false,
      select: false
    }])
    expect(reapplied.revision).toBe(migrated.revision)
  })

  it('returns the latest snapshot on optimistic concurrency conflicts', async () => {
    const { value, applied } = await registry()
    const connected = await value.connect({
      expectedRevision: 0,
      name: 'Custom',
      baseUrl: 'https://example.com/v1',
      credential: 'secret',
      models: ['model-a'],
      selectedModel: 'model-a',
      probe: false
    })
    const error = await value.select({
      expectedRevision: 0,
      providerId: 'custom',
      model: 'model-a'
    }).catch((value) => value)
    expect(error).toBeInstanceOf(ModelConnectionConflictError)
    expect((error as ModelConnectionConflictError).snapshot.revision).toBe(connected.revision)
    expect(applied).toContain('custom/model-a')
  })

  it('falls back only to another configured provider when deleting the shared default', async () => {
    const { value } = await registry()
    const unavailable = await value.connect({
      expectedRevision: 0,
      id: 'unconfigured',
      name: 'Needs a key',
      baseUrl: 'https://unconfigured.example/v1',
      models: ['model-u'],
      selectedModel: 'model-u',
      probe: false,
      select: false
    })
    const configured = await value.connect({
      expectedRevision: unavailable.revision,
      id: 'configured',
      name: 'Configured',
      baseUrl: 'https://configured.example/v1',
      credential: 'secret',
      models: ['model-c'],
      selectedModel: 'model-c',
      probe: false,
      select: false
    })
    const selected = await value.connect({
      expectedRevision: configured.revision,
      id: 'selected',
      name: 'Selected',
      baseUrl: 'https://selected.example/v1',
      credential: 'secret',
      models: ['model-s'],
      selectedModel: 'model-s',
      probe: false,
      select: true
    })

    const removed = await value.delete('selected', selected.revision)
    expect(removed).toMatchObject({
      defaultProviderId: 'configured',
      defaultAccountId: 'account:configured',
      defaultModel: 'model-c'
    })
  })

  it('versions shared proxy and model-routing configuration with provider connections', async () => {
    const { value } = await registry()
    const snapshot = await value.updateGlobals({
      expectedRevision: 0,
      proxy: { enabled: true, url: 'http://127.0.0.1:7890' },
      routePools: [{
        id: 'pool-a', name: 'Pool A', modelId: 'model-a', enabled: true,
        strategy: 'priority',
        targets: [{ id: 'target-a', providerId: 'provider-a', modelId: 'model-a', enabled: true, weight: 1 }],
        failurePolicy: {
          failoverHttpStatusCodes: [429, 500, 502, 503],
          failoverOnNetworkError: true,
          failoverOnTimeout: true,
          failoverOnAuthError: false
        },
        healthPolicy: { failureThreshold: 3, cooldownMs: 30_000, halfOpenMaxAttempts: 1 }
      }],
      localModelGateway: { enabled: true }
    })

    expect(snapshot).toMatchObject({
      revision: 1,
      proxy: { enabled: true, url: 'http://127.0.0.1:7890' },
      localModelGateway: { enabled: true }
    })
    expect(snapshot.routePools).toHaveLength(1)
  })

  it('pushes the next revision to waiting GUI and TUI clients', async () => {
    const { value } = await registry()
    const abort = new AbortController()
    const waiting = value.waitForRevision(0, abort.signal, 5_000)
    const connected = await value.connect({
      expectedRevision: 0,
      name: 'Event provider',
      baseUrl: 'https://example.com/v1',
      credential: 'secret',
      models: ['model-a'],
      selectedModel: 'model-a',
      probe: false
    })

    await expect(waiting).resolves.toMatchObject({ revision: connected.revision })
  })

  it('preserves the selected GUI provider while seeding a new registry', async () => {
    const { value } = await registry()
    const snapshot = await value.initialize([
      {
        expectedRevision: 0,
        id: 'deepseek',
        name: 'DeepSeek',
        kind: 'http',
        authType: 'api-key',
        baseUrl: 'https://api.deepseek.com',
        endpointFormat: 'chat_completions',
        credential: 'deepseek-secret',
        models: ['deepseek-chat'],
        selectedModel: 'deepseek-chat',
        probe: false,
        select: false
      },
      {
        expectedRevision: 0,
        id: 'kimi-code',
        name: 'Kimi Code',
        kind: 'http',
        authType: 'subscription',
        baseUrl: 'https://api.kimi.com/coding/v1',
        endpointFormat: 'chat_completions',
        credential: 'kimi-secret',
        models: ['kimi-k2.5'],
        selectedModel: 'kimi-k2.5',
        probe: false,
        select: true
      }
    ])

    expect(snapshot).toMatchObject({
      defaultProviderId: 'kimi-code',
      defaultAccountId: 'account:kimi-code',
      defaultModel: 'kimi-k2.5'
    })
  })

  it('preserves the shared default when a hot-applied catalog carries a stale active model', async () => {
    const { value } = await registry()
    const initial = await value.connect({
      expectedRevision: 0,
      id: 'provider-a',
      name: 'Provider A',
      baseUrl: 'https://provider.example/v1',
      credential: 'secret',
      models: ['model-before', 'model-after'],
      selectedModel: 'model-before',
      probe: false,
      select: true
    })

    const snapshot = await value.initialize([{
      expectedRevision: initial.revision,
      id: 'provider-a',
      name: 'Provider A',
      kind: 'http',
      authType: 'api-key',
      baseUrl: 'https://provider.example/v1',
      endpointFormat: 'chat_completions',
      models: ['model-before', 'model-after'],
      selectedModel: 'model-after',
      probe: false,
      select: true
    }])

    expect(snapshot).toMatchObject({
      defaultProviderId: 'provider-a',
      defaultModel: 'model-before',
      providers: [expect.objectContaining({
        id: 'provider-a',
        selectedModel: 'model-before'
      })]
    })
  })

  it('reconciles missing GUI providers and repairs legacy active-model seeds without changing the shared default', async () => {
    const { value } = await registry()
    const initial = await value.connect({
      expectedRevision: 0,
      id: 'secondary',
      name: 'Secondary',
      kind: 'http',
      authType: 'api-key',
      baseUrl: 'https://secondary.example/v1',
      endpointFormat: 'chat_completions',
      credential: 'secondary-secret',
      models: ['deepseek-v4-pro'],
      selectedModel: 'deepseek-v4-pro',
      probe: false,
      select: true
    })

    const snapshot = await value.initialize([
      {
        expectedRevision: initial.revision,
        id: 'secondary',
        name: 'Secondary',
        kind: 'http',
        authType: 'api-key',
        baseUrl: 'https://secondary.example/v1',
        endpointFormat: 'chat_completions',
        credential: 'secondary-secret',
        models: ['secondary-chat', 'secondary-reasoning'],
        selectedModel: 'secondary-chat',
        probe: false,
        select: false
      },
      {
        expectedRevision: initial.revision,
        id: 'kimi-code',
        name: 'Kimi Code',
        kind: 'http',
        authType: 'subscription',
        baseUrl: 'https://api.kimi.com/coding/v1',
        endpointFormat: 'chat_completions',
        credential: 'kimi-secret',
        models: ['kimi-k2.5', 'kimi-k2-thinking'],
        selectedModel: 'kimi-k2.5',
        probe: false,
        select: false
      }
    ])

    expect(snapshot).toMatchObject({
      defaultProviderId: 'secondary',
      defaultModel: 'secondary-chat'
    })
    expect(snapshot.providers.find((profile) => profile.id === 'secondary')?.models)
      .toEqual(['secondary-chat', 'secondary-reasoning'])
    expect(snapshot.providers.find((profile) => profile.id === 'kimi-code')?.models)
      .toEqual(['kimi-k2.5', 'kimi-k2-thinking'])
  })
})
