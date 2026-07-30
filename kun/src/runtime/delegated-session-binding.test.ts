import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import type { TurnItem } from '../contracts/items.js'
import {
  DelegatedSessionCoordinator,
  FileDelegatedSessionBindingStore,
  delegatedCapabilityFingerprint,
  delegatedCredentialIdentity,
  delegatedHistoryDigest,
  type DelegatedSessionRoute
} from './delegated-session-binding.js'

function user(turnId: string, text: string): Extract<TurnItem, { kind: 'user_message' }> {
  return {
    id: `item_${turnId}`,
    threadId: 'thread_1',
    turnId,
    role: 'user',
    kind: 'user_message',
    status: 'completed',
    createdAt: '2026-01-01T00:00:00.000Z',
    text
  }
}

function route(overrides: Partial<DelegatedSessionRoute> = {}): DelegatedSessionRoute {
  return {
    providerKind: 'cursor-sdk',
    providerId: 'cursor-subscription',
    credentialIdentity: delegatedCredentialIdentity({
      providerId: 'cursor-subscription',
      accountId: 'account-1'
    }),
    workspace: '/tmp/work',
    model: 'auto',
    capabilityFingerprint: delegatedCapabilityFingerprint({
      policy: 'auto',
      tools: []
    }),
    continuationMode: 'native',
    ...overrides
  }
}

