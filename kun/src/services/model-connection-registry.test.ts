import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ExtensionCredentialStore } from './extension-credential-store.js'
import { configureManagerAtomicJsonClient } from '../extensions/atomic-json.js'
import {
  isModelConnectionCredentialSourceId,
  ModelConnectionConflictError,
  ModelConnectionRegistry
} from './model-connection-registry.js'
import { CodexOAuthCredentialRefresher } from './codex-oauth-credential-refresher.js'

const roots: string[] = []

afterEach(async () => {
  configureManagerAtomicJsonClient(null)
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

type FakeManagerDocument = { revision: number; value: unknown | null }

function installFakeAtomicJsonManager(dataDir: string) {
  const documents = new Map<string, FakeManagerDocument>()
  const externalRequests: string[] = []
  vi.stubEnv('KUN_MANAGER_BASE_URL', 'http://manager.test')
  vi.stubEnv('KUN_MANAGER_TOKEN', 'manager-secret')
  vi.stubEnv('KUN_MANAGER_DATA_DIR', dataDir)
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input)
    if (!url.startsWith('http://manager.test/')) {
      externalRequests.push(url)
      return Response.json({ data: [{ id: 'external-model' }] })
    }
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      path: string
      expectedRevision?: number
      value?: unknown
    }
    const current = documents.get(body.path) ?? { revision: 0, value: null }
    if (url.endsWith('/read')) return Response.json({ snapshot: structuredClone(current) })
    if (body.expectedRevision !== current.revision) {
      return Response.json({ currentRevision: current.revision }, { status: 409 })
    }
    const next = url.endsWith('/delete')
      ? { revision: current.revision + 1, value: null }
      : { revision: current.revision + 1, value: structuredClone(body.value ?? null) }
    documents.set(body.path, next)
    return Response.json({ snapshot: structuredClone(next) })
  })
  vi.stubGlobal('fetch', fetchMock)
  return {
    documents,
    externalRequests,
    registryDocument: () => documents.get(join(dataDir, 'model-connections.v1.json'))?.value as {
      revision: number
      profiles: Record<string, { credentialRef?: string }>
      credentialTransactions: Record<string, {
        operationToken: string
        phase: string
        nextCredentialRef?: string
      }>
      credentialRefCleanup: Record<string, { reference: string; writerPid?: number }>
    }
  }
}

async function sharedManagerRegistryPair(input: {
  dataDir?: string
  optionsA?: Partial<ConstructorParameters<typeof ModelConnectionRegistry>[0]>
  optionsB?: Partial<ConstructorParameters<typeof ModelConnectionRegistry>[0]>
} = {}) {
  const dataDir = input.dataDir ?? await mkdtemp(join(tmpdir(), 'kun-model-connections-manager-'))
  if (!input.dataDir) roots.push(dataDir)
  const manager = installFakeAtomicJsonManager(dataDir)
  const credentialsA = new ExtensionCredentialStore({ dataDir, profileId: 'test' })
  const credentialsB = new ExtensionCredentialStore({ dataDir, profileId: 'test' })
  const a = new ModelConnectionRegistry({
    dataDir,
    credentials: credentialsA,
    ...input.optionsA
  })
  const b = new ModelConnectionRegistry({
    dataDir,
    credentials: credentialsB,
    ...input.optionsB
  })
  await a.initialize()
  await b.initialize()
  return { dataDir, manager, credentialsA, credentialsB, a, b }
}

function deepseekConnection(expectedRevision = 0) {
  return {
    expectedRevision,
    id: 'deepseek',
    name: 'DeepSeek',
    kind: 'http' as const,
    authType: 'api-key' as const,
    baseUrl: 'https://api.deepseek.com',
    endpointFormat: 'chat_completions' as const,
    credential: 'original-secret',
    models: ['deepseek-chat'],
    selectedModel: 'deepseek-chat',
    probe: false,
    select: true
  }
}

