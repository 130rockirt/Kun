import { createElement } from 'react'
import {
  act,
  create as createRenderer,
  type ReactTestInstance,
  type ReactTestRenderer
} from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  defaultKunRuntimeSettings,
  defaultModelProviderSettings,
  type ModelProviderModelProfileV1,
  type ModelProviderProfileV1
} from '@shared/app-settings'
import {
  ProvidersSettingsSection,
  applyPendingSharedProviderCatalog,
  clearPendingSharedProviderDeletionForExplicitAdd,
  commitSharedModelConnectionCatalog,
  createSharedModelMutationQueue,
  deleteSharedModelConnection,
  fenceSharedModelConnectionCredential,
  projectSharedModelConnections,
  rebasePendingSharedProviderCatalog,
  reconcilePendingSharedProviderCatalogs,
  reconcilePendingSharedProviderDeletions,
  reconcilePendingSharedProviderNames,
  replaceSharedModelConnectionCredential,
  selectSharedModelConnection,
  sharedModelConnectionHasUsableCredential,
  sharedProvidersEligibleForSync,
  sharedProviderSetupNeedsApiKey
} from './settings-section-providers'
import {
  drainSharedProviderCredentialMutation,
  enqueueSharedModelMutation,
  resetSharedProviderMutationCoordinatorForTests,
  stageSharedProviderCredentialMutation,
  sharedProviderMutationCoordinator
} from './shared-provider-mutation-coordinator'
import { ProviderModelsManager } from './settings-section-provider-models'

const textModelProfile: ModelProviderModelProfileV1 = {
  inputModalities: ['text'],
  outputModalities: ['text'],
  supportsToolCalling: true,
  messageParts: ['text']
}

describe('shared model connection API-key setup status', () => {
  it('treats missing and unreadable protected credentials as unavailable', () => {
    expect(sharedModelConnectionHasUsableCredential({ configured: true })).toBe(true)
    expect(sharedModelConnectionHasUsableCredential({
      configured: true,
      credentialStatus: 'ready'
    })).toBe(true)
    expect(sharedModelConnectionHasUsableCredential({
      configured: true,
      credentialStatus: 'missing'
    })).toBe(false)
    expect(sharedModelConnectionHasUsableCredential({
      configured: true,
      credentialStatus: 'unreadable'
    })).toBe(false)
  })

  it('accepts a credential held only by the protected shared registry', () => {
    const providers = defaultModelProviderSettings().providers

    expect(sharedProviderSetupNeedsApiKey(providers, {
      schemaVersion: 1,
      revision: 1,
      providers: [{
        id: 'deepseek',
        accountId: 'account:deepseek',
        name: 'DeepSeek',
        kind: 'http',
        authType: 'api-key',
        baseUrl: 'https://api.deepseek.com',
        endpointFormat: 'chat_completions',
        configured: true,
        models: ['deepseek-chat']
      }]
    })).toBe(false)
  })

  it('requests setup only after the shared registry confirms no credential', () => {
    const providers = defaultModelProviderSettings().providers

    expect(sharedProviderSetupNeedsApiKey(providers, null)).toBe(false)
    expect(sharedProviderSetupNeedsApiKey(providers, {
      schemaVersion: 1,
      revision: 1,
      providers: [{
        id: 'deepseek',
        accountId: 'account:deepseek',
        name: 'DeepSeek',
        kind: 'http',
        authType: 'api-key',
        baseUrl: 'https://api.deepseek.com',
        endpointFormat: 'chat_completions',
        configured: false,
        models: ['deepseek-chat']
      }]
    })).toBe(true)
  })

  it('requests setup when a legacy credential binding is unreadable', () => {
    const providers = defaultModelProviderSettings().providers

    expect(sharedProviderSetupNeedsApiKey(providers, {
      schemaVersion: 1,
      revision: 2,
      providers: [{
        id: 'deepseek',
        accountId: 'account:deepseek',
        name: 'DeepSeek',
        kind: 'http',
        authType: 'api-key',
        baseUrl: 'https://api.deepseek.com',
        endpointFormat: 'chat_completions',
        configured: true,
        credentialStatus: 'unreadable',
        credentialErrorCode: 'credential_unreadable',
        models: ['deepseek-chat']
      }]
    })).toBe(true)
  })
})

