import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ExtensionCredentialStore } from './extension-credential-store.js'
import {
  isModelConnectionCredentialSourceId,
  ModelConnectionConflictError,
  ModelConnectionRegistry
} from './model-connection-registry.js'
import { CodexOAuthCredentialRefresher } from './codex-oauth-credential-refresher.js'

const roots: string[] = []

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function registry(
  modelCapabilities?: ConstructorParameters<typeof ModelConnectionRegistry>[0]['modelCapabilities'],
  retireLegacyCredentialSource?: (sourceId: string) => Promise<void>,
  resolveCredentialSource?: ConstructorParameters<typeof ModelConnectionRegistry>[0]['resolveCredentialSource']
) {
  const dataDir = await mkdtemp(join(tmpdir(), 'kun-model-connections-'))
  roots.push(dataDir)
  const credentials = new ExtensionCredentialStore({ dataDir, profileId: 'test' })
  const applied: string[] = []
  const value = new ModelConnectionRegistry({
    dataDir,
    credentials,
    ...(modelCapabilities ? { modelCapabilities } : {}),
    ...(retireLegacyCredentialSource ? { retireLegacyCredentialSource } : {}),
    ...(resolveCredentialSource ? { resolveCredentialSource } : {}),
    onChanged: (connections) => {
      if (connections.selected) applied.push(`${connections.selected.profile.id}/${connections.selected.model}`)
    }
  })
  await value.initialize()
  return { dataDir, value, applied }
}

