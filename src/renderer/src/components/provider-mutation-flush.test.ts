import { describe, expect, it } from 'vitest'
import { flushAllPendingProviderMutations } from './provider-mutation-flush'
import { sharedProviderMutationCoordinator } from './shared-provider-mutation-coordinator'

describe('provider mutation quit barrier', () => {
  it('flushes every latest generation without returning secrets', async () => {
    sharedProviderMutationCoordinator.pendingNames.set('provider-a', {
      generation: 2,
      localName: 'Provider A',
      canonicalName: 'Provider A',
      committedRevision: null
    })
    sharedProviderMutationCoordinator.pendingCredentials.set('provider-a', {
      generation: 4,
      operationToken: 'credential:opaque:4',
      credential: 'secret-must-not-cross-ipc'
    })
    const calls: string[] = []
    const result = await flushAllPendingProviderMutations(
      { requestId: 'request-1', deadlineMs: 1000 },
      {
        drainProfile: async (id) => { calls.push(`profile:${id}`); sharedProviderMutationCoordinator.pendingNames.get(id)!.committedRevision = 3 },
        drainCatalog: async () => undefined,
        drainCredential: async (id) => { calls.push(`credential:${id}`); sharedProviderMutationCoordinator.pendingCredentials.delete(id) },
        drainDeletion: async () => undefined
      }
    )
    expect(calls).toEqual(['profile:provider-a', 'credential:provider-a'])
    expect(result).toMatchObject({ requestId: 'request-1', ok: true, pendingProviderIds: [] })
    expect(JSON.stringify(result)).not.toContain('secret-must-not-cross-ipc')
    sharedProviderMutationCoordinator.pendingNames.clear()
    sharedProviderMutationCoordinator.pendingCredentials.clear()
  })

  it('keeps failed generations pending and reports a bounded failure', async () => {
    sharedProviderMutationCoordinator.pendingCredentials.set('provider-b', {
      generation: 1,
      operationToken: 'credential:opaque:1',
      credential: 'do-not-return'
    })
    const result = await flushAllPendingProviderMutations(
      { requestId: 'request-2', deadlineMs: 1000 },
      {
        drainProfile: async () => undefined,
        drainCatalog: async () => undefined,
        drainCredential: async () => { throw new Error('network failure') },
        drainDeletion: async () => undefined
      }
    )
    expect(result).toMatchObject({ ok: false, errorCode: 'flush-failed', pendingProviderIds: ['provider-b'] })
    expect(JSON.stringify(result)).not.toContain('do-not-return')
    sharedProviderMutationCoordinator.pendingCredentials.clear()
  })
})