describe('shared model connection deletion', () => {
  it('removes the canonical connection and retries one concurrent revision change', async () => {
    const connection = {
      id: 'custom-provider-2',
      accountId: 'account:custom-provider-2',
      name: 'Custom Provider',
      kind: 'http' as const,
      authType: 'api-key' as const,
      baseUrl: 'https://api.example.com/v1',
      endpointFormat: 'chat_completions' as const,
      configured: true,
      models: ['custom-model']
    }
    const snapshot = (revision: number, providers = [connection]) => ({
      schemaVersion: 1 as const,
      revision,
      providers
    })
    const runtimeRequest = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, body: JSON.stringify(snapshot(3)) })
      .mockResolvedValueOnce({
        ok: false,
        status: 409,
        body: JSON.stringify({ snapshot: snapshot(4) })
      })
      .mockResolvedValueOnce({ ok: true, status: 200, body: JSON.stringify(snapshot(5, [])) })
    vi.stubGlobal('window', { kunGui: { runtimeRequest } })

    try {
      await expect(deleteSharedModelConnection(connection.id)).resolves.toMatchObject({
        revision: 5,
        providers: []
      })
      expect(runtimeRequest.mock.calls.map(([path, method]) => [path, method])).toEqual([
        ['/v1/model-connections', 'GET'],
        ['/v1/model-connections/custom-provider-2?expected_revision=3', 'DELETE'],
        ['/v1/model-connections/custom-provider-2?expected_revision=4', 'DELETE']
      ])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('treats a concurrent deletion as an idempotent success', async () => {
    const connection = {
      id: 'custom-provider-2',
      accountId: 'account:custom-provider-2',
      name: 'Custom Provider',
      kind: 'http' as const,
      authType: 'api-key' as const,
      endpointFormat: 'chat_completions' as const,
      configured: true,
      models: ['custom-model']
    }
    const runtimeRequest = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        body: JSON.stringify({ schemaVersion: 1, revision: 9, providers: [connection] })
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 409,
        body: JSON.stringify({ snapshot: { schemaVersion: 1, revision: 10, providers: [] } })
      })
    vi.stubGlobal('window', { kunGui: { runtimeRequest } })

    try {
      await expect(deleteSharedModelConnection(connection.id)).resolves.toMatchObject({
        revision: 10,
        providers: []
      })
      expect(runtimeRequest).toHaveBeenCalledTimes(2)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('shared model connection selection', () => {
  const connection = (revisionName = 'account:custom-provider-2') => ({
    id: 'custom-provider-2',
    accountId: revisionName,
    name: 'Custom Provider',
    kind: 'http' as const,
    authType: 'api-key' as const,
    baseUrl: 'https://api.example.com/v1',
    endpointFormat: 'chat_completions' as const,
    configured: true,
    models: ['custom-model']
  })
  const snapshot = (revision: number, providers = [connection()]) => ({
    schemaVersion: 1 as const,
    revision,
    providers
  })

  it('reads the latest revision and retries one selection conflict with the refreshed account', async () => {
    const runtimeRequest = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, body: JSON.stringify(snapshot(7)) })
      .mockResolvedValueOnce({
        ok: false,
        status: 409,
        body: JSON.stringify({ snapshot: snapshot(8, [connection('account:refreshed')]) })
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        body: JSON.stringify({
          ...snapshot(9, [connection('account:refreshed')]),
          defaultProviderId: 'custom-provider-2',
          defaultAccountId: 'account:refreshed',
          defaultModel: 'custom-model'
        })
      })
    vi.stubGlobal('window', { kunGui: { runtimeRequest } })

    try {
      await expect(selectSharedModelConnection('custom-provider-2', 'custom-model'))
        .resolves.toMatchObject({ revision: 9, defaultAccountId: 'account:refreshed' })
      expect(runtimeRequest.mock.calls.map(([path, method, body]) => [
        path,
        method,
        body ? JSON.parse(body) : undefined
      ])).toEqual([
        ['/v1/model-connections', 'GET', undefined],
        ['/v1/model-connections/select', 'POST', {
          expectedRevision: 7,
          providerId: 'custom-provider-2',
          accountId: 'account:custom-provider-2',
          model: 'custom-model'
        }],
        ['/v1/model-connections/select', 'POST', {
          expectedRevision: 8,
          providerId: 'custom-provider-2',
          accountId: 'account:refreshed',
          model: 'custom-model'
        }]
      ])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('does not select a provider that is tombstoned or absent from the latest registry', async () => {
    const runtimeRequest = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, body: JSON.stringify(snapshot(11)) })
      .mockResolvedValueOnce({ ok: true, status: 200, body: JSON.stringify(snapshot(12, [])) })
    vi.stubGlobal('window', { kunGui: { runtimeRequest } })

    try {
      await expect(selectSharedModelConnection(
        'custom-provider-2',
        'custom-model',
        () => true
      )).rejects.toThrow(/pending deletion/)
      await expect(selectSharedModelConnection('custom-provider-2', 'custom-model'))
        .rejects.toThrow(/no longer available/)
      expect(runtimeRequest.mock.calls.every(([, method]) => method === 'GET')).toBe(true)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('pending shared model connection deletions', () => {
  const connection = {
    id: 'custom-provider-2',
    accountId: 'account:custom-provider-2',
    name: 'Custom Provider',
    kind: 'http' as const,
    authType: 'api-key' as const,
    endpointFormat: 'chat_completions' as const,
    configured: true,
    models: ['custom-model']
  }
  const snapshot = (revision: number, providers = [connection]) => ({
    schemaVersion: 1 as const,
    revision,
    providers
  })

  it('keeps tombstones through the deletion revision and releases newer snapshots', () => {
    const pending = new Map([[connection.id, { generation: 1, committedRevision: 5 }]])

    expect(reconcilePendingSharedProviderDeletions(snapshot(4), pending).has(connection.id)).toBe(true)
    expect(reconcilePendingSharedProviderDeletions(snapshot(5), pending).has(connection.id)).toBe(true)
    expect(reconcilePendingSharedProviderDeletions(snapshot(6), pending).has(connection.id)).toBe(false)
    expect(pending.get(connection.id)?.committedRevision).toBe(5)
  })

  it('keeps an uncommitted tombstone even when a stale snapshot omits the provider', () => {
    const pending = new Map([[connection.id, { generation: 1, committedRevision: null }]])

    expect(reconcilePendingSharedProviderDeletions(snapshot(20), pending).has(connection.id)).toBe(true)
    expect(reconcilePendingSharedProviderDeletions(snapshot(20, []), pending).has(connection.id)).toBe(true)
  })

  it('does not release a committed tombstone until local settings observe the deletion', () => {
    const pending = new Map([[connection.id, { generation: 1, committedRevision: 5 }]])

    expect(reconcilePendingSharedProviderDeletions(
      snapshot(6, []),
      pending,
      new Set([connection.id])
    ).has(connection.id)).toBe(true)
    expect(reconcilePendingSharedProviderDeletions(
      snapshot(6, []),
      pending,
      new Set()
    ).has(connection.id)).toBe(false)
  })
})

describe('pending shared model connection names', () => {
  const connection = (name: string) => ({
    id: 'custom-provider-2',
    accountId: 'account:custom-provider-2',
    name,
    kind: 'http' as const,
    authType: 'api-key' as const,
    endpointFormat: 'chat_completions' as const,
    configured: true,
    models: ['custom-model']
  })
  const snapshot = (revision: number, name: string) => ({
    schemaVersion: 1 as const,
    revision,
    providers: [connection(name)]
  })
  const pending = (committedRevision: number | null) => new Map([[
    'custom-provider-2',
    {
      localName: 'Renamed Provider',
      canonicalName: 'Renamed Provider',
      committedRevision
    }
  ]])

  it('keeps the local name while old registry revisions race the PATCH', () => {
    expect(reconcilePendingSharedProviderNames(snapshot(4, 'Custom Provider'), pending(null))
      .has('custom-provider-2')).toBe(true)
    expect(reconcilePendingSharedProviderNames(snapshot(4, 'Custom Provider'), pending(5))
      .has('custom-provider-2')).toBe(true)
  })

  it('releases an uncommitted local name once the canonical registry already matches it', () => {
    expect(reconcilePendingSharedProviderNames(snapshot(4, 'Renamed Provider'), pending(null))
      .has('custom-provider-2')).toBe(false)
  })

  it('releases the local name after observing the PATCH or a newer external rename', () => {
    expect(reconcilePendingSharedProviderNames(snapshot(5, 'Renamed Provider'), pending(5))
      .has('custom-provider-2')).toBe(false)
    expect(reconcilePendingSharedProviderNames(snapshot(6, 'External Rename'), pending(5))
      .has('custom-provider-2')).toBe(false)
  })

  it('projects the local name over a stale registry snapshot', () => {
    const current = defaultModelProviderSettings()
    current.providers.push({
      ...current.providers[0]!,
      id: 'custom-provider-2',
      name: 'Renamed Provider'
    })

    const projected = projectSharedModelConnections(
      current,
      snapshot(4, 'Custom Provider'),
      new Map(),
      pending(null)
    )

    expect(projected.provider.providers.find((item) => item.id === 'custom-provider-2')?.name)
      .toBe('Renamed Provider')
  })
})

describe('pending shared model connection catalogs', () => {
  const connection = (revisionModels = ['old-model']) => ({
    id: 'custom-provider-2',
    accountId: 'account:custom-provider-2',
    name: 'Custom Provider',
    kind: 'http' as const,
    authType: 'api-key' as const,
    baseUrl: 'https://api.example.com/v1',
    endpointFormat: 'chat_completions' as const,
    configured: true,
    models: revisionModels,
    modelCapabilities: Object.fromEntries(revisionModels.map((model) => [model, {
      id: model,
      ...textModelProfile
    }])),
    selectedModel: revisionModels[0]
  })
  const pending = {
    generation: 3,
    baseModels: ['old-model'],
    baseModelProfiles: { 'old-model': textModelProfile },
    localModels: ['old-model', 'new-model'],
    localModelProfiles: {
      'old-model': textModelProfile,
      'new-model': { ...textModelProfile, aliases: ['new-alias'] }
    },
    committedRevision: null
  }

  it('projects an optimistic catalog over stale registry events without sending GUI-only aliases', () => {
    const current = defaultModelProviderSettings()
    current.providers.push({
      ...current.providers[0]!,
      id: 'custom-provider-2',
      models: pending.localModels,
      modelProfiles: pending.localModelProfiles
    })
    const projected = projectSharedModelConnections(
      current,
      { schemaVersion: 1, revision: 4, providers: [connection()] },
      new Map(),
      new Map(),
      new Map([['custom-provider-2', pending]])
    )

    expect(projected.provider.providers.find((item) => item.id === 'custom-provider-2'))
      .toMatchObject({ models: ['old-model', 'new-model'] })
    const applied = applyPendingSharedProviderCatalog(connection(), pending)
    expect(applied.models).toEqual(['old-model', 'new-model'])
    expect(applied.modelCapabilities?.['new-model']).not.toHaveProperty('aliases')
  })

  it('keeps a committed overlay until the event stream reaches its revision', () => {
    const committed = new Map([['custom-provider-2', { ...pending, committedRevision: 5 }]])
    const stale = { schemaVersion: 1 as const, revision: 4, providers: [connection()] }
    const observed = {
      schemaVersion: 1 as const,
      revision: 5,
      providers: [connection(['old-model', 'new-model'])]
    }

    expect(reconcilePendingSharedProviderCatalogs(stale, committed).has('custom-provider-2')).toBe(true)
    expect(reconcilePendingSharedProviderCatalogs(observed, committed).has('custom-provider-2')).toBe(false)
  })

  it('replays a local delta on the latest revision and preserves a concurrent model addition', async () => {
    const remote = connection(['old-model', 'remote-model'])
    const snapshot = (revision: number) => ({
      schemaVersion: 1 as const,
      revision,
      providers: [remote]
    })
    const runtimeRequest = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, body: JSON.stringify(snapshot(7)) })
      .mockResolvedValueOnce({
        ok: false,
        status: 409,
        body: JSON.stringify({ snapshot: snapshot(8) })
      })
      .mockResolvedValueOnce({ ok: true, status: 200, body: JSON.stringify(snapshot(9)) })
    vi.stubGlobal('window', { kunGui: { runtimeRequest } })

    try {
      await expect(commitSharedModelConnectionCatalog('custom-provider-2', pending))
        .resolves.toMatchObject({ revision: 9 })
      const writes = runtimeRequest.mock.calls.slice(1).map(([, , body]) => JSON.parse(body))
      expect(writes.map((body) => body.expectedRevision)).toEqual([7, 8])
      expect(writes[1]).toMatchObject({
        models: ['old-model', 'remote-model', 'new-model']
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('rebases a newer undo generation on an older in-flight commit', () => {
    const addGeneration = {
      ...pending,
      baseModels: ['old-model'],
      localModels: ['old-model', 'new-model']
    }
    const afterAdd = connection(['old-model', 'new-model'])
    const undoGeneration = {
      ...pending,
      generation: 4,
      baseModels: ['old-model'],
      localModels: ['old-model'],
      localModelProfiles: { 'old-model': textModelProfile }
    }

    expect(applyPendingSharedProviderCatalog(connection(), addGeneration).models)
      .toEqual(['old-model', 'new-model'])
    const rebasedUndo = rebasePendingSharedProviderCatalog(addGeneration, undoGeneration, afterAdd)
    expect(applyPendingSharedProviderCatalog(afterAdd, rebasedUndo).models)
      .toEqual(['old-model'])
  })

  it('rebases only the newer user delta and preserves unseen remote catalog changes', () => {
    const completed = {
      ...pending,
      baseModels: ['old-model'],
      localModels: ['old-model', 'model-a']
    }
    const newer = {
      ...pending,
      generation: 5,
      baseModels: ['old-model'],
      localModels: ['old-model', 'model-a', 'model-b'],
      localModelProfiles: {
        'old-model': textModelProfile,
        'model-a': textModelProfile,
        'model-b': textModelProfile
      }
    }
    const committedWithRemote = connection(['old-model', 'remote-model', 'model-a'])

    const rebased = rebasePendingSharedProviderCatalog(completed, newer, committedWithRemote)

    expect(rebased.localModels).toEqual(['old-model', 'remote-model', 'model-a', 'model-b'])
    expect(applyPendingSharedProviderCatalog(committedWithRemote, rebased).models)
      .toEqual(['old-model', 'remote-model', 'model-a', 'model-b'])
  })
})

describe('shared model connection credential replacement', () => {
  it('uses the latest revision for a replacement and retries one conflict', async () => {
    const provider = {
      id: 'deepseek',
      accountId: 'account:deepseek',
      name: 'DeepSeek',
      kind: 'http' as const,
      authType: 'api-key' as const,
      baseUrl: 'https://api.deepseek.com',
      endpointFormat: 'chat_completions' as const,
      configured: true,
      credentialStatus: 'unreadable' as const,
      credentialErrorCode: 'credential_unreadable' as const,
      models: ['deepseek-chat']
    }
    const snapshot = (revision: number, ready = false) => ({
      schemaVersion: 1 as const,
      revision,
      providers: [{
        ...provider,
        ...(ready
          ? { credentialStatus: 'ready' as const, credentialErrorCode: undefined }
          : {})
      }]
    })
    const runtimeRequest = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, body: JSON.stringify(snapshot(20)) })
      .mockResolvedValueOnce({
        ok: false,
        status: 409,
        body: JSON.stringify({ snapshot: snapshot(21) })
      })
      .mockResolvedValueOnce({ ok: true, status: 200, body: JSON.stringify(snapshot(22, true)) })
    vi.stubGlobal('window', { kunGui: { runtimeRequest } })

    try {
      const replaced = await replaceSharedModelConnectionCredential('deepseek', 'latest-secret')
      expect(replaced.providers[0]).toMatchObject({
        credentialStatus: 'ready'
      })
      expect(replaced.providers[0]).not.toHaveProperty('credentialErrorCode')
      expect(runtimeRequest.mock.calls.map(([path, method, body]) => [
        path,
        method,
        body ? JSON.parse(body) : undefined
      ])).toEqual([
        ['/v1/model-connections', 'GET', undefined],
        ['/v1/model-connections/deepseek/credential', 'PUT', {
          expectedRevision: 20,
          credential: 'latest-secret'
        }],
        ['/v1/model-connections/deepseek/credential', 'PUT', {
          expectedRevision: 21,
          credential: 'latest-secret'
        }]
      ])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('rejects a delayed stale commit after a newer generation installs its fence', async () => {
    const provider = {
      id: 'deepseek',
      accountId: 'account:deepseek',
      name: 'DeepSeek',
      kind: 'http' as const,
      authType: 'api-key' as const,
      baseUrl: 'https://api.deepseek.com',
      endpointFormat: 'chat_completions' as const,
      configured: true,
      models: ['deepseek-chat']
    }
    let revision = 10
    let latestFence = ''
    const prepared = new Map<string, string>()
    const consumedCredentials: string[] = []
    let firstCommitStarted!: () => void
    const firstCommitInFlight = new Promise<void>((resolve) => { firstCommitStarted = resolve })
    let releaseFirstCommit!: () => void
    const firstCommitRelease = new Promise<void>((resolve) => { releaseFirstCommit = resolve })
    let delayedCommit = true
    const snapshot = () => ({ schemaVersion: 1 as const, revision, providers: [provider] })
    const runtimeRequest = vi.fn(async (path: string, method: string, body?: string) => {
      const payload = body ? JSON.parse(body) as Record<string, unknown> : {}
      if (path === '/v1/model-connections' && method === 'GET') {
        return { ok: true, status: 200, body: JSON.stringify(snapshot()) }
      }
      if (path === '/v1/model-connections/deepseek/credential/fence' && method === 'POST') {
        latestFence = String(payload.operationToken)
        return { ok: true, status: 200, body: JSON.stringify(snapshot()) }
      }
      if (path === '/v1/model-connections/deepseek/credential' && method === 'PUT') {
        prepared.set(String(payload.operationToken), String(payload.credential))
        return { ok: true, status: 200, body: JSON.stringify(snapshot()) }
      }
      if (path === '/v1/model-connections/deepseek/credential/commit' && method === 'POST') {
        const operationToken = String(payload.operationToken)
        if (delayedCommit) {
          delayedCommit = false
          firstCommitStarted()
          await firstCommitRelease
        }
        if (operationToken !== latestFence) {
          return {
            ok: false,
            status: 409,
            body: JSON.stringify({ snapshot: snapshot() })
          }
        }
        consumedCredentials.push(prepared.get(operationToken) ?? '')
        revision += 1
        return { ok: true, status: 200, body: JSON.stringify(snapshot()) }
      }
      throw new Error(`Unexpected runtime request: ${method} ${path}`)
    })
    vi.stubGlobal('window', { kunGui: { runtimeRequest } })

    try {
      const first = stageSharedProviderCredentialMutation(
        'deepseek',
        'first-secret',
        (operationToken) => fenceSharedModelConnectionCredential('deepseek', operationToken)
      )
      const firstDrain = drainSharedProviderCredentialMutation(
        'deepseek',
        first.generation,
        (credential, operationToken, isCurrent) => replaceSharedModelConnectionCredential(
          'deepseek',
          credential,
          () => false,
          { operationToken, isCurrent }
        )
      )
      await firstCommitInFlight

      const second = stageSharedProviderCredentialMutation(
        'deepseek',
        'final-secret',
        (operationToken) => fenceSharedModelConnectionCredential('deepseek', operationToken)
      )
      const firstToken = first.operationToken.split(':')
      const secondToken = second.operationToken.split(':')
      expect(firstToken).toHaveLength(3)
      expect(firstToken[0]).toBe('credential')
      expect(secondToken[1]).toBe(firstToken[1])
      expect(Number(secondToken[2])).toBe(Number(firstToken[2]) + 1)
      await second.fence
      const secondDrain = drainSharedProviderCredentialMutation(
        'deepseek',
        second.generation,
        (credential, operationToken, isCurrent) => replaceSharedModelConnectionCredential(
          'deepseek',
          credential,
          () => false,
          { operationToken, isCurrent }
        )
      )
      releaseFirstCommit()

      await expect(firstDrain).resolves.toMatchObject({ committed: false })
      await expect(secondDrain).resolves.toMatchObject({ committed: true })
      expect(consumedCredentials).toEqual(['final-secret'])
      expect(sharedProviderMutationCoordinator.pendingCredentials.has('deepseek')).toBe(false)
    } finally {
      resetSharedProviderMutationCoordinatorForTests()
      vi.unstubAllGlobals()
    }
  })
})

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

  it('clears the GUI default when the last shared connection is removed', () => {
    const projected = projectSharedModelConnections(defaultModelProviderSettings(), {
      schemaVersion: 1,
      revision: 5,
      providers: [],
      proxy: { enabled: false, url: '' },
      routePools: [],
      localModelGateway: { enabled: false }
    })

    expect(projected.kun).toEqual({ providerId: '', model: '' })
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
    expect(projected.kun).toEqual({ providerId: '', model: '' })
  })
})

describe('provider mutation lifecycle across settings remounts', () => {
  type RuntimeResult = { ok: boolean; status: number; body: string }

  const deferred = <T,>(): {
    promise: Promise<T>
    resolve: (value: T) => void
    reject: (error: unknown) => void
  } => {
    let resolve!: (value: T) => void
    let reject!: (error: unknown) => void
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise
      reject = rejectPromise
    })
    return { promise, resolve, reject }
  }

  const translate = (key: string, params?: Record<string, unknown>): string => {
    let value = key
    for (const [name, replacement] of Object.entries(params ?? {})) {
      value = value.replaceAll(`{{${name}}}`, String(replacement))
    }
    return value
  }

  const providerFixture = (id = 'custom-provider-2'): {
    settings: ReturnType<typeof defaultModelProviderSettings>
    provider: ModelProviderProfileV1
  } => {
    const settings = defaultModelProviderSettings()
    const provider = {
      ...settings.providers[0]!,
      id,
      name: 'Remount Provider',
      apiKey: '',
      baseUrl: 'https://api.example.com/v1',
      models: ['old-model'],
      modelProfiles: { 'old-model': textModelProfile }
    }
    return { settings, provider }
  }

  const connectionFor = (provider: ModelProviderProfileV1, models = provider.models) => ({
    id: provider.id,
    accountId: `account:${provider.id}`,
    name: provider.name,
    kind: 'http' as const,
    authType: 'api-key' as const,
    baseUrl: provider.baseUrl,
    endpointFormat: provider.endpointFormat,
    configured: true,
    models,
    modelCapabilities: Object.fromEntries(models.map((model) => [model, {
      id: model,
      ...(provider.modelProfiles[model] ?? textModelProfile)
    }])),
    selectedModel: models[0]
  })

  const snapshotFor = (
    provider: ModelProviderProfileV1,
    revision: number,
    models = provider.models,
    includeProvider = true
  ) => ({
    schemaVersion: 1 as const,
    revision,
    providers: includeProvider ? [connectionFor(provider, models)] : [],
    ...(includeProvider
      ? {
          defaultProviderId: provider.id,
          defaultAccountId: `account:${provider.id}`,
          defaultModel: models[0]
        }
      : {}),
    proxy: { enabled: false, url: '' },
    routePools: [],
    localModelGateway: { enabled: false }
  })

  const contextFor = (
    settings: ReturnType<typeof defaultModelProviderSettings>,
    provider: ModelProviderProfileV1,
    update = vi.fn()
  ): Record<string, unknown> => ({
    t: translate,
    form: {
      locale: 'en',
      write: { inlineCompletion: { inheritProvider: true, providerId: '' } }
    },
    provider: {
      ...settings,
      providers: [...settings.providers.filter((item) => item.id !== provider.id), provider]
    },
    kun: {
      ...defaultKunRuntimeSettings(),
      providerId: provider.id,
      model: provider.models[0]
    },
    update,
    showApiKey: false,
    setShowApiKey: vi.fn(),
    selectControlClass: 'select',
    saveStatus: 'saving',
    saveError: '',
    retrySave: vi.fn()
  })

  const instanceText = (instance: ReactTestInstance): string => instance.children
    .map((child) => typeof child === 'string' ? child : instanceText(child))
    .join('')

  const rendererText = (renderer: ReactTestRenderer): string => JSON.stringify(renderer.toJSON())

  const findButton = (renderer: ReactTestRenderer, label: string): ReactTestInstance => {
    const button = renderer.root.findAllByType('button')
      .find((candidate) => instanceText(candidate).trim() === label)
    expect(button, `button "${label}"`).toBeTruthy()
    return button!
  }

  const clickTab = async (renderer: ReactTestRenderer, label: string): Promise<void> => {
    const tab = renderer.root.findAllByProps({ role: 'tab' })
      .find((candidate) => instanceText(candidate) === label)
    expect(tab, `tab "${label}"`).toBeTruthy()
    await act(async () => tab!.props.onClick())
  }

  const flush = async (): Promise<void> => {
    await act(async () => {
      await Promise.resolve()
      await new Promise((resolve) => setTimeout(resolve, 0))
      await Promise.resolve()
    })
  }

  let mountedRenderers: ReactTestRenderer[] = []

  const mount = async (ctx: Record<string, unknown>): Promise<ReactTestRenderer> => {
    let renderer!: ReactTestRenderer
    await act(async () => {
      renderer = createRenderer(createElement(ProvidersSettingsSection, { ctx }))
    })
    mountedRenderers.push(renderer)
    return renderer
  }

  const unmount = async (renderer: ReactTestRenderer): Promise<void> => {
    await act(async () => renderer.unmount())
    mountedRenderers = mountedRenderers.filter((item) => item !== renderer)
  }

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    mountedRenderers = []
    vi.stubGlobal('window', {
      kunGui: {
        runtimeRequest: vi.fn(),
        confirmDialog: vi.fn(async () => true)
      },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    })
    vi.stubGlobal('document', {
      body: { style: { overflow: '' } },
      activeElement: null
    })
  })

  afterEach(async () => {
    await act(async () => {
      for (const renderer of mountedRenderers) renderer.unmount()
    })
    resetSharedProviderMutationCoordinatorForTests()
    vi.unstubAllGlobals()
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false
  })

  it('shows the delete action for the default API provider', async () => {
    const { settings, provider } = providerFixture('deepseek')
    const runtimeRequest = vi.fn(async (path: string) => {
      if (path.includes('/events?')) return new Promise<never>(() => undefined)
      return { ok: true, status: 200, body: JSON.stringify(snapshotFor(provider, 1)) }
    })
    Object.assign(window.kunGui, { runtimeRequest })

    const renderer = await mount(contextFor(settings, provider))
    await flush()
    await clickTab(renderer, 'modelProviderTabAdvanced')

    expect(findButton(renderer, 'modelProviderRemove')).toBeTruthy()
  })

  it('shows safe replacement guidance for an unreadable protected credential', async () => {
    const { settings, provider } = providerFixture()
    const snapshot = {
      ...snapshotFor(provider, 3),
      providers: [{
        ...connectionFor(provider),
        credentialStatus: 'unreadable' as const,
        credentialErrorCode: 'credential_unreadable' as const
      }]
    }
    const runtimeRequest = vi.fn(async (path: string) => {
      if (path.includes('/events?')) return new Promise<never>(() => undefined)
      return { ok: true, status: 200, body: JSON.stringify(snapshot) }
    })
    Object.assign(window.kunGui, { runtimeRequest })

    const renderer = await mount(contextFor(settings, provider))
    await flush()

    expect(rendererText(renderer)).toContain(
      'The existing credential cannot be read. Enter a new value to replace it safely.'
    )
    expect(rendererText(renderer)).not.toContain('settings:provider:')
    expect(rendererText(renderer)).not.toContain('credential_unreadable')
  })

  it('keeps a credential generation through unmount and clears it after the adopted commit', async () => {
    const { settings, provider } = providerFixture()
    let registryRevision = 1
    const credentialPut = deferred<RuntimeResult>()
    const credentialStarted = deferred<void>()
    const fenceBodies: Array<{ operationToken: string }> = []
    const credentialBodies: Array<{
      expectedRevision: number
      credential: string
      operationToken: string
    }> = []
    const commitBodies: Array<{ expectedRevision: number; operationToken: string }> = []
    const runtimeRequest = vi.fn(async (path: string, method: string, body?: string) => {
      if (path.includes('/events?')) return new Promise<never>(() => undefined)
      if (path === '/v1/model-connections' && method === 'GET') {
        return {
          ok: true,
          status: 200,
          body: JSON.stringify(snapshotFor(provider, registryRevision))
        }
      }
      if (path === `/v1/model-connections/${provider.id}/credential/fence` && method === 'POST') {
        fenceBodies.push(JSON.parse(body ?? '{}'))
        return {
          ok: true,
          status: 200,
          body: JSON.stringify(snapshotFor(provider, registryRevision))
        }
      }
      if (path === `/v1/model-connections/${provider.id}/credential` && method === 'PUT') {
        credentialBodies.push(JSON.parse(body ?? '{}'))
        credentialStarted.resolve()
        return credentialPut.promise
      }
      if (path === `/v1/model-connections/${provider.id}/credential/commit` && method === 'POST') {
        commitBodies.push(JSON.parse(body ?? '{}'))
        registryRevision = 2
        return {
          ok: true,
          status: 200,
          body: JSON.stringify(snapshotFor(provider, registryRevision))
        }
      }
      throw new Error(`Unexpected runtime request: ${method} ${path}`)
    })
    Object.assign(window.kunGui, { runtimeRequest })
    const ctx = contextFor(settings, provider)
    const first = await mount(ctx)
    await flush()

    const credentialInput = first.root.findAllByType('input')
      .find((input) => input.props.type === 'password')
    expect(credentialInput).toBeTruthy()
    expect(credentialInput?.props.placeholder).toBe('••••••••••••')
    await act(async () => credentialInput!.props.onChange({ target: { value: 'latest-secret' } }))
    expect(sharedProviderMutationCoordinator.pendingCredentials.get(provider.id)).toMatchObject({
      credential: 'latest-secret'
    })

    await unmount(first)
    await credentialStarted.promise
    const second = await mount(ctx)
    await flush()
    const remountedInput = second.root.findAllByType('input')
      .find((input) => input.props.type === 'password')
    expect(remountedInput?.props.value).toBe('latest-secret')

    credentialPut.resolve({
      ok: true,
      status: 200,
      body: JSON.stringify(snapshotFor(provider, 1))
    })
    await flush()
    await enqueueSharedModelMutation(async () => undefined)
    await flush()

    expect(fenceBodies).toHaveLength(1)
    expect(credentialBodies).toEqual([{
      expectedRevision: 1,
      credential: 'latest-secret',
      operationToken: fenceBodies[0]!.operationToken
    }])
    expect(commitBodies).toEqual([{
      expectedRevision: 1,
      operationToken: fenceBodies[0]!.operationToken
    }])
    expect(sharedProviderMutationCoordinator.pendingCredentials.has(provider.id)).toBe(false)
    expect(second.root.findAllByType('input')
      .find((input) => input.props.type === 'password')?.props.value)
      .toBe('')
  })

  it('keeps a catalog overlay through unmount without submitting its generation twice', async () => {
    const { settings, provider } = providerFixture()
    let registryRevision = 1
    let registryModels = [...provider.models]
    const firstPatch = deferred<RuntimeResult>()
    const patchStarted = deferred<void>()
    const patchBodies: Array<{ expectedRevision: number; models: string[] }> = []
    const runtimeRequest = vi.fn(async (path: string, method: string, body?: string) => {
      if (path.includes('/events?')) return new Promise<never>(() => undefined)
      if (path === '/v1/model-connections' && method === 'GET') {
        return {
          ok: true,
          status: 200,
          body: JSON.stringify(snapshotFor(provider, registryRevision, registryModels))
        }
      }
      if (path === `/v1/model-connections/${provider.id}` && method === 'PATCH') {
        const request = JSON.parse(body ?? '{}') as { expectedRevision: number; models: string[] }
        patchBodies.push(request)
        if (patchBodies.length === 1) {
          patchStarted.resolve()
          return firstPatch.promise
        }
        registryRevision += 1
        registryModels = [...request.models]
        return {
          ok: true,
          status: 200,
          body: JSON.stringify(snapshotFor(provider, registryRevision, registryModels))
        }
      }
      throw new Error(`Unexpected runtime request: ${method} ${path}`)
    })
    Object.assign(window.kunGui, { runtimeRequest })
    const ctx = contextFor(settings, provider)
    const first = await mount(ctx)
    await flush()
    const nextProvider = {
      ...provider,
      models: ['old-model', 'new-model'],
      modelProfiles: {
        ...provider.modelProfiles,
        'new-model': textModelProfile
      }
    }
    await act(async () => first.root.findByType(ProviderModelsManager).props.onChange(nextProvider))

    await unmount(first)
    await patchStarted.promise
    const second = await mount(ctx)
    await flush()
    expect(second.root.findByType(ProviderModelsManager).props.provider.models)
      .toEqual(['old-model', 'new-model'])

    registryRevision = 2
    registryModels = [...nextProvider.models]
    firstPatch.resolve({
      ok: true,
      status: 200,
      body: JSON.stringify(snapshotFor(provider, registryRevision, registryModels))
    })
    await flush()
    await enqueueSharedModelMutation(async () => undefined)
    await flush()

    expect(patchBodies).toHaveLength(1)
    expect(patchBodies[0]).toMatchObject({
      expectedRevision: 1,
      models: ['old-model', 'new-model']
    })
  })

  it('keeps the provider visible while DELETE is in flight and after DELETE fails', async () => {
    const { settings, provider } = providerFixture()
    const deleteRequest = deferred<RuntimeResult>()
    const deleteStarted = deferred<void>()
    const runtimeRequest = vi.fn(async (path: string, method: string) => {
      if (path.includes('/events?')) return new Promise<never>(() => undefined)
      if (path === '/v1/model-connections' && method === 'GET') {
        return { ok: true, status: 200, body: JSON.stringify(snapshotFor(provider, 1)) }
      }
      if (path.startsWith(`/v1/model-connections/${provider.id}?`) && method === 'DELETE') {
        deleteStarted.resolve()
        return deleteRequest.promise
      }
      throw new Error(`Unexpected runtime request: ${method} ${path}`)
    })
    Object.assign(window.kunGui, { runtimeRequest })
    const update = vi.fn()
    const renderer = await mount(contextFor(settings, provider, update))
    await flush()
    update.mockClear()
    await clickTab(renderer, 'modelProviderTabAdvanced')
    await act(async () => findButton(renderer, 'modelProviderRemove').props.onClick())
    await deleteStarted.promise

    expect(rendererText(renderer)).toContain(provider.name)
    expect(update).not.toHaveBeenCalled()
    expect(sharedProviderMutationCoordinator.pendingDeletions.get(provider.id)).toMatchObject({
      committedRevision: null
    })

    deleteRequest.resolve({
      ok: false,
      status: 503,
      body: JSON.stringify({ message: 'delete failed safely' })
    })
    await enqueueSharedModelMutation(async () => undefined)
    await flush()

    expect(sharedProviderMutationCoordinator.pendingDeletions.has(provider.id)).toBe(false)
    expect(rendererText(renderer)).toContain(provider.name)
    expect(rendererText(renderer)).toContain('delete failed safely')
    expect(update).not.toHaveBeenCalled()
  })

  it('does not let an old DELETE generation hide an explicitly re-added provider after remount', async () => {
    const { settings, provider } = providerFixture()
    let registryIncludesProvider = true
    let registryRevision = 1
    const deleteRequest = deferred<RuntimeResult>()
    const deleteStarted = deferred<void>()
    const runtimeRequest = vi.fn(async (path: string, method: string) => {
      if (path.includes('/events?')) return new Promise<never>(() => undefined)
      if (path === '/v1/model-connections' && method === 'GET') {
        return {
          ok: true,
          status: 200,
          body: JSON.stringify(snapshotFor(
            provider,
            registryRevision,
            provider.models,
            registryIncludesProvider
          ))
        }
      }
      if (path.startsWith(`/v1/model-connections/${provider.id}?`) && method === 'DELETE') {
        deleteStarted.resolve()
        return deleteRequest.promise
      }
      throw new Error(`Unexpected runtime request: ${method} ${path}`)
    })
    Object.assign(window.kunGui, { runtimeRequest })
    const update = vi.fn()
    const ctx = contextFor(settings, provider, update)
    const first = await mount(ctx)
    await flush()
    update.mockClear()
    await clickTab(first, 'modelProviderTabAdvanced')
    await act(async () => findButton(first, 'modelProviderRemove').props.onClick())
    await deleteStarted.promise

    clearPendingSharedProviderDeletionForExplicitAdd(
      sharedProviderMutationCoordinator.pendingDeletions,
      provider.id
    )
    await unmount(first)
    const readded = await mount(ctx)
    await flush()
    update.mockClear()

    registryIncludesProvider = false
    registryRevision = 2
    deleteRequest.resolve({
      ok: true,
      status: 200,
      body: JSON.stringify(snapshotFor(provider, registryRevision, provider.models, false))
    })
    await enqueueSharedModelMutation(async () => undefined)
    await flush()

    expect(sharedProviderMutationCoordinator.pendingDeletions.has(provider.id)).toBe(false)
    expect(rendererText(readded)).toContain(provider.name)
    expect(update).not.toHaveBeenCalled()
  })
})