describe('ModelConnectionRegistry', () => {
  it.each([
    {
      label: 'an origin root',
      baseUrl: 'https://catalog.example.test',
      endpointFormat: 'chat_completions' as const,
      expectedUrl: 'https://catalog.example.test/v1/models'
    },
    {
      label: 'an existing v1 root',
      baseUrl: 'https://catalog.example.test/v1/',
      endpointFormat: 'responses' as const,
      expectedUrl: 'https://catalog.example.test/v1/models'
    },
    {
      label: 'a versioned chat completions endpoint',
      baseUrl: 'https://catalog.example.test/v2/chat/completions?deployment=blue#fragment',
      endpointFormat: 'chat_completions' as const,
      expectedUrl: 'https://catalog.example.test/v2/models'
    },
    {
      label: 'a prefixed Responses endpoint',
      baseUrl: 'https://catalog.example.test/openai/v1/responses',
      endpointFormat: 'responses' as const,
      expectedUrl: 'https://catalog.example.test/openai/v1/models'
    },
    {
      label: 'a Messages endpoint',
      baseUrl: 'https://catalog.example.test/v1/messages',
      endpointFormat: 'messages' as const,
      expectedUrl: 'https://catalog.example.test/v1/models'
    },
    {
      label: 'a beta inference endpoint',
      baseUrl: 'https://catalog.example.test/beta/responses',
      endpointFormat: 'responses' as const,
      expectedUrl: 'https://catalog.example.test/v1/models'
    }
  ])('derives the provider models URL from $label', async ({
    baseUrl,
    endpointFormat,
    expectedUrl
  }) => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify({
        data: [{ id: 'discovered-model' }]
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const { value } = await registry()

    await value.connect({
      expectedRevision: 0,
      id: 'url-probe',
      name: 'URL Probe',
      kind: 'http',
      authType: 'api-key',
      baseUrl,
      endpointFormat,
      credential: 'registry-secret',
      models: ['fallback-model'],
      selectedModel: 'fallback-model',
      probe: true,
      select: false
    })

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(expectedUrl)
  })

  it('does not guess a models URL from a custom full inference endpoint', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { value } = await registry()
    await value.connect({
      expectedRevision: 0,
      id: 'custom-full-endpoint',
      name: 'Custom Full Endpoint',
      kind: 'http',
      authType: 'api-key',
      baseUrl: 'https://gateway.example.test/inference/team-a/respond',
      endpointFormat: 'custom_endpoint',
      credential: 'registry-secret',
      models: ['configured-model'],
      selectedModel: 'configured-model',
      probe: false,
      select: false
    })

    await expect(value.probe('custom-full-endpoint')).rejects.toThrow(
      'custom_endpoint does not define a models URL'
    )
    expect(fetchMock).not.toHaveBeenCalled()
    await expect(value.snapshot()).resolves.toMatchObject({
      providers: [expect.objectContaining({
        id: 'custom-full-endpoint',
        models: ['configured-model']
      })]
    })
  })

  it('probes Messages providers with the Registry credential and Anthropic headers', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({
      data: [{ id: 'claude-sonnet-4-5' }]
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const { value } = await registry()
    await value.connect({
      expectedRevision: 0,
      id: 'anthropic',
      name: 'Anthropic',
      kind: 'http',
      authType: 'api-key',
      baseUrl: 'https://api.anthropic.com/v1/messages',
      endpointFormat: 'messages',
      credential: 'registry-secret',
      models: ['claude-fallback'],
      selectedModel: 'claude-fallback',
      probe: false,
      select: true
    })

    await expect(value.probe('anthropic')).resolves.toEqual({
      ok: true,
      models: ['claude-sonnet-4-5', 'claude-fallback']
    })
    expect(fetchMock).toHaveBeenCalledWith('https://api.anthropic.com/v1/models', expect.objectContaining({
      headers: expect.objectContaining({
        'x-api-key': 'registry-secret',
        'anthropic-version': '2023-06-01'
      })
    }))
    expect(JSON.stringify(fetchMock.mock.calls[0]?.[1])).not.toContain('authorization')
  })

  it('resolves a legacy credential source at persisted-provider probe time', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify({ data: [] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const resolveCredentialSource = vi.fn(async () => ({
      apiKey: 'resolved-latest-secret',
      headers: { 'x-account-id': 'account-1' }
    }))
    const { value } = await registry(undefined, undefined, resolveCredentialSource)
    await value.initialize([{
      expectedRevision: 0,
      id: 'legacy-http',
      name: 'Legacy HTTP',
      kind: 'http',
      authType: 'subscription',
      baseUrl: 'https://example.com/v1',
      endpointFormat: 'responses',
      credentialSourceId: 'settings:provider:legacy-http',
      models: ['model-a'],
      selectedModel: 'model-a',
      probe: false,
      select: true
    }])

    await value.probe('legacy-http')
    expect(resolveCredentialSource).toHaveBeenCalledWith('settings:provider:legacy-http')
    expect(fetchMock).toHaveBeenCalledWith('https://example.com/v1/models', expect.objectContaining({
      headers: expect.objectContaining({
        authorization: 'Bearer resolved-latest-secret',
        'x-account-id': 'account-1'
      })
    }))
  })

  it('keeps Registry-owned credentials authoritative across legacy seed reconciliation', async () => {
    const { dataDir, value } = await registry()
    const direct = await value.connect({
      expectedRevision: 0,
      id: 'codex',
      name: 'Codex',
      kind: 'http',
      authType: 'subscription',
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      endpointFormat: 'responses',
      credential: 'stale-expanded-access-token',
      models: ['gpt-5.6-sol'],
      selectedModel: 'gpt-5.6-sol',
      probe: false,
      select: true
    })

    const registrySourceId = (await value.materialize()).providers.get('codex')!.credentialSourceId!
    const sourceId = 'settings:provider:codex'
    const reconciled = await value.initialize([{
      expectedRevision: direct.revision,
      id: 'codex',
      name: 'Codex',
      kind: 'http',
      authType: 'subscription',
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      endpointFormat: 'responses',
      credentialSourceId: sourceId,
      models: ['gpt-5.6-sol'],
      selectedModel: 'gpt-5.6-sol',
      probe: false,
      select: true
    }])

    expect(JSON.stringify(reconciled)).not.toContain(sourceId)
    const stored = await readFile(join(dataDir, 'model-connections.v1.json'), 'utf8')
    expect(stored).not.toContain(sourceId)
    const materialized = await value.materialize()
    expect(materialized.providers.get('codex')).toMatchObject({
      apiKey: 'stale-expanded-access-token',
      credentialSourceId: registrySourceId
    })
  })

  it('does not resurrect a cleared credential from a later settings seed', async () => {
    const { dataDir, value } = await registry()
    const connected = await value.connect({
      expectedRevision: 0,
      id: 'deepseek',
      name: 'DeepSeek',
      kind: 'http',
      authType: 'api-key',
      baseUrl: 'https://api.deepseek.com',
      endpointFormat: 'chat_completions',
      credential: 'old-secret',
      models: ['deepseek-chat'],
      selectedModel: 'deepseek-chat',
      probe: false,
      select: true
    })
    const cleared = await value.clearCredential('deepseek', connected.revision)

    const reconciled = await value.initialize([{
      expectedRevision: cleared.revision,
      id: 'deepseek',
      name: 'DeepSeek',
      kind: 'http',
      authType: 'api-key',
      baseUrl: 'https://api.deepseek.com',
      endpointFormat: 'chat_completions',
      credentialSourceId: 'settings:provider:deepseek',
      models: ['deepseek-chat'],
      selectedModel: 'deepseek-chat',
      probe: false,
      select: true
    }])

    expect(reconciled.providers[0]).toMatchObject({ configured: false })
    const stored = await readFile(join(dataDir, 'model-connections.v1.json'), 'utf8')
    expect(stored).not.toContain('settings:provider:deepseek')
    expect((await value.materialize()).providers.get('deepseek')).toMatchObject({
      apiKey: ''
    })
    await expect(value.credentialStateForInternalConsumer('deepseek')).resolves.toEqual({
      authoritative: true,
      apiKey: ''
    })
  })

  it('rotates a legacy source to a Registry-owned credential that survives hot apply', async () => {
    const { dataDir, value } = await registry()
    const seed = {
      expectedRevision: 0,
      id: 'deepseek',
      name: 'DeepSeek',
      kind: 'http' as const,
      authType: 'api-key' as const,
      baseUrl: 'https://api.deepseek.com',
      endpointFormat: 'chat_completions' as const,
      credentialSourceId: 'settings:provider:deepseek',
      models: ['deepseek-chat'],
      selectedModel: 'deepseek-chat',
      probe: false,
      select: true
    }
    const legacy = await value.initialize([seed])
    const replaced = await value.replaceCredential('deepseek', {
      expectedRevision: legacy.revision,
      credential: 'replacement-secret'
    })
    const final = await value.replaceCredential('deepseek', {
      expectedRevision: replaced.revision,
      credential: 'final-secret'
    })
    const registrySourceId = (await value.materialize()).providers.get('deepseek')!.credentialSourceId!

    const hotApplied = await value.initialize([{ ...seed, expectedRevision: final.revision }])
    const materialized = await value.materialize()
    expect(hotApplied.providers[0]).toMatchObject({ configured: true })
    expect(materialized.providers.get('deepseek')).toMatchObject({
      apiKey: 'final-secret',
      credentialSourceId: registrySourceId
    })
    expect((await value.resolveApiKey(registrySourceId))?.apiKey).toBe('final-secret')
    await expect(value.credentialStateForInternalConsumer('deepseek')).resolves.toEqual({
      authoritative: true,
      apiKey: 'final-secret'
    })
    const stored = await readFile(join(dataDir, 'model-connections.v1.json'), 'utf8')
    expect(stored).not.toContain('settings:provider:deepseek')
    expect(stored).not.toContain('replacement-secret')
    expect(stored).not.toContain('final-secret')
  })

  it('keeps failed targeted legacy retirement durable and retries it on initialize', async () => {
    const retired: string[] = []
    let attempts = 0
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { dataDir, value } = await registry(undefined, async (sourceId) => {
      attempts += 1
      if (attempts === 1) throw new Error('temporary legacy store failure')
      retired.push(sourceId)
    })
    const legacy = await value.initialize([{
      expectedRevision: 0,
      id: 'deepseek',
      name: 'DeepSeek',
      kind: 'http',
      authType: 'api-key',
      baseUrl: 'https://api.deepseek.com',
      endpointFormat: 'chat_completions',
      credentialSourceId: 'settings:provider:deepseek',
      models: ['deepseek-chat'],
      selectedModel: 'deepseek-chat',
      probe: false,
      select: true
    }])

    await value.replaceCredential('deepseek', {
      expectedRevision: legacy.revision,
      credential: 'replacement-secret'
    })
    expect(await readFile(join(dataDir, 'model-connections.v1.json'), 'utf8'))
      .toContain('settings:provider:deepseek')
    expect((await value.materialize()).providers.get('deepseek')).toMatchObject({
      apiKey: 'replacement-secret',
      credentialSourceId: 'model-connection:deepseek'
    })

    await value.initialize()
    expect(retired).toEqual(['settings:provider:deepseek'])
    expect(await readFile(join(dataDir, 'model-connections.v1.json'), 'utf8'))
      .not.toContain('settings:provider:deepseek')
    warn.mockRestore()
  })

  it('keeps provider deletion durable across stale seeds and allows an explicit same-id re-add', async () => {
    const { dataDir, value } = await registry()
    const request = {
      expectedRevision: 0,
      id: 'restart-safe',
      name: 'Restart Safe',
      kind: 'http' as const,
      authType: 'api-key' as const,
      baseUrl: 'https://restart-safe.example/v1',
      endpointFormat: 'chat_completions' as const,
      credential: 'old-secret',
      models: ['model-a'],
      selectedModel: 'model-a',
      probe: false,
      select: true
    }
    const connected = await value.connect(request)
    const deleted = await value.delete('restart-safe', connected.revision)

    const staleSeed = await value.initialize([{ ...request, expectedRevision: deleted.revision }])
    expect(staleSeed.providers).toEqual([])

    const restarted = new ModelConnectionRegistry({
      dataDir,
      credentials: new ExtensionCredentialStore({ dataDir, profileId: 'test' })
    })
    const afterRestart = await restarted.initialize([{ ...request, expectedRevision: deleted.revision }])
    expect(afterRestart.providers).toEqual([])

    const readded = await restarted.connect({
      ...request,
      expectedRevision: afterRestart.revision,
      credential: 'new-secret'
    })
    expect(readded.providers).toEqual([
      expect.objectContaining({ id: 'restart-safe', configured: true })
    ])
    expect((await restarted.materialize()).providers.get('restart-safe')?.apiKey).toBe('new-secret')
    const stored = JSON.parse(await readFile(join(dataDir, 'model-connections.v1.json'), 'utf8')) as {
      tombstones: Record<string, unknown>
    }
    expect(stored.tombstones).toEqual({})
  })

  it('does not restore a deleted model from a stale AppSettings seed after restart', async () => {
    const { dataDir, value } = await registry()
    const seed = {
      expectedRevision: 0,
      id: 'catalog-owner',
      name: 'Catalog Owner',
      kind: 'http' as const,
      authType: 'api-key' as const,
      baseUrl: 'https://catalog.example/v1',
      endpointFormat: 'chat_completions' as const,
      credential: 'secret',
      models: ['keep-model', 'delete-model'],
      selectedModel: 'keep-model',
      probe: false,
      select: true
    }
    const connected = await value.connect(seed)
    const patched = await value.patch('catalog-owner', {
      expectedRevision: connected.revision,
      models: ['keep-model'],
      selectedModel: 'keep-model'
    })
    const staleApplied = await value.initialize([{ ...seed, expectedRevision: patched.revision }])
    expect(staleApplied.providers[0]?.models).toEqual(['keep-model'])

    const restarted = new ModelConnectionRegistry({
      dataDir,
      credentials: new ExtensionCredentialStore({ dataDir, profileId: 'test' })
    })
    const afterRestart = await restarted.initialize([{ ...seed, expectedRevision: staleApplied.revision }])
    expect(afterRestart.providers[0]?.models).toEqual(['keep-model'])
  })

  it('retries deleted-provider legacy source retirement without allowing seed resurrection', async () => {
    let attempts = 0
    const retired: string[] = []
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { dataDir, value } = await registry(undefined, async (sourceId) => {
      attempts += 1
      if (attempts === 1) throw new Error('temporary cleanup outage')
      retired.push(sourceId)
    })
    const seed = {
      expectedRevision: 0,
      id: 'legacy-delete',
      name: 'Legacy Delete',
      kind: 'http' as const,
      authType: 'api-key' as const,
      baseUrl: 'https://legacy-delete.example/v1',
      endpointFormat: 'chat_completions' as const,
      credentialSourceId: 'settings:provider:legacy-delete',
      models: ['model-a'],
      selectedModel: 'model-a',
      probe: false,
      select: true
    }
    const connected = await value.initialize([seed])
    const deleted = await value.delete('legacy-delete', connected.revision)
    expect(await readFile(join(dataDir, 'model-connections.v1.json'), 'utf8'))
      .toContain('settings:provider:legacy-delete')

    const restarted = await value.initialize([{ ...seed, expectedRevision: deleted.revision }])
    expect(restarted.providers).toEqual([])
    expect(retired).toEqual(['settings:provider:legacy-delete'])
    expect(await readFile(join(dataDir, 'model-connections.v1.json'), 'utf8'))
      .not.toContain('settings:provider:legacy-delete')
    warn.mockRestore()
  })

  it('refreshes Registry-owned Codex OAuth credentials through their protected source', async () => {
    const { value } = await registry()
    const credentials = JSON.stringify({
      kind: 'codex-oauth',
      accessToken: 'expired-access',
      refreshToken: 'refresh-one',
      expiresAt: 1,
      accountId: 'account-one'
    })
    await value.connect({
      expectedRevision: 0,
      id: 'codex',
      name: 'Codex',
      kind: 'http',
      authType: 'subscription',
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      endpointFormat: 'responses',
      credential: credentials,
      models: ['gpt-5.6-sol'],
      selectedModel: 'gpt-5.6-sol',
      probe: false,
      select: true
    })
    const config = (await value.materialize()).providers.get('codex')
    expect(config?.credentialSourceId).toSatisfy(isModelConnectionCredentialSourceId)
    expect(config?.apiKey).toBe('expired-access')

    let refreshOrdinal = 0
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      refreshOrdinal += 1
      return new Response(JSON.stringify({
        access_token: `rotated-access-${refreshOrdinal}`,
        refresh_token: `refresh-${refreshOrdinal + 1}`,
        expires_in: 3600
      }), { status: 200 })
    })
    const refresher = new CodexOAuthCredentialRefresher(value, {
      fetchImpl,
      nowMs: () => 10_000
    })
    const resolved = await refresher.resolve(config!.credentialSourceId!)
    expect(resolved.refreshable).toBe(true)
    expect(JSON.parse(resolved.rawApiKey)).toMatchObject({
      accessToken: 'rotated-access-1',
      refreshToken: 'refresh-2'
    })
    const afterRejectedBearer = await refresher.resolve(
      config!.credentialSourceId!,
      'rotated-access-1'
    )
    expect(JSON.parse(afterRejectedBearer.rawApiKey)).toMatchObject({
      accessToken: 'rotated-access-2',
      refreshToken: 'refresh-3'
    })
    expect(JSON.parse((await value.resolveApiKey(config!.credentialSourceId!))!.apiKey))
      .toMatchObject({ accessToken: 'rotated-access-2' })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('does not let a late OAuth refresh overwrite a newer Registry credential', async () => {
    const { value } = await registry()
    const oldCredential = JSON.stringify({
      kind: 'codex-oauth',
      accessToken: 'expired-access',
      refreshToken: 'old-refresh',
      expiresAt: 1,
      accountId: 'old-account'
    })
    const connected = await value.connect({
      expectedRevision: 0,
      id: 'codex',
      name: 'Codex',
      kind: 'http',
      authType: 'subscription',
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      endpointFormat: 'responses',
      credential: oldCredential,
      models: ['gpt-5.6-sol'],
      selectedModel: 'gpt-5.6-sol',
      probe: false,
      select: true
    })
    const sourceId = (await value.materialize()).providers.get('codex')!.credentialSourceId!
    let signalFetchStarted!: () => void
    const fetchStarted = new Promise<void>((resolve) => { signalFetchStarted = resolve })
    let releaseFetch!: () => void
    const fetchReleased = new Promise<void>((resolve) => { releaseFetch = resolve })
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      signalFetchStarted()
      await fetchReleased
      return Response.json({
        access_token: 'late-old-account-access',
        refresh_token: 'late-old-account-refresh',
        expires_in: 3600
      })
    })
    const refresher = new CodexOAuthCredentialRefresher(value, {
      fetchImpl,
      nowMs: () => 10_000
    })

    const pendingRefresh = refresher.resolve(sourceId)
    await fetchStarted
    const replacement = JSON.stringify({
      kind: 'codex-oauth',
      accessToken: 'new-account-access',
      refreshToken: 'new-account-refresh',
      expiresAt: 9_999_999,
      accountId: 'new-account'
    })
    await value.replaceCredential('codex', {
      expectedRevision: connected.revision,
      credential: replacement
    })
    releaseFetch()

    await expect(pendingRefresh).resolves.toEqual({
      rawApiKey: replacement,
      refreshable: true
    })
    expect((await value.resolveApiKey(sourceId))?.apiKey).toBe(replacement)
  })

  it('keeps direct Registry API keys request-resolvable but non-refreshable', async () => {
    const { value } = await registry()
    await value.connect({
      expectedRevision: 0,
      id: 'custom',
      name: 'Custom',
      kind: 'http',
      authType: 'api-key',
      baseUrl: 'https://example.test/v1',
      endpointFormat: 'chat_completions',
      credential: 'plain-secret',
      models: ['model-a'],
      selectedModel: 'model-a',
      probe: false,
      select: true
    })
    const config = (await value.materialize()).providers.get('custom')
    const fetchImpl = vi.fn<typeof fetch>()
    const refresher = new CodexOAuthCredentialRefresher(value, { fetchImpl })

    await expect(refresher.resolve(config!.credentialSourceId!)).resolves.toEqual({
      rawApiKey: 'plain-secret',
      refreshable: false
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('reconnects an authenticated preset in place and rotates its protected credential', async () => {
    const { dataDir, value } = await registry()
    const first = await value.connectAuthenticated({
      expectedRevision: 0,
      id: 'codex',
      name: 'ChatGPT subscription',
      presetSource: 'codex',
      kind: 'http',
      authType: 'oauth',
      baseUrl: 'https://chatgpt.com/backend-api/codex/responses',
      endpointFormat: 'custom_endpoint',
      credential: 'first-oauth-secret',
      models: ['gpt-5.6-sol'],
      selectedModel: 'gpt-5.6-sol',
      select: true
    })
    const originalAccountId = first.providers[0]!.accountId
    const sourceId = (await value.materialize()).providers.get('codex')!.credentialSourceId!

    const second = await value.connectAuthenticated({
      expectedRevision: first.revision,
      id: 'codex',
      name: 'ChatGPT subscription',
      presetSource: 'codex',
      kind: 'http',
      authType: 'oauth',
      baseUrl: 'https://chatgpt.com/backend-api/codex/responses',
      endpointFormat: 'custom_endpoint',
      credential: 'rotated-oauth-secret',
      models: ['gpt-5.6-sol', 'gpt-5.4'],
      selectedModel: 'gpt-5.6-sol',
      select: true
    })

    expect(second.providers).toHaveLength(1)
    expect(second.providers[0]).toMatchObject({
      id: 'codex',
      accountId: originalAccountId,
      configured: true,
      models: ['gpt-5.6-sol', 'gpt-5.4']
    })
    expect(JSON.stringify(second)).not.toContain('rotated-oauth-secret')
    expect((await value.resolveApiKey(sourceId))?.apiKey).toBe('rotated-oauth-secret')
    const registryDocument = await readFile(join(dataDir, 'model-connections.v1.json'), 'utf8')
    expect(registryDocument).not.toContain('first-oauth-secret')
    expect(registryDocument).not.toContain('rotated-oauth-secret')
  })

  it('materializes a verified Gemini CLI subscription with its native route kind', async () => {
    const { value } = await registry()
    const snapshot = await value.connectAuthenticated({
      expectedRevision: 0,
      id: 'gemini-cli-subscription',
      name: 'Gemini CLI subscription',
      presetSource: 'gemini-cli-subscription',
      kind: 'gemini-cli-api',
      authType: 'subscription',
      endpointFormat: 'custom_endpoint',
      models: ['gemini-3.1-pro-preview'],
      selectedModel: 'gemini-3.1-pro-preview',
      select: true,
      externalAuthVerified: true
    })

    expect(snapshot.providers[0]).toMatchObject({
      id: 'gemini-cli-subscription',
      kind: 'gemini-cli-api',
      configured: true
    })
    expect((await value.materialize()).providers.get('gemini-cli-subscription')).toMatchObject({
      kind: 'gemini-cli-api',
      models: ['gemini-3.1-pro-preview']
    })
  })

  it('keeps managed non-HTTP subscription material available to its delegated runtime', async () => {
    const { value } = await registry()
    await value.initialize([{
      expectedRevision: 0,
      id: 'claude-subscription',
      name: 'Claude subscription',
      kind: 'agent-sdk',
      authType: 'subscription',
      endpointFormat: 'messages',
      credential: 'claude-setup-token',
      credentialSourceId: 'settings:provider:claude-subscription',
      models: ['claude-opus'],
      selectedModel: 'claude-opus',
      probe: false,
      select: true
    }])

    expect((await value.materialize()).providers.get('claude-subscription')).toMatchObject({
      kind: 'agent-sdk',
      apiKey: 'claude-setup-token',
      credentialSourceId: 'model-connection:claude-subscription'
    })
  })

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

  it('does not select CLI-backed providers before external authentication is verified', async () => {
    const { value } = await registry()
    const snapshot = await value.connect({
      expectedRevision: 0,
      id: 'gemini-cli-subscription',
      name: 'Gemini CLI subscription',
      presetSource: 'gemini-cli-subscription',
      kind: 'gemini-cli-api',
      authType: 'subscription',
      endpointFormat: 'custom_endpoint',
      models: ['gemini-3.1-pro-preview'],
      selectedModel: 'gemini-3.1-pro-preview',
      probe: false,
      select: true
    })

    expect(snapshot.providers[0]).toMatchObject({
      id: 'gemini-cli-subscription',
      kind: 'gemini-cli-api',
      configured: false
    })
    expect(snapshot.defaultProviderId).toBeUndefined()
    expect((await value.materialize()).selected).toBeUndefined()
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

  it('imports missing GUI providers without letting stale seeds overwrite a Registry catalog', async () => {
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
      defaultModel: 'deepseek-v4-pro'
    })
    expect(snapshot.providers.find((profile) => profile.id === 'secondary')?.models)
      .toEqual(['deepseek-v4-pro'])
    expect(snapshot.providers.find((profile) => profile.id === 'kimi-code')?.models)
      .toEqual(['kimi-k2.5', 'kimi-k2-thinking'])
  })
})