async function registry(
  modelCapabilities?: ConstructorParameters<typeof ModelConnectionRegistry>[0]['modelCapabilities'],
  retireLegacyCredentialSource?: (sourceId: string) => Promise<void>,
  resolveCredentialSource?: ConstructorParameters<typeof ModelConnectionRegistry>[0]['resolveCredentialSource'],
  inspectCredentialSource?: ConstructorParameters<typeof ModelConnectionRegistry>[0]['inspectCredentialSource'],
  credentialFenceTtlMs?: number,
  beforeCredentialFenceInstall?: ConstructorParameters<
    typeof ModelConnectionRegistry
  >[0]['beforeCredentialFenceInstall'],
  afterCredentialCommitWrite?: ConstructorParameters<
    typeof ModelConnectionRegistry
  >[0]['afterCredentialCommitWrite']
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
    ...(inspectCredentialSource ? { inspectCredentialSource } : {}),
    ...(credentialFenceTtlMs ? { credentialFenceTtlMs } : {}),
    ...(beforeCredentialFenceInstall ? { beforeCredentialFenceInstall } : {}),
    ...(afterCredentialCommitWrite ? { afterCredentialCommitWrite } : {}),
    onChanged: (connections) => {
      if (connections.selected) applied.push(`${connections.selected.profile.id}/${connections.selected.model}`)
    }
  })
  await value.initialize()
  return { dataDir, value, applied, credentials }
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

  it('never exposes a superseded prepared credential to concurrent consumers', async () => {
    const { value, credentials } = await registry()
    const connected = await value.connect({
      expectedRevision: 0,
      id: 'deepseek',
      name: 'DeepSeek',
      kind: 'http',
      authType: 'api-key',
      baseUrl: 'https://api.deepseek.com',
      endpointFormat: 'chat_completions',
      credential: 'original-secret',
      models: ['deepseek-chat'],
      selectedModel: 'deepseek-chat',
      probe: false,
      select: true
    })
    const sourceId = (await value.materialize()).providers.get('deepseek')!.credentialSourceId!
    const firstToken = 'credential:11111111-1111-4111-8111-111111111111:1'
    const finalToken = 'credential:11111111-1111-4111-8111-111111111111:2'

    const firstFence = await value.fenceCredential('deepseek', {
      expectedRevision: connected.revision,
      operationToken: firstToken
    })
    const firstPrepared = await value.prepareCredential('deepseek', {
      expectedRevision: firstFence.revision,
      credential: 'first-new-secret',
      operationToken: firstToken
    })
    await expect(value.credentialStateForInternalConsumer('deepseek')).resolves.toEqual({
      authoritative: true,
      apiKey: ''
    })
    await expect(value.resolveApiKey(sourceId)).resolves.toBeNull()
    await expect(value.credentialForCompatibility('deepseek')).resolves.toBeNull()
    await expect(value.probe('deepseek')).rejects.toThrow(/replacement is pending/u)
    expect((await value.materialize()).providers.get('deepseek')).toMatchObject({ apiKey: '' })

    const originalSet = credentials.set.bind(credentials)
    let commitStarted!: () => void
    const started = new Promise<void>((resolve) => { commitStarted = resolve })
    let releaseCommit!: () => void
    const released = new Promise<void>((resolve) => { releaseCommit = resolve })
    vi.spyOn(credentials, 'set').mockImplementation(async (reference, payload) => {
      if (payload.apiKey === 'first-new-secret') {
        commitStarted()
        await released
      }
      return originalSet(reference, payload)
    })
    const supersededCommit = value.commitPreparedCredential('deepseek', {
      expectedRevision: firstPrepared.revision,
      operationToken: firstToken
    })
    await started

    const finalFence = await value.fenceCredential('deepseek', {
      expectedRevision: (await value.snapshot()).revision,
      operationToken: finalToken
    })
    await expect(value.credentialStateForInternalConsumer('deepseek')).resolves.toEqual({
      authoritative: true,
      apiKey: ''
    })
    releaseCommit()
    await expect(supersededCommit).rejects.toBeInstanceOf(ModelConnectionConflictError)
    await expect(value.resolveApiKey(sourceId)).resolves.toBeNull()
    await expect(value.prepareCredential('deepseek', {
      expectedRevision: finalFence.revision,
      credential: 'first-new-secret',
      operationToken: firstToken
    })).rejects.toBeInstanceOf(ModelConnectionConflictError)

    const finalPrepared = await value.prepareCredential('deepseek', {
      expectedRevision: finalFence.revision,
      credential: 'final-secret',
      operationToken: finalToken
    })
    const committed = await value.commitPreparedCredential('deepseek', {
      expectedRevision: finalPrepared.revision,
      operationToken: finalToken
    })

    expect(committed.revision).toBeGreaterThan(finalPrepared.revision)
    await expect(value.credentialStateForInternalConsumer('deepseek')).resolves.toEqual({
      authoritative: true,
      apiKey: 'final-secret'
    })
    await expect(value.resolveApiKey(sourceId)).resolves.toEqual({ apiKey: 'final-secret' })
    expect((await value.materialize()).providers.get('deepseek')).toMatchObject({
      apiKey: 'final-secret'
    })
  })

  it('rolls back a stale credential whose durable write completed before a newer fence', async () => {
    let commitWriteFinished!: () => void
    const commitWritten = new Promise<void>((resolve) => { commitWriteFinished = resolve })
    let releaseCommit!: () => void
    const commitRelease = new Promise<void>((resolve) => { releaseCommit = resolve })
    let delayNextCommit = true
    const afterCredentialCommitWrite = vi.fn(async () => {
      if (!delayNextCommit) return
      delayNextCommit = false
      commitWriteFinished()
      await commitRelease
    })
    const { value } = await registry(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      afterCredentialCommitWrite
    )
    const connected = await value.connect({
      expectedRevision: 0,
      id: 'deepseek',
      name: 'DeepSeek',
      kind: 'http',
      authType: 'api-key',
      baseUrl: 'https://api.deepseek.com',
      endpointFormat: 'chat_completions',
      credential: 'original-secret',
      models: ['deepseek-chat'],
      selectedModel: 'deepseek-chat',
      probe: false,
      select: true
    })
    const sourceId = (await value.materialize()).providers.get('deepseek')!.credentialSourceId!
    const firstToken = 'credential:11111111-1111-4111-8111-111111111111:1'
    const finalToken = 'credential:11111111-1111-4111-8111-111111111111:2'
    const firstFence = await value.fenceCredential('deepseek', {
      expectedRevision: connected.revision,
      operationToken: firstToken
    })
    const firstPrepared = await value.prepareCredential('deepseek', {
      expectedRevision: firstFence.revision,
      credential: 'durably-written-stale-secret',
      operationToken: firstToken
    })
    const staleCommit = value.commitPreparedCredential('deepseek', {
      expectedRevision: firstPrepared.revision,
      operationToken: firstToken
    })
    await commitWritten

    await value.fenceCredential('deepseek', {
      expectedRevision: (await value.snapshot()).revision,
      operationToken: finalToken
    })
    await expect(value.resolveApiKey(sourceId)).resolves.toBeNull()
    releaseCommit()
    await expect(staleCommit).rejects.toBeInstanceOf(ModelConnectionConflictError)
    await expect(value.resolveApiKey(sourceId)).resolves.toBeNull()

    const rolledBack = await value.snapshot()
    const finalPrepared = await value.prepareCredential('deepseek', {
      expectedRevision: rolledBack.revision,
      credential: 'final-secret',
      operationToken: finalToken
    })
    await value.commitPreparedCredential('deepseek', {
      expectedRevision: finalPrepared.revision,
      operationToken: finalToken
    })

    await expect(value.resolveApiKey(sourceId)).resolves.toEqual({ apiKey: 'final-secret' })
    await expect(value.credentialStateForInternalConsumer('deepseek')).resolves.toEqual({
      authoritative: true,
      apiKey: 'final-secret'
    })
  })

  it('expires an abandoned prepared credential and restores the durable credential', async () => {
    vi.useFakeTimers()
    const { dataDir, value } = await registry(undefined, undefined, undefined, undefined, 25)
    const connected = await value.connect({
      expectedRevision: 0,
      id: 'deepseek',
      name: 'DeepSeek',
      kind: 'http',
      authType: 'api-key',
      baseUrl: 'https://api.deepseek.com',
      endpointFormat: 'chat_completions',
      credential: 'durable-secret',
      models: ['deepseek-chat'],
      selectedModel: 'deepseek-chat',
      probe: false,
      select: true
    })
    const sourceId = (await value.materialize()).providers.get('deepseek')!.credentialSourceId!
    const operationToken = 'credential:11111111-1111-4111-8111-111111111111:1'

    const fenced = await value.fenceCredential('deepseek', {
      expectedRevision: connected.revision,
      operationToken
    })
    await value.prepareCredential('deepseek', {
      expectedRevision: fenced.revision,
      credential: 'abandoned-plaintext',
      operationToken
    })
    await expect(value.resolveApiKey(sourceId)).resolves.toBeNull()
    expect(await readFile(join(dataDir, 'model-connections.v1.json'), 'utf8'))
      .not.toContain('abandoned-plaintext')

    await vi.advanceTimersByTimeAsync(25)

    await expect(value.resolveApiKey(sourceId)).resolves.toEqual({ apiKey: 'durable-secret' })
    await expect(value.credentialStateForInternalConsumer('deepseek')).resolves.toEqual({
      authoritative: true,
      apiKey: 'durable-secret'
    })
    expect((await value.materialize()).providers.get('deepseek')).toMatchObject({
      apiKey: 'durable-secret'
    })
    await expect(value.commitPreparedCredential('deepseek', {
      expectedRevision: connected.revision,
      operationToken
    })).rejects.toBeInstanceOf(ModelConnectionConflictError)
  })

  it('cancels an older expiry when a newer fence takes ownership', async () => {
    vi.useFakeTimers()
    const { value } = await registry(undefined, undefined, undefined, undefined, 25)
    const connected = await value.connect({
      expectedRevision: 0,
      id: 'deepseek',
      name: 'DeepSeek',
      kind: 'http',
      authType: 'api-key',
      baseUrl: 'https://api.deepseek.com',
      endpointFormat: 'chat_completions',
      credential: 'durable-secret',
      models: ['deepseek-chat'],
      selectedModel: 'deepseek-chat',
      probe: false,
      select: true
    })
    const sourceId = (await value.materialize()).providers.get('deepseek')!.credentialSourceId!
    const firstToken = 'credential:11111111-1111-4111-8111-111111111111:1'
    const secondToken = 'credential:11111111-1111-4111-8111-111111111111:2'

    const firstFence = await value.fenceCredential('deepseek', {
      expectedRevision: connected.revision,
      operationToken: firstToken
    })
    await value.prepareCredential('deepseek', {
      expectedRevision: firstFence.revision,
      credential: 'superseded-plaintext',
      operationToken: firstToken
    })
    await vi.advanceTimersByTimeAsync(20)
    await value.fenceCredential('deepseek', {
      expectedRevision: (await value.snapshot()).revision,
      operationToken: secondToken
    })

    await vi.advanceTimersByTimeAsync(5)
    await expect(value.resolveApiKey(sourceId)).resolves.toBeNull()
    await expect(value.commitPreparedCredential('deepseek', {
      expectedRevision: connected.revision,
      operationToken: firstToken
    })).rejects.toBeInstanceOf(ModelConnectionConflictError)

    await vi.advanceTimersByTimeAsync(20)
    await expect(value.resolveApiKey(sourceId)).resolves.toEqual({ apiKey: 'durable-secret' })
  })

  it('cancels the expiry after the matching prepared credential commits', async () => {
    vi.useFakeTimers()
    const { value } = await registry(undefined, undefined, undefined, undefined, 10)
    const connected = await value.connect({
      expectedRevision: 0,
      id: 'deepseek',
      name: 'DeepSeek',
      kind: 'http',
      authType: 'api-key',
      baseUrl: 'https://api.deepseek.com',
      endpointFormat: 'chat_completions',
      credential: 'durable-secret',
      models: ['deepseek-chat'],
      selectedModel: 'deepseek-chat',
      probe: false,
      select: true
    })
    const sourceId = (await value.materialize()).providers.get('deepseek')!.credentialSourceId!
    const operationToken = 'credential:11111111-1111-4111-8111-111111111111:1'

    const fenced = await value.fenceCredential('deepseek', {
      expectedRevision: connected.revision,
      operationToken
    })
    const prepared = await value.prepareCredential('deepseek', {
      expectedRevision: fenced.revision,
      credential: 'committed-secret',
      operationToken
    })
    await value.commitPreparedCredential('deepseek', {
      expectedRevision: prepared.revision,
      operationToken
    })
    await vi.advanceTimersByTimeAsync(20)

    await expect(value.resolveApiKey(sourceId)).resolves.toEqual({ apiKey: 'committed-secret' })
  })

  it('does not attach a delayed old fence to an explicitly re-added provider incarnation', async () => {
    let fenceReachedInstall!: () => void
    const fenceAtInstall = new Promise<void>((resolve) => { fenceReachedInstall = resolve })
    let releaseFence!: () => void
    const fenceRelease = new Promise<void>((resolve) => { releaseFence = resolve })
    const beforeCredentialFenceInstall = vi.fn(async () => {
      fenceReachedInstall()
      await fenceRelease
    })
    const { value } = await registry(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      beforeCredentialFenceInstall
    )
    const connected = await value.connect({
      expectedRevision: 0,
      id: 'deepseek',
      name: 'DeepSeek',
      kind: 'http',
      authType: 'api-key',
      baseUrl: 'https://api.deepseek.com',
      endpointFormat: 'chat_completions',
      credential: 'old-incarnation-secret',
      models: ['deepseek-chat'],
      selectedModel: 'deepseek-chat',
      probe: false,
      select: true
    })
    const oldToken = 'credential:11111111-1111-4111-8111-111111111111:1'
    const delayedFence = value.fenceCredential('deepseek', {
      expectedRevision: connected.revision,
      operationToken: oldToken
    })
    await fenceAtInstall

    const deleted = await value.delete('deepseek', connected.revision)
    const readded = await value.connect({
      expectedRevision: deleted.revision,
      id: 'deepseek',
      name: 'DeepSeek Re-added',
      kind: 'http',
      authType: 'api-key',
      baseUrl: 'https://api.deepseek.com',
      endpointFormat: 'chat_completions',
      credential: 'new-incarnation-secret',
      models: ['deepseek-chat'],
      selectedModel: 'deepseek-chat',
      probe: false,
      select: true
    })
    releaseFence()

    await expect(delayedFence).rejects.toBeInstanceOf(ModelConnectionConflictError)
    await expect(value.prepareCredential('deepseek', {
      expectedRevision: readded.revision,
      credential: 'stale-secret',
      operationToken: oldToken
    })).rejects.toBeInstanceOf(ModelConnectionConflictError)
    await expect(value.credentialStateForInternalConsumer('deepseek')).resolves.toEqual({
      authoritative: true,
      apiKey: 'new-incarnation-secret'
    })
    expect((await value.materialize()).providers.get('deepseek')).toMatchObject({
      apiKey: 'new-incarnation-secret'
    })
  })

  it('shares a durable credential fence across two Manager-backed Registry instances', async () => {
    const { a, b, manager } = await sharedManagerRegistryPair()
    const connected = await a.connect(deepseekConnection())
    const sourceId = (await a.materialize()).providers.get('deepseek')!.credentialSourceId!
    const operationToken = 'credential:11111111-1111-4111-8111-111111111111:1'

    const fenced = await a.fenceCredential('deepseek', {
      expectedRevision: connected.revision,
      operationToken
    })

    await expect(b.snapshot()).resolves.toMatchObject({
      revision: fenced.revision,
      providers: [expect.objectContaining({
        id: 'deepseek',
        credentialStatus: 'missing'
      })]
    })
    await expect(b.resolveApiKey(sourceId)).resolves.toBeNull()
    await expect(b.credentialForCompatibility('deepseek')).resolves.toBeNull()
    await expect(b.credentialStateForInternalConsumer('deepseek')).resolves.toEqual({
      authoritative: true,
      apiKey: ''
    })
    expect((await b.materialize()).providers.get('deepseek')).toMatchObject({ apiKey: '' })
    await expect(b.probe('deepseek')).rejects.toThrow(/replacement is pending/u)
    await expect(b.replaceCredential('deepseek', {
      expectedRevision: fenced.revision,
      credential: 'tokenless-bypass'
    })).rejects.toBeInstanceOf(ModelConnectionConflictError)
    await expect(b.patch('deepseek', {
      expectedRevision: fenced.revision,
      models: ['catalog-bypass'],
      selectedModel: 'catalog-bypass'
    })).rejects.toBeInstanceOf(ModelConnectionConflictError)
    await expect(b.select({
      expectedRevision: fenced.revision,
      providerId: 'deepseek',
      model: 'deepseek-chat'
    })).rejects.toThrow(/replacement is pending/u)
    expect(manager.externalRequests).toEqual([])
    expect(JSON.stringify(manager.registryDocument())).not.toContain('tokenless-bypass')
  })

  it('keeps authenticated and verified CLI reconnects behind an active durable fence', async () => {
    const { a, b } = await sharedManagerRegistryPair()
    const connected = await a.connect(deepseekConnection())
    const operationToken = 'credential:11111111-1111-4111-8111-111111111111:1'
    const fenced = await a.fenceCredential('deepseek', {
      expectedRevision: connected.revision,
      operationToken
    })

    await expect(b.connectAuthenticated({
      expectedRevision: fenced.revision,
      id: 'deepseek',
      name: 'DeepSeek OAuth',
      kind: 'http',
      authType: 'oauth',
      baseUrl: 'https://api.deepseek.com',
      endpointFormat: 'chat_completions',
      credential: 'authenticated-bypass',
      models: ['deepseek-chat'],
      selectedModel: 'deepseek-chat',
      select: true
    })).rejects.toBeInstanceOf(ModelConnectionConflictError)

    await expect(b.connectAuthenticated({
      expectedRevision: fenced.revision,
      id: 'deepseek',
      name: 'Verified CLI bypass',
      kind: 'gemini-cli-api',
      authType: 'subscription',
      endpointFormat: 'custom_endpoint',
      models: ['gemini-3.1-pro-preview'],
      selectedModel: 'gemini-3.1-pro-preview',
      select: true,
      externalAuthVerified: true
    })).rejects.toBeInstanceOf(ModelConnectionConflictError)

    await expect(a.credentialStateForInternalConsumer('deepseek')).resolves.toEqual({
      authoritative: true,
      apiKey: ''
    })
  })

  it('does not let a delayed authenticated reconnect overwrite a newer user generation', async () => {
    const { a, b, manager, credentialsA, credentialsB } = await sharedManagerRegistryPair()
    const connected = await a.connect(deepseekConnection())
    const sourceId = (await a.materialize()).providers.get('deepseek')!.credentialSourceId!
    const originalSet = credentialsA.set.bind(credentialsA)
    let writeStarted!: () => void
    const started = new Promise<void>((resolve) => { writeStarted = resolve })
    let releaseWrite!: () => void
    const released = new Promise<void>((resolve) => { releaseWrite = resolve })
    vi.spyOn(credentialsA, 'set').mockImplementation(async (reference, payload) => {
      if (payload.apiKey === 'delayed-authenticated-secret') {
        writeStarted()
        await released
      }
      await originalSet(reference, payload)
    })

    const reconnect = a.connectAuthenticated({
      expectedRevision: connected.revision,
      id: 'deepseek',
      name: 'DeepSeek OAuth',
      kind: 'http',
      authType: 'oauth',
      baseUrl: 'https://api.deepseek.com',
      endpointFormat: 'chat_completions',
      credential: 'delayed-authenticated-secret',
      models: ['deepseek-chat'],
      selectedModel: 'deepseek-chat',
      select: true
    })
    await started
    const staleRef = manager.registryDocument().credentialTransactions.deepseek!.nextCredentialRef!
    const operationToken = 'credential:11111111-1111-4111-8111-111111111111:1'
    const fenced = await b.fenceCredential('deepseek', {
      expectedRevision: manager.registryDocument().revision,
      operationToken
    })
    releaseWrite()

    await expect(reconnect).rejects.toBeInstanceOf(ModelConnectionConflictError)
    await expect(credentialsB.get(staleRef)).resolves.toBeNull()
    const prepared = await b.prepareCredential('deepseek', {
      expectedRevision: fenced.revision,
      credential: 'final-user-secret',
      operationToken
    })
    await b.commitPreparedCredential('deepseek', {
      expectedRevision: prepared.revision,
      operationToken
    })

    await expect(a.resolveApiKey(sourceId)).resolves.toEqual({ apiKey: 'final-user-secret' })
    expect(JSON.stringify(manager.registryDocument())).not.toContain('delayed-authenticated-secret')
    expect(JSON.stringify(manager.registryDocument())).not.toContain('final-user-secret')
  })

  it('restores the previous credential when prepared commit live apply fails', async () => {
    let rejectCommittingApply = false
    const { a, manager } = await sharedManagerRegistryPair({
      optionsA: {
        onChanged: (connections) => {
          if (
            rejectCommittingApply &&
            connections.providers.get('deepseek')?.apiKey === ''
          ) {
            rejectCommittingApply = false
            throw new Error('reject committing apply')
          }
        }
      }
    })
    const connected = await a.connect(deepseekConnection())
    const sourceId = (await a.materialize()).providers.get('deepseek')!.credentialSourceId!
    const operationToken = 'credential:11111111-1111-4111-8111-111111111111:1'
    const fenced = await a.fenceCredential('deepseek', {
      expectedRevision: connected.revision,
      operationToken
    })
    const prepared = await a.prepareCredential('deepseek', {
      expectedRevision: fenced.revision,
      credential: 'rejected-secret',
      operationToken
    })
    rejectCommittingApply = true

    await expect(a.commitPreparedCredential('deepseek', {
      expectedRevision: prepared.revision,
      operationToken
    })).rejects.toThrow('reject committing apply')

    await expect(a.resolveApiKey(sourceId)).resolves.toEqual({ apiKey: 'original-secret' })
    expect(manager.registryDocument().credentialTransactions.deepseek).toBeUndefined()
    expect(manager.registryDocument().credentialRefCleanup).toEqual({})
  })

  it('restores the previous credential when tokenless replace live apply fails', async () => {
    let rejectCommittingApply = false
    const { a, manager } = await sharedManagerRegistryPair({
      optionsA: {
        onChanged: (connections) => {
          if (
            rejectCommittingApply &&
            connections.providers.get('deepseek')?.apiKey === ''
          ) {
            rejectCommittingApply = false
            throw new Error('reject replace apply')
          }
        }
      }
    })
    const connected = await a.connect(deepseekConnection())
    const sourceId = (await a.materialize()).providers.get('deepseek')!.credentialSourceId!
    rejectCommittingApply = true

    await expect(a.replaceCredential('deepseek', {
      expectedRevision: connected.revision,
      credential: 'rejected-replacement-secret'
    })).rejects.toThrow('reject replace apply')

    await expect(a.resolveApiKey(sourceId)).resolves.toEqual({ apiKey: 'original-secret' })
    expect(manager.registryDocument().credentialTransactions.deepseek).toBeUndefined()
    expect(manager.registryDocument().credentialRefCleanup).toEqual({})
  })

  it('restores the previous credential when OAuth refresh live apply fails', async () => {
    let rejectCommittingApply = false
    const { a, manager } = await sharedManagerRegistryPair({
      optionsA: {
        onChanged: (connections) => {
          if (
            rejectCommittingApply &&
            connections.providers.get('deepseek')?.apiKey === ''
          ) {
            rejectCommittingApply = false
            throw new Error('reject refresh apply')
          }
        }
      }
    })
    await a.connect(deepseekConnection())
    const sourceId = (await a.materialize()).providers.get('deepseek')!.credentialSourceId!
    rejectCommittingApply = true

    await expect(a.updateResolvedApiKey(
      sourceId,
      'original-secret',
      'rejected-refresh-secret'
    )).rejects.toThrow('reject refresh apply')

    await expect(a.resolveApiKey(sourceId)).resolves.toEqual({ apiKey: 'original-secret' })
    expect(manager.registryDocument().credentialTransactions.deepseek).toBeUndefined()
    expect(manager.registryDocument().credentialRefCleanup).toEqual({})
  })

  it('lets a second Manager-backed Registry supersede a delayed committing generation', async () => {
    let commitRecorded!: () => void
    const recorded = new Promise<void>((resolve) => { commitRecorded = resolve })
    let releaseCommit!: () => void
    const released = new Promise<void>((resolve) => { releaseCommit = resolve })
    const { a, b, manager, credentialsB } = await sharedManagerRegistryPair({
      optionsA: {
        afterCredentialCommitRecord: async () => {
          commitRecorded()
          await released
        }
      }
    })
    const connected = await a.connect(deepseekConnection())
    const sourceId = (await a.materialize()).providers.get('deepseek')!.credentialSourceId!
    const firstToken = 'credential:11111111-1111-4111-8111-111111111111:1'
    const finalToken = 'credential:11111111-1111-4111-8111-111111111111:2'
    const firstFence = await a.fenceCredential('deepseek', {
      expectedRevision: connected.revision,
      operationToken: firstToken
    })
    const firstPrepared = await a.prepareCredential('deepseek', {
      expectedRevision: firstFence.revision,
      credential: 'superseded-secret',
      operationToken: firstToken
    })
    const staleCommit = a.commitPreparedCredential('deepseek', {
      expectedRevision: firstPrepared.revision,
      operationToken: firstToken
    })
    await recorded
    const staleRef = manager.registryDocument().credentialTransactions.deepseek!.nextCredentialRef!

    const finalFence = await b.fenceCredential('deepseek', {
      expectedRevision: manager.registryDocument().revision,
      operationToken: finalToken
    })
    releaseCommit()
    await expect(staleCommit).rejects.toBeInstanceOf(ModelConnectionConflictError)
    await expect(credentialsB.get(staleRef)).resolves.toBeNull()

    const finalPrepared = await b.prepareCredential('deepseek', {
      expectedRevision: finalFence.revision,
      credential: 'final-secret',
      operationToken: finalToken
    })
    await b.commitPreparedCredential('deepseek', {
      expectedRevision: finalPrepared.revision,
      operationToken: finalToken
    })
    await expect(a.resolveApiKey(sourceId)).resolves.toEqual({ apiKey: 'final-secret' })
    expect(JSON.stringify(manager.registryDocument())).not.toContain('superseded-secret')
    expect(JSON.stringify(manager.registryDocument())).not.toContain('final-secret')
  })

  it('retries connect cleanup after final CAS conflict while the writer is still alive', async () => {
    let managerRef: ReturnType<typeof installFakeAtomicJsonManager> | undefined
    let dataDirRef = ''
    let reservedRef = ''
    const pair = await sharedManagerRegistryPair({
      optionsA: {
        afterCredentialConnectWrite: async (providerId) => {
          const manager = managerRef!
          const path = join(dataDirRef, 'model-connections.v1.json')
          const entry = manager.documents.get(path)!
          const value = structuredClone(entry.value) as {
            revision: number
            credentialTransactions: Record<string, { nextCredentialRef?: string }>
          }
          reservedRef = value.credentialTransactions[providerId]!.nextCredentialRef!
          delete value.credentialTransactions[providerId]
          value.revision += 1
          manager.documents.set(path, { revision: entry.revision + 1, value })
        }
      }
    })
    managerRef = pair.manager
    dataDirRef = pair.dataDir
    const deleteCredential = vi.spyOn(pair.credentialsA, 'delete')
      .mockRejectedValueOnce(new Error('keychain delete failed'))

    await expect(pair.a.connect(deepseekConnection())).rejects.toBeInstanceOf(
      ModelConnectionConflictError
    )
    expect(reservedRef).toMatch(/^cred_/u)
    expect(deleteCredential).toHaveBeenCalledTimes(2)
    await expect(pair.credentialsB.get(reservedRef)).resolves.toBeNull()
    expect(pair.manager.registryDocument().credentialRefCleanup).not.toHaveProperty(reservedRef)
    expect(pair.manager.registryDocument().profiles.deepseek).toBeUndefined()
  })

  it('recovers a connect reservation after the writer crashes between secret write and finalize', async () => {
    let writeStarted!: () => void
    const started = new Promise<void>((resolve) => { writeStarted = resolve })
    let releaseWriter!: () => void
    const released = new Promise<void>((resolve) => { releaseWriter = resolve })
    const { a, b, manager, credentialsB } = await sharedManagerRegistryPair({
      optionsA: {
        afterCredentialConnectWrite: async () => {
          writeStarted()
          await released
        }
      },
      optionsB: { isProcessAlive: () => false }
    })
    const connecting = a.connect(deepseekConnection())
    await started
    const reservedRef = manager.registryDocument().credentialTransactions.deepseek!.nextCredentialRef!
    await expect(credentialsB.get(reservedRef)).resolves.toEqual({ apiKey: 'original-secret' })

    await b.initialize()
    expect(manager.registryDocument().credentialTransactions.deepseek).toBeUndefined()
    await expect(credentialsB.get(reservedRef)).resolves.toBeNull()
    releaseWriter()
    await expect(connecting).rejects.toBeInstanceOf(ModelConnectionConflictError)
    expect(manager.registryDocument().profiles.deepseek).toBeUndefined()
    expect(manager.registryDocument().credentialRefCleanup).not.toHaveProperty(reservedRef)
  })

  it('fails closed instead of using local Registry RMW outside Manager authority', async () => {
    const managedDataDir = await mkdtemp(join(tmpdir(), 'kun-managed-registry-authority-'))
    const mismatchedDataDir = await mkdtemp(join(tmpdir(), 'kun-mismatched-registry-authority-'))
    roots.push(managedDataDir, mismatchedDataDir)
    installFakeAtomicJsonManager(managedDataDir)
    const credentials = new ExtensionCredentialStore({
      dataDir: mismatchedDataDir,
      profileId: 'test'
    })

    expect(() => new ModelConnectionRegistry({
      dataDir: mismatchedDataDir,
      credentials
    })).toThrow(/outside the configured Manager data directory/)
    await expect(readFile(
      join(mismatchedDataDir, 'model-connections.v1.json'),
      'utf8'
    )).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('moves an existing Registry AtomicJson client from Manager M1 to M2', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'kun-registry-manager-rebind-'))
    roots.push(dataDir)
    let document: FakeManagerDocument = { revision: 0, value: null }
    const requests: Array<{ url: string; method: string }> = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        expectedRevision?: number
        value?: unknown
      }
      requests.push({ url, method: String(init?.method ?? 'GET') })
      if (url.endsWith('/read')) return Response.json({ snapshot: structuredClone(document) })
      if (body.expectedRevision !== document.revision) {
        return Response.json({ currentRevision: document.revision }, { status: 409 })
      }
      document = {
        revision: document.revision + 1,
        value: structuredClone(body.value ?? null)
      }
      return Response.json({ snapshot: structuredClone(document) })
    }))
    configureManagerAtomicJsonClient({
      baseUrl: 'http://manager-one.test',
      token: 'manager-one-token',
      dataDir
    })
    const value = new ModelConnectionRegistry({
      dataDir,
      credentials: new ExtensionCredentialStore({ dataDir, profileId: 'test' })
    })
    await value.initialize()
    const rebindAt = requests.length

    configureManagerAtomicJsonClient({
      baseUrl: 'http://manager-two.test',
      token: 'manager-two-token',
      dataDir
    })
    await value.connect({
      expectedRevision: 0,
      id: 'claude-subscription',
      name: 'Claude subscription',
      kind: 'agent-sdk',
      authType: 'subscription',
      endpointFormat: 'messages',
      models: ['claude-sonnet'],
      selectedModel: 'claude-sonnet',
      probe: false,
      select: true
    })

    const reboundRequests = requests.slice(rebindAt)
    expect(reboundRequests.some((request) => request.url.endsWith('/write'))).toBe(true)
    expect(reboundRequests.length).toBeGreaterThan(1)
    expect(reboundRequests.every((request) =>
      request.url.startsWith('http://manager-two.test/'))).toBe(true)
  })

  it('rejects a delayed lower generation after the newer generation committed', async () => {
    const { a, b } = await sharedManagerRegistryPair()
    const connected = await a.connect(deepseekConnection())
    const clientId = '11111111-1111-4111-8111-111111111111'
    const newerToken = `credential:${clientId}:2`
    const staleToken = `credential:${clientId}:1`
    const fenced = await b.fenceCredential('deepseek', {
      expectedRevision: connected.revision,
      operationToken: newerToken
    })
    const prepared = await b.prepareCredential('deepseek', {
      expectedRevision: fenced.revision,
      credential: 'newer-secret',
      operationToken: newerToken
    })
    const committed = await b.commitPreparedCredential('deepseek', {
      expectedRevision: prepared.revision,
      operationToken: newerToken
    })

    await expect(a.fenceCredential('deepseek', {
      expectedRevision: committed.revision,
      operationToken: staleToken
    })).rejects.toBeInstanceOf(ModelConnectionConflictError)
    await expect(a.credentialStateForInternalConsumer('deepseek')).resolves.toEqual({
      authoritative: true,
      apiKey: 'newer-secret'
    })
  })

  it('releases local prepared plaintext after another Registry supersedes and commits', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const { a, b } = await sharedManagerRegistryPair({
      optionsA: { credentialFenceTtlMs: 60_000 },
      optionsB: { credentialFenceTtlMs: 60_000 }
    })
    const connected = await a.connect(deepseekConnection())
    const sourceId = (await a.materialize()).providers.get('deepseek')!.credentialSourceId!
    const firstToken = 'credential:11111111-1111-4111-8111-111111111111:1'
    const secondToken = 'credential:11111111-1111-4111-8111-111111111111:2'
    const firstFence = await a.fenceCredential('deepseek', {
      expectedRevision: connected.revision,
      operationToken: firstToken
    })
    await a.prepareCredential('deepseek', {
      expectedRevision: firstFence.revision,
      credential: 'abandoned-local-plaintext',
      operationToken: firstToken
    })
    const firstProcess = a as unknown as {
      preparedCredentialSecrets: Map<string, { operationToken: string }>
      recoverExpiredCredentialTransaction(providerId: string, operationToken: string): Promise<boolean>
    }
    expect(firstProcess.preparedCredentialSecrets.get('deepseek')).toMatchObject({
      operationToken: firstToken
    })

    const secondFence = await b.fenceCredential('deepseek', {
      expectedRevision: (await b.snapshot()).revision,
      operationToken: secondToken
    })
    await a.materialize()
    expect(firstProcess.preparedCredentialSecrets.get('deepseek')).toMatchObject({
      operationToken: firstToken
    })
    const secondPrepared = await b.prepareCredential('deepseek', {
      expectedRevision: secondFence.revision,
      credential: 'authoritative-second-secret',
      operationToken: secondToken
    })
    await b.commitPreparedCredential('deepseek', {
      expectedRevision: secondPrepared.revision,
      operationToken: secondToken
    })
    await vi.advanceTimersByTimeAsync(70_000)
    expect(firstProcess.preparedCredentialSecrets.has('deepseek')).toBe(false)
    await expect(b.resolveApiKey(sourceId)).resolves.toEqual({
      apiKey: 'authoritative-second-secret'
    })
    expect((await b.snapshot()).providers[0]).toMatchObject({ configured: true })
  })

  it('releases local prepared plaintext after another Registry deletes the provider', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const { a, b, manager } = await sharedManagerRegistryPair({
      optionsA: { credentialFenceTtlMs: 60_000 },
      optionsB: { credentialFenceTtlMs: 60_000 }
    })
    const connected = await a.connect(deepseekConnection())
    const firstToken = 'credential:11111111-1111-4111-8111-111111111111:1'
    const firstFence = await a.fenceCredential('deepseek', {
      expectedRevision: connected.revision,
      operationToken: firstToken
    })
    await a.prepareCredential('deepseek', {
      expectedRevision: firstFence.revision,
      credential: 'deleted-local-plaintext',
      operationToken: firstToken
    })
    const firstProcess = a as unknown as {
      preparedCredentialSecrets: Map<string, { operationToken: string }>
    }
    const secondToken = 'credential:11111111-1111-4111-8111-111111111111:2'
    const secondFence = await b.fenceCredential('deepseek', {
      expectedRevision: (await b.snapshot()).revision,
      operationToken: secondToken
    })
    await a.materialize()
    expect(firstProcess.preparedCredentialSecrets.get('deepseek')).toMatchObject({
      operationToken: firstToken
    })
    await b.delete('deepseek', secondFence.revision)

    await vi.advanceTimersByTimeAsync(70_000)
    expect(firstProcess.preparedCredentialSecrets.has('deepseek')).toBe(false)
    expect((await b.snapshot()).providers).toEqual([])
    expect(manager.registryDocument().profiles.deepseek).toBeUndefined()
    expect(manager.registryDocument().credentialTransactions.deepseek).toBeUndefined()
  })

  it('does not clear a current prepared secret when a stale durable schedule resumes', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const { a, manager } = await sharedManagerRegistryPair({
      optionsA: { credentialFenceTtlMs: 60_000 }
    })
    const connected = await a.connect(deepseekConnection())
    const firstToken = 'credential:11111111-1111-4111-8111-111111111111:1'
    const secondToken = 'credential:11111111-1111-4111-8111-111111111111:2'
    const firstFence = await a.fenceCredential('deepseek', {
      expectedRevision: connected.revision,
      operationToken: firstToken
    })
    await a.prepareCredential('deepseek', {
      expectedRevision: firstFence.revision,
      credential: 'superseded-local-secret',
      operationToken: firstToken
    })
    const staleTransaction = structuredClone(
      manager.registryDocument().credentialTransactions.deepseek
    )

    const secondFence = await a.fenceCredential('deepseek', {
      expectedRevision: (await a.snapshot()).revision,
      operationToken: secondToken
    })
    const secondPrepared = await a.prepareCredential('deepseek', {
      expectedRevision: secondFence.revision,
      credential: 'current-local-secret',
      operationToken: secondToken
    })
    const firstProcess = a as unknown as {
      preparedCredentialSecrets: Map<string, { operationToken: string }>
      scheduleCredentialRecovery(providerId: string, transaction: unknown): void
    }

    firstProcess.scheduleCredentialRecovery('deepseek', staleTransaction)
    expect(firstProcess.preparedCredentialSecrets.get('deepseek')).toMatchObject({
      operationToken: secondToken
    })
    await a.commitPreparedCredential('deepseek', {
      expectedRevision: secondPrepared.revision,
      operationToken: secondToken
    })
    await expect(a.credentialStateForInternalConsumer('deepseek')).resolves.toEqual({
      authoritative: true,
      apiKey: 'current-local-secret'
    })
  })

  it('expires the same operation token independently for two providers', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const { a } = await sharedManagerRegistryPair({
      optionsA: { credentialFenceTtlMs: 60_000 }
    })
    const first = await a.connect(deepseekConnection())
    const second = await a.connect({
      ...deepseekConnection(first.revision),
      id: 'other-provider',
      name: 'Other Provider'
    })
    const sharedToken = 'credential:11111111-1111-4111-8111-111111111111:1'
    const firstFence = await a.fenceCredential('deepseek', {
      expectedRevision: second.revision,
      operationToken: sharedToken
    })
    await a.prepareCredential('deepseek', {
      expectedRevision: firstFence.revision,
      credential: 'deepseek-pending-secret',
      operationToken: sharedToken
    })
    const secondFence = await a.fenceCredential('other-provider', {
      expectedRevision: (await a.snapshot()).revision,
      operationToken: sharedToken
    })
    await a.prepareCredential('other-provider', {
      expectedRevision: secondFence.revision,
      credential: 'other-pending-secret',
      operationToken: sharedToken
    })
    const firstProcess = a as unknown as {
      preparedCredentialSecrets: Map<string, { operationToken: string }>
      preparedCredentialSecretTimers: Map<string, ReturnType<typeof setTimeout>>
    }
    expect(firstProcess.preparedCredentialSecrets.size).toBe(2)
    expect(firstProcess.preparedCredentialSecretTimers.size).toBe(2)

    await vi.advanceTimersByTimeAsync(70_000)
    expect(firstProcess.preparedCredentialSecrets.size).toBe(0)
    expect(firstProcess.preparedCredentialSecretTimers.size).toBe(0)
  })

  it('carries client generation high-water across delete and same-id re-add', async () => {
    const { a, b } = await sharedManagerRegistryPair()
    const connected = await a.connect(deepseekConnection())
    const clientId = '11111111-1111-4111-8111-111111111111'
    const firstToken = `credential:${clientId}:1`
    const fenced = await a.fenceCredential('deepseek', {
      expectedRevision: connected.revision,
      operationToken: firstToken
    })
    const deleted = await b.delete('deepseek', fenced.revision)
    const readded = await b.connect({
      ...deepseekConnection(deleted.revision),
      credential: 'new-incarnation-secret'
    })

    await expect(a.fenceCredential('deepseek', {
      expectedRevision: readded.revision,
      operationToken: firstToken
    })).rejects.toBeInstanceOf(ModelConnectionConflictError)
    await expect(a.credentialStateForInternalConsumer('deepseek')).resolves.toEqual({
      authoritative: true,
      apiKey: 'new-incarnation-secret'
    })
    await expect(a.fenceCredential('deepseek', {
      expectedRevision: readded.revision,
      operationToken: `credential:${clientId}:2`
    })).resolves.toMatchObject({
      providers: [expect.objectContaining({ credentialStatus: 'missing' })]
    })
  })

  it('retains the current client when bounding sixty-four generation high-waters', async () => {
    const { a, manager } = await sharedManagerRegistryPair()
    let snapshot = await a.connect(deepseekConnection())
    const clientIds = Array.from({ length: 64 }, (_, index) =>
      `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`)
    for (const clientId of clientIds) {
      snapshot = await a.fenceCredential('deepseek', {
        expectedRevision: snapshot.revision,
        operationToken: `credential:${clientId}:1`
      })
    }
    snapshot = await a.fenceCredential('deepseek', {
      expectedRevision: snapshot.revision,
      operationToken: `credential:${clientIds[0]}:2`
    })

    const profile = manager.registryDocument().profiles.deepseek as {
      credentialMutationHighWater?: Record<string, number>
    }
    expect(Object.keys(profile.credentialMutationHighWater ?? {})).toHaveLength(64)
    expect(profile.credentialMutationHighWater?.[clientIds[0]!]).toBe(2)
    await expect(a.fenceCredential('deepseek', {
      expectedRevision: snapshot.revision,
      operationToken: `credential:${clientIds[0]}:1`
    })).rejects.toBeInstanceOf(ModelConnectionConflictError)
  })

  it('keeps an expired fence durable when recovery apply fails once', async () => {
    let now = 0
    let failRecovery = false
    let recoveryAttempts = 0
    const { a, b, manager } = await sharedManagerRegistryPair({
      optionsA: { credentialFenceTtlMs: 60_000, nowMs: () => now },
      optionsB: {
        credentialFenceTtlMs: 60_000,
        nowMs: () => now,
        onChanged: (connections) => {
          if (!failRecovery || connections.providers.get('deepseek')?.apiKey !== 'original-secret') return
          recoveryAttempts += 1
          failRecovery = false
          throw new Error('fail recovery apply once')
        }
      }
    })
    const connected = await a.connect(deepseekConnection())
    const sourceId = (await a.materialize()).providers.get('deepseek')!.credentialSourceId!
    const operationToken = 'credential:11111111-1111-4111-8111-111111111111:1'
    const fenced = await a.fenceCredential('deepseek', {
      expectedRevision: connected.revision,
      operationToken
    })
    await a.prepareCredential('deepseek', {
      expectedRevision: fenced.revision,
      credential: 'abandoned-secret',
      operationToken
    })
    now = 70_000
    failRecovery = true

    await expect(b.resolveApiKey(sourceId)).resolves.toBeNull()
    expect(manager.registryDocument().credentialTransactions.deepseek?.phase).toBe('recovering')
    await expect(b.credentialStateForInternalConsumer('deepseek')).resolves.toEqual({
      authoritative: true,
      apiKey: 'original-secret'
    })
    expect(recoveryAttempts).toBe(1)
    expect(manager.registryDocument().credentialTransactions.deepseek).toBeUndefined()
  })

  it('rejects a new fence while another Registry is applying non-HTTP recovery', async () => {
    let now = 0
    let recoveryStarted!: () => void
    const started = new Promise<void>((resolve) => { recoveryStarted = resolve })
    let releaseRecovery!: () => void
    const released = new Promise<void>((resolve) => { releaseRecovery = resolve })
    let blockRecovery = false
    const { a, b } = await sharedManagerRegistryPair({
      optionsA: { credentialFenceTtlMs: 60_000, nowMs: () => now },
      optionsB: {
        credentialFenceTtlMs: 60_000,
        nowMs: () => now,
        onChanged: async (connections) => {
          if (!blockRecovery || connections.providers.get('sdk-provider')?.apiKey !== 'sdk-secret') return
          blockRecovery = false
          recoveryStarted()
          await released
        }
      }
    })
    const connected = await a.connect({
      expectedRevision: 0,
      id: 'sdk-provider',
      name: 'SDK Provider',
      kind: 'agent-sdk',
      authType: 'subscription',
      endpointFormat: 'messages',
      credential: 'sdk-secret',
      models: ['sdk-model'],
      selectedModel: 'sdk-model',
      probe: false,
      select: true
    })
    const sourceId = (await a.materialize()).providers.get('sdk-provider')!.credentialSourceId!
    const firstToken = 'credential:11111111-1111-4111-8111-111111111111:1'
    const nextToken = 'credential:11111111-1111-4111-8111-111111111111:2'
    const fenced = await a.fenceCredential('sdk-provider', {
      expectedRevision: connected.revision,
      operationToken: firstToken
    })
    await a.prepareCredential('sdk-provider', {
      expectedRevision: fenced.revision,
      credential: 'abandoned-sdk-secret',
      operationToken: firstToken
    })
    now = 70_000
    blockRecovery = true
    const recovering = b.resolveApiKey(sourceId)
    await started

    await expect(a.fenceCredential('sdk-provider', {
      expectedRevision: (await a.snapshot()).revision,
      operationToken: nextToken
    })).rejects.toBeInstanceOf(ModelConnectionConflictError)
    releaseRecovery()
    await expect(recovering).resolves.toEqual({ apiKey: 'sdk-secret' })

    const nextFence = await a.fenceCredential('sdk-provider', {
      expectedRevision: (await a.snapshot()).revision,
      operationToken: nextToken
    })
    expect(nextFence.providers[0]).toMatchObject({ credentialStatus: 'missing' })
    expect((await a.materialize()).providers.get('sdk-provider')).toMatchObject({ apiKey: '' })
  })

  it('keeps a cleanup tombstone when expiry deletes before a delayed secret write', async () => {
    let now = 0
    let commitRecorded!: () => void
    const recorded = new Promise<void>((resolve) => { commitRecorded = resolve })
    let releaseCommit!: () => void
    const released = new Promise<void>((resolve) => { releaseCommit = resolve })
    const { a, b, manager, credentialsB } = await sharedManagerRegistryPair({
      optionsA: {
        credentialFenceTtlMs: 60_000,
        nowMs: () => now,
        afterCredentialCommitRecord: async () => {
          commitRecorded()
          await released
        }
      },
      optionsB: { credentialFenceTtlMs: 60_000, nowMs: () => now }
    })
    const connected = await a.connect(deepseekConnection())
    const sourceId = (await a.materialize()).providers.get('deepseek')!.credentialSourceId!
    const operationToken = 'credential:11111111-1111-4111-8111-111111111111:1'
    const fenced = await a.fenceCredential('deepseek', {
      expectedRevision: connected.revision,
      operationToken
    })
    const prepared = await a.prepareCredential('deepseek', {
      expectedRevision: fenced.revision,
      credential: 'late-orphan-secret',
      operationToken
    })
    const commit = a.commitPreparedCredential('deepseek', {
      expectedRevision: prepared.revision,
      operationToken
    })
    await recorded
    const staleRef = manager.registryDocument().credentialTransactions.deepseek!.nextCredentialRef!
    now = 70_000

    await expect(b.resolveApiKey(sourceId)).resolves.toEqual({ apiKey: 'original-secret' })
    expect(manager.registryDocument().credentialRefCleanup).toHaveProperty(staleRef)
    await expect(credentialsB.get(staleRef)).resolves.toBeNull()
    releaseCommit()
    await expect(commit).rejects.toBeInstanceOf(ModelConnectionConflictError)
    await expect(credentialsB.get(staleRef)).resolves.toBeNull()
    expect(manager.registryDocument().credentialRefCleanup).not.toHaveProperty(staleRef)
  })

  it('keeps a retryable cleanup record when the stale writer delete fails once', async () => {
    let commitRecorded!: () => void
    const recorded = new Promise<void>((resolve) => { commitRecorded = resolve })
    let releaseCommit!: () => void
    const released = new Promise<void>((resolve) => { releaseCommit = resolve })
    const { a, b, manager, credentialsA, credentialsB } = await sharedManagerRegistryPair({
      optionsA: {
        afterCredentialCommitRecord: async () => {
          commitRecorded()
          await released
        }
      }
    })
    const connected = await a.connect(deepseekConnection())
    const operationToken = 'credential:11111111-1111-4111-8111-111111111111:1'
    const fenced = await a.fenceCredential('deepseek', {
      expectedRevision: connected.revision,
      operationToken
    })
    const prepared = await a.prepareCredential('deepseek', {
      expectedRevision: fenced.revision,
      credential: 'delete-retry-secret',
      operationToken
    })
    const commit = a.commitPreparedCredential('deepseek', {
      expectedRevision: prepared.revision,
      operationToken
    })
    await recorded
    const staleRef = manager.registryDocument().credentialTransactions.deepseek!.nextCredentialRef!
    await b.fenceCredential('deepseek', {
      expectedRevision: manager.registryDocument().revision,
      operationToken: 'credential:11111111-1111-4111-8111-111111111111:2'
    })
    const originalDelete = credentialsA.delete.bind(credentialsA)
    let failDelete = true
    vi.spyOn(credentialsA, 'delete').mockImplementation(async (reference) => {
      if (reference === staleRef && failDelete) {
        failDelete = false
        throw new Error('delete failed once')
      }
      await originalDelete(reference)
    })
    releaseCommit()

    await expect(commit).rejects.toBeInstanceOf(ModelConnectionConflictError)
    await expect(credentialsB.get(staleRef)).resolves.toMatchObject({ apiKey: 'delete-retry-secret' })
    expect(manager.registryDocument().credentialRefCleanup[staleRef]).toEqual({
      reference: staleRef,
      enqueuedAt: expect.any(Number)
    })
    await b.initialize()
    await expect(credentialsB.get(staleRef)).resolves.toBeNull()
    expect(manager.registryDocument().credentialRefCleanup).not.toHaveProperty(staleRef)
  })

  it('reclaims acknowledged credential refs without an unbounded cleanup queue', async () => {
    const { a, manager, credentialsA } = await sharedManagerRegistryPair()
    let snapshot = await a.connect(deepseekConnection())
    const deletedRefs: string[] = []
    const originalDelete = credentialsA.delete.bind(credentialsA)
    vi.spyOn(credentialsA, 'delete').mockImplementation(async (reference) => {
      deletedRefs.push(reference)
      await originalDelete(reference)
    })

    for (let index = 0; index < 8; index += 1) {
      snapshot = await a.replaceCredential('deepseek', {
        expectedRevision: snapshot.revision,
        credential: `rotated-${index}`
      })
      expect(manager.registryDocument().credentialRefCleanup).toEqual({})
    }
    expect(new Set(deletedRefs).size).toBe(8)
    expect(deletedRefs).toHaveLength(8)
    await a.initialize()
    expect(deletedRefs).toHaveLength(8)
  })

  it('isolates an unreadable legacy credential and reports replacement as ready', async () => {
    const retired = vi.fn(async (_sourceId: string) => undefined)
    const inspectLegacy = vi.fn(async (sourceId: string) => {
      if (sourceId === 'settings:provider:deepseek') {
        throw new Error(`decrypt failed for ${sourceId}: secret material must stay private`)
      }
      return 'missing' as const
    })
    const { dataDir, value } = await registry(
      undefined,
      retired,
      undefined,
      inspectLegacy
    )
    const seeded = await value.initialize([
      {
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
      },
      {
        expectedRevision: 0,
        id: 'healthy',
        name: 'Healthy Provider',
        kind: 'http',
        authType: 'api-key',
        baseUrl: 'https://healthy.example.test/v1',
        endpointFormat: 'chat_completions',
        credential: 'healthy-secret',
        models: ['healthy-model'],
        selectedModel: 'healthy-model',
        probe: false,
        select: false
      }
    ])

    expect(seeded.providers.find((profile) => profile.id === 'deepseek')).toMatchObject({
      configured: true,
      credentialStatus: 'unreadable',
      credentialErrorCode: 'credential_unreadable'
    })
    expect(seeded.providers.find((profile) => profile.id === 'healthy')).toMatchObject({
      configured: true,
      credentialStatus: 'ready'
    })
    expect(JSON.stringify(seeded)).not.toContain('settings:provider:deepseek')
    expect(JSON.stringify(seeded)).not.toContain('decrypt failed')
    expect(JSON.stringify(seeded)).not.toContain('secret material')
    const beforeReplacement = await value.materialize()
    expect(beforeReplacement.providers.get('healthy')).toMatchObject({
      apiKey: 'healthy-secret'
    })
    expect(beforeReplacement.providers.get('deepseek')).toMatchObject({
      apiKey: '',
      credentialSourceId: 'settings:provider:deepseek'
    })

    const replaced = await value.replaceCredential('deepseek', {
      expectedRevision: seeded.revision,
      credential: 'replacement-secret'
    })

    expect(replaced.providers.find((profile) => profile.id === 'deepseek')).toMatchObject({
      configured: true,
      credentialStatus: 'ready'
    })
    expect(replaced.providers.find((profile) => profile.id === 'deepseek'))
      .not.toHaveProperty('credentialErrorCode')
    expect((await value.materialize()).providers.get('deepseek')).toMatchObject({
      credentialSourceId: 'model-connection:deepseek',
      apiKey: 'replacement-secret'
    })
    expect(retired).toHaveBeenCalledWith('settings:provider:deepseek')

    const stored = await readFile(join(dataDir, 'model-connections.v1.json'), 'utf8')
    expect(stored).not.toContain('credentialStatus')
    expect(stored).not.toContain('credentialErrorCode')
    expect(stored).not.toContain('replacement-secret')
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

  it('makes a delayed OAuth refresh conflict with a newer durable user generation', async () => {
    const { a, b } = await sharedManagerRegistryPair()
    const oldCredential = JSON.stringify({
      kind: 'codex-oauth',
      accessToken: 'expired-access',
      refreshToken: 'old-refresh',
      expiresAt: 1,
      accountId: 'old-account'
    })
    const connected = await a.connect({
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
    const sourceId = (await a.materialize()).providers.get('codex')!.credentialSourceId!
    let refreshStarted!: () => void
    const started = new Promise<void>((resolve) => { refreshStarted = resolve })
    let releaseRefresh!: () => void
    const released = new Promise<void>((resolve) => { releaseRefresh = resolve })
    const refresher = new CodexOAuthCredentialRefresher(a, {
      nowMs: () => 10_000,
      fetchImpl: async () => {
        refreshStarted()
        await released
        return Response.json({
          access_token: 'late-access',
          refresh_token: 'late-refresh',
          expires_in: 3_600
        })
      }
    })
    const lateRefresh = refresher.resolve(sourceId)
    await started

    const replacement = JSON.stringify({
      kind: 'codex-oauth',
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      expiresAt: 9_999_999,
      accountId: 'new-account'
    })
    const operationToken = 'credential:11111111-1111-4111-8111-111111111111:1'
    const fenced = await b.fenceCredential('codex', {
      expectedRevision: connected.revision,
      operationToken
    })
    const prepared = await b.prepareCredential('codex', {
      expectedRevision: fenced.revision,
      credential: replacement,
      operationToken
    })
    await b.commitPreparedCredential('codex', {
      expectedRevision: prepared.revision,
      operationToken
    })
    releaseRefresh()

    await expect(lateRefresh).resolves.toEqual({ rawApiKey: replacement, refreshable: true })
    await expect(a.resolveApiKey(sourceId)).resolves.toEqual({ apiKey: replacement })
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
        revision: 2,
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
    expect((error as ModelConnectionConflictError).snapshot.providers[0]).toMatchObject({
      credentialStatus: 'ready'
    })
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