describe('DelegatedSessionCoordinator', () => {
  test('persists a secret-free binding and resumes it after restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-delegated-'))
    const store = new FileDelegatedSessionBindingStore(root)
    const first = new DelegatedSessionCoordinator(store, () => '2026-01-01T00:00:00.000Z')
    const prior = [user('turn_1', 'hello')]
    const prepared = await first.prepare({ threadId: 'thread_1', route: route(), priorItems: [] })
    await first.commit({
      preparation: prepared,
      committedItems: prior,
      lastCommittedTurnId: 'turn_1',
      nativeSessionId: 'agent_1'
    })

    const restarted = new DelegatedSessionCoordinator(
      new FileDelegatedSessionBindingStore(root)
    )
    const next = await restarted.prepare({
      threadId: 'thread_1',
      route: route(),
      priorItems: prior
    })
    expect(next).toMatchObject({
      generation: 1,
      resumed: true,
      nativeSessionId: 'agent_1'
    })
    const serialized = JSON.stringify(await store.load('thread_1'))
    expect(serialized).not.toContain('hello')
    expect(serialized).not.toContain('apiKey')
    expect(serialized).not.toContain('account-1')
  })

  test('rebases on route, capability, or canonical-history mismatch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-delegated-'))
    const coordinator = new DelegatedSessionCoordinator(
      new FileDelegatedSessionBindingStore(root)
    )
    const prepared = await coordinator.prepare({
      threadId: 'thread_1',
      route: route(),
      priorItems: []
    })
    await coordinator.commit({
      preparation: prepared,
      committedItems: [user('turn_1', 'first')],
      lastCommittedTurnId: 'turn_1',
      nativeSessionId: 'agent_1'
    })

    await expect(coordinator.prepare({
      threadId: 'thread_1',
      route: route({
        credentialIdentity: delegatedCredentialIdentity({
          providerId: 'cursor-subscription',
          accountId: 'account-2'
        })
      }),
      priorItems: [user('turn_1', 'first')]
    })).resolves.toMatchObject({ resumed: false, rebaseReason: 'route_changed' })
    await expect(coordinator.prepare({
      threadId: 'thread_1',
      route: route({ capabilityFingerprint: delegatedCapabilityFingerprint('changed') }),
      priorItems: [user('turn_1', 'first')]
    })).resolves.toMatchObject({ resumed: false, rebaseReason: 'capabilities_changed' })
    await expect(coordinator.prepare({
      threadId: 'thread_1',
      route: route(),
      priorItems: [user('turn_1', 'changed')]
    })).resolves.toMatchObject({ resumed: false, rebaseReason: 'history_changed' })
  })

  test('does not advance a binding until commit and serializes one thread', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-delegated-'))
    const coordinator = new DelegatedSessionCoordinator(
      new FileDelegatedSessionBindingStore(root)
    )
    const order: string[] = []
    let release!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const first = coordinator.runExclusive('thread_1', async () => {
      order.push('first-start')
      await blocked
      order.push('first-end')
    })
    const second = coordinator.runExclusive('thread_1', async () => {
      order.push('second')
    })
    await vi.waitFor(() => expect(order).toEqual(['first-start']))
    release()
    await Promise.all([first, second])
    expect(order).toEqual(['first-start', 'first-end', 'second'])
    expect(await coordinator.store.load('thread_1')).toBeNull()
  })

  test('clears stale provider checkpoints when rebasing or rejecting resume', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-delegated-'))
    const store = new FileDelegatedSessionBindingStore(root)
    const coordinator = new DelegatedSessionCoordinator(store)
    const prepared = await coordinator.prepare({
      threadId: 'thread_1',
      route: route(),
      priorItems: []
    })
    await coordinator.commit({
      preparation: prepared,
      committedItems: [user('turn_1', 'first')],
      lastCommittedTurnId: 'turn_1',
      nativeSessionId: 'agent_1'
    })
    const stateDir = store.providerStateDir('cursor-sdk', 'thread_1')
    await mkdir(stateDir, { recursive: true })
    const checkpoint = join(stateDir, 'checkpoint')
    await writeFile(checkpoint, 'stale')

    const resumed = await coordinator.prepare({
      threadId: 'thread_1',
      route: route(),
      priorItems: [user('turn_1', 'first')]
    })
    expect(resumed.resumed).toBe(true)
    const rejected = await coordinator.rejectResume(resumed)
    expect(rejected).toMatchObject({
      generation: 2,
      resumed: false,
      rebaseReason: 'native_state_unavailable'
    })
    await expect(access(checkpoint)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('clears both old and new provider state after a provider switch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-delegated-'))
    const store = new FileDelegatedSessionBindingStore(root)
    const coordinator = new DelegatedSessionCoordinator(store)
    const prepared = await coordinator.prepare({
      threadId: 'thread_1',
      route: route({ providerKind: 'agent-sdk' }),
      priorItems: []
    })
    await coordinator.commit({
      preparation: prepared,
      committedItems: [user('turn_1', 'first')],
      lastCommittedTurnId: 'turn_1',
      nativeSessionId: 'session_1'
    })
    const oldCheckpoint = join(
      store.providerStateDir('agent-sdk', 'thread_1'),
      'checkpoint'
    )
    const newCheckpoint = join(
      store.providerStateDir('cursor-sdk', 'thread_1'),
      'checkpoint'
    )
    await mkdir(join(oldCheckpoint, '..'), { recursive: true })
    await mkdir(join(newCheckpoint, '..'), { recursive: true })
    await writeFile(oldCheckpoint, 'old')
    await writeFile(newCheckpoint, 'new')

    await coordinator.prepare({
      threadId: 'thread_1',
      route: route({ providerKind: 'cursor-sdk' }),
      priorItems: [user('turn_1', 'first')]
    })

    await expect(access(oldCheckpoint)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(access(newCheckpoint)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('removes malformed records and writes complete atomic JSON', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-delegated-'))
    const store = new FileDelegatedSessionBindingStore(root)
    const coordinator = new DelegatedSessionCoordinator(store)
    const prepared = await coordinator.prepare({
      threadId: 'thread_1',
      route: route(),
      priorItems: []
    })
    const saved = await coordinator.commit({
      preparation: prepared,
      committedItems: [user('turn_1', 'one')],
      lastCommittedTurnId: 'turn_1',
      nativeSessionId: 'agent_1'
    })
    const bindingDir = join(root, 'bindings')
    const files = (await import('node:fs/promises')).readdir(bindingDir)
    const [name] = await files
    expect(name).toMatch(/\.json$/)
    expect(JSON.parse(await readFile(join(bindingDir, name!), 'utf8'))).toEqual(saved)
    await writeFile(join(bindingDir, name!), '{broken', 'utf8')
    await expect(store.load('thread_1')).resolves.toBeNull()
  })

  test('history digest ignores timestamps but changes after compaction or content changes', () => {
    const original = user('turn_1', 'same')
    expect(delegatedHistoryDigest([original])).toBe(delegatedHistoryDigest([
      { ...original, createdAt: '2027-01-01T00:00:00.000Z' }
    ]))
    expect(delegatedHistoryDigest([original])).not.toBe(delegatedHistoryDigest([
      { ...original, text: 'different' }
    ]))
    const compacted: TurnItem = {
      id: 'compact_1',
      threadId: 'thread_1',
      turnId: 'turn_2',
      role: 'system',
      status: 'completed',
      createdAt: '2026-01-01T00:01:00.000Z',
      kind: 'compaction',
      summary: 'new portable baseline',
      replacedTokens: 100,
      pinnedConstraints: []
    }
    expect(delegatedHistoryDigest([original])).not.toBe(
      delegatedHistoryDigest([original, compacted])
    )
  })

  test('credential identity rotates on secret changes without persisting the secret', () => {
    const first = delegatedCredentialIdentity({
      providerId: 'cursor-subscription',
      credentialSecret: 'cursor-secret-one'
    })
    const second = delegatedCredentialIdentity({
      providerId: 'cursor-subscription',
      credentialSecret: 'cursor-secret-two'
    })
    expect(first).not.toBe(second)
    expect(first).not.toContain('cursor-secret-one')
    expect(first).toMatch(/^scrypt-v1:[a-f0-9]{64}$/u)
  })

  test('keeps an aligned portable generation without claiming native resume failed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-delegated-'))
    const coordinator = new DelegatedSessionCoordinator(
      new FileDelegatedSessionBindingStore(root)
    )
    const portableRoute = route({
      providerKind: 'antigravity-cli',
      continuationMode: 'portable'
    })
    const prepared = await coordinator.prepare({
      threadId: 'thread_1',
      route: portableRoute,
      priorItems: []
    })
    const committedItems = [user('turn_1', 'portable')]
    await coordinator.commit({
      preparation: prepared,
      committedItems,
      lastCommittedTurnId: 'turn_1'
    })
    await expect(coordinator.prepare({
      threadId: 'thread_1',
      route: portableRoute,
      priorItems: committedItems
    })).resolves.toMatchObject({
      generation: 1,
      resumed: false
    })
    expect((await coordinator.prepare({
      threadId: 'thread_1',
      route: portableRoute,
      priorItems: committedItems
    })).rebaseReason).toBeUndefined()
  })

  test('keeps fork ids unbound and deletes one thread binding plus provider state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-delegated-'))
    const store = new FileDelegatedSessionBindingStore(root)
    const coordinator = new DelegatedSessionCoordinator(store)
    const prepared = await coordinator.prepare({
      threadId: 'thread_source',
      route: route(),
      priorItems: []
    })
    await coordinator.commit({
      preparation: prepared,
      committedItems: [],
      lastCommittedTurnId: 'turn_1',
      nativeSessionId: 'agent_1'
    })
    const stateDir = store.providerStateDir('cursor-sdk', 'thread_source')
    await mkdir(stateDir, { recursive: true })
    await writeFile(join(stateDir, 'checkpoint'), 'opaque')

    expect(await store.load('thread_fork')).toBeNull()
    await coordinator.invalidate('thread_source')
    expect(await store.load('thread_source')).toBeNull()
    await expect(access(stateDir)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
