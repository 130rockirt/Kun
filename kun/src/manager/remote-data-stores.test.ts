import { afterEach, describe, expect, it, vi } from 'vitest'
import { createThreadRecord, toThreadSummary } from '../domain/thread.js'
import type { ServiceManagerConnection } from './manager-client.js'
import {
  ManagerRemoteSessionStore,
  ManagerRemoteThreadStore,
  resolveManagerDataRequestTimeoutMs
} from './remote-data-stores.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

function managerConnection(): ServiceManagerConnection {
  return {
    discovery: {
      version: 1,
      protocolVersion: 3,
      instanceId: 'manager-read-compatibility',
      pid: process.pid,
      startedAt: '2026-08-14T00:00:00.000Z',
      host: '127.0.0.1',
      port: 18700,
      baseUrl: 'http://127.0.0.1:18700',
      managerToken: 'manager-secret',
      serviceVersion: '0.1.0',
      dataDir: '/tmp/kun-data',
      settingsPath: '/tmp/kun-settings.json'
    }
  }
}

function legacyHalfBoundThread() {
  return createThreadRecord({
    id: 'thr_legacy_half_bound',
    title: 'Legacy plan build',
    workspace: '/tmp/legacy-plan-build',
    model: 'test-model',
    planBuildRunId: 'run-legacy-1'
  })
}

function stubManagerResult(result: unknown): void {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(
    JSON.stringify({ result }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  )))
}

describe('resolveManagerDataRequestTimeoutMs', () => {
  it('allows cold timeline scans to outlive ordinary manager data requests', () => {
    expect(resolveManagerDataRequestTimeoutMs('session', 'highestSeq')).toBe(120_000)
    expect(resolveManagerDataRequestTimeoutMs('session', 'loadItemPage')).toBe(120_000)
    expect(resolveManagerDataRequestTimeoutMs('session', 'loadItems')).toBe(30_000)
    expect(resolveManagerDataRequestTimeoutMs('thread', 'get')).toBe(30_000)
  })
})

describe('ManagerRemoteSessionStore live items', () => {
  it('forwards checkpoint and finalization operations without changing their payloads', async () => {
    const requests: Array<{ url: string; body: unknown }> = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), body: JSON.parse(String(init?.body)) })
      return new Response(JSON.stringify({ result: null }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }))
    const store = new ManagerRemoteSessionStore(managerConnection())
    const item = {
      id: 'assistant_remote_live',
      turnId: 'turn_remote_live',
      threadId: 'thread_remote_live',
      role: 'assistant' as const,
      status: 'running' as const,
      createdAt: '2026-08-29T00:00:00.000Z',
      kind: 'assistant_text' as const,
      text: 'live'
    }

    await store.checkpointLiveItem(item.threadId, item, 9)
    await store.finalizeLiveItem(item.threadId, { ...item, status: 'completed' })

    expect(requests.map((request) => request.url)).toEqual([
      expect.stringContaining('/v1/data/session/checkpointLiveItem'),
      expect.stringContaining('/v1/data/session/finalizeLiveItem')
    ])
    expect(requests.map((request) => request.body)).toEqual([
      { threadId: item.threadId, item, representedSeq: 9 },
      { threadId: item.threadId, item: { ...item, status: 'completed' } }
    ])
  })

  it('iterates bounded manager event pages without materializing the backlog', async () => {
    const requestBodies: unknown[] = []
    const pages = [
      { events: [event(1), event(2)], nextCursor: 'v1:1:2:200', hasMore: true, eventBytes: 200 },
      { events: [event(3)], hasMore: false, eventBytes: 100 }
    ]
    vi.stubGlobal('fetch', vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body)))
      return new Response(JSON.stringify({ result: pages.shift() }), {
        status: 200, headers: { 'content-type': 'application/json' }
      })
    }))
    const store = new ManagerRemoteSessionStore(managerConnection())
    const seen: number[] = []
    for await (const runtimeEvent of store.iterateEventsSince('thread_remote_pages', 0)) {
      seen.push(runtimeEvent.seq)
    }

    expect(seen).toEqual([1, 2, 3])
    expect(requestBodies).toMatchObject([
      { threadId: 'thread_remote_pages', options: { sinceSeq: 0 } },
      { threadId: 'thread_remote_pages', options: { sinceSeq: 2, cursor: 'v1:1:2:200' } }
    ])
  })
})

function event(seq: number) {
  return {
    kind: 'heartbeat' as const,
    seq,
    timestamp: `2026-08-29T00:00:0${seq}.000Z`,
    threadId: 'thread_remote_pages'
  }
}

describe('ManagerRemoteThreadStore legacy read compatibility', () => {
  it('forwards workspace keyset pages through the dedicated manager operation', async () => {
    const thread = createThreadRecord({
      id: 'thr_page_remote',
      title: 'Remote page',
      workspace: '/tmp/remote-page',
      model: 'test-model'
    })
    let requestUrl = ''
    let requestBody = ''
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requestUrl = String(input)
      requestBody = String(init?.body ?? '')
      return new Response(JSON.stringify({
        result: {
          threads: [toThreadSummary(thread)],
          hasMore: false,
          total: 1
        }
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }))
    const store = new ManagerRemoteThreadStore(managerConnection())

    await expect(store.listPage({
      workspace: thread.workspace,
      limit: 25,
      cursor: 'opaque-cursor',
      includeArchived: true,
      includeSide: true
    })).resolves.toMatchObject({
      threads: [{ id: thread.id }],
      hasMore: false,
      total: 1
    })
    expect(requestUrl).toContain('/v1/data/thread/listPage')
    expect(JSON.parse(requestBody)).toEqual({
      workspace: thread.workspace,
      limit: 25,
      cursor: 'opaque-cursor',
      includeArchived: true,
      includeSide: true
    })
  })

  it('preserves a half-bound plan-build thread on full and metadata reads', async () => {
    const thread = legacyHalfBoundThread()
    stubManagerResult(thread)
    const store = new ManagerRemoteThreadStore(managerConnection())

    await expect(store.get(thread.id)).resolves.toMatchObject({
      id: thread.id,
      planBuildRunId: 'run-legacy-1'
    })
    await expect(store.getMetadata(thread.id)).resolves.toMatchObject({
      id: thread.id,
      planBuildRunId: 'run-legacy-1'
    })
  })

  it('allows legacy plan-build metadata to round-trip on ordinary upserts', async () => {
    const thread = legacyHalfBoundThread()
    stubManagerResult(thread)
    const store = new ManagerRemoteThreadStore(managerConnection())

    await expect(store.upsert(thread)).resolves.toMatchObject({
      id: thread.id,
      planBuildRunId: 'run-legacy-1'
    })
  })
})
