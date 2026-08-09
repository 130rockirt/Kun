import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { dispatchRequest } from '../../src/server/http-server.js'
import { createApprovalRequest } from '../../src/domain/approval.js'
import { makeAssistantTextItem, makeToolCallItem, makeToolResultItem } from '../../src/domain/item.js'
import { encodeSseEvent } from '../../src/server/sse.js'
import { buildHarness, readJson, readSseEvents, usageSnapshot } from '../http-server-test-harness.js'
import type { TurnItem } from '../../src/contracts/items.js'
import {
  createApprovalConsentToken,
  KUN_APPROVAL_CONSENT_HEADER
} from '../../src/server/approval-consent.js'

describe('HTTP server', () => {
  let dataDir = ''
  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'kun-http-'))
  })
  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true })
  })

  const approvalConsent = (approvalId: string, decision: 'allow' | 'deny') =>
    createApprovalConsentToken({
      runtimeToken: 'tok-1',
      approvalId,
      decision,
      expiresAt: Date.now() + 30_000
    })

  it('forks a thread with copied history and lineage metadata', async () => {
    const h = buildHarness()
    await h.threadService.create(
      { workspace: '/tmp/project', model: 'deepseek-chat', mode: 'agent' },
      { id: 'thr_parent', title: 'Parent' }
    )
    await h.turnService.startTurn({
      threadId: 'thr_parent',
      request: { prompt: 'hello' }
    })

    const response = await dispatchRequest(
      h.router,
      new Request('http://localhost/v1/threads/thr_parent/fork', {
        method: 'POST',
        headers: { authorization: 'Bearer tok-1' }
      })
    )

    expect(response.status).toBe(201)
    const fork = (await readJson(response)) as {
      id: string
      forkedFromThreadId?: string
      forkedFromTitle?: string
      forkedFromMessageCount?: number
      forkedFromTurnCount?: number
      turns: Array<{ threadId: string; items: Array<{ threadId: string; kind: string }> }>
    }
    expect(fork.forkedFromThreadId).toBe('thr_parent')
    expect(fork.forkedFromTitle).toBe('Parent')
    expect(fork.forkedFromMessageCount).toBe(1)
    expect(fork.forkedFromTurnCount).toBe(1)
    expect(fork.turns[0]?.threadId).toBe(fork.id)
    expect(fork.turns[0]?.items[0]).toMatchObject({ threadId: fork.id, kind: 'user_message' })
    const copiedItems = await h.sessionStore.loadItems(fork.id)
    expect(copiedItems).toHaveLength(1)
    expect(copiedItems[0]).toMatchObject({ threadId: fork.id, kind: 'user_message' })
  })

  it('forks with relation: side, attaches parentThreadId, and is excluded from the default list', async () => {
    const h = buildHarness()
    await h.threadService.create(
      { workspace: '/tmp/project', model: 'deepseek-chat', mode: 'agent' },
      { id: 'thr_parent', title: 'Parent' }
    )
    await h.turnService.startTurn({
      threadId: 'thr_parent',
      request: { prompt: 'seed turn' }
    })

    const forkResponse = await dispatchRequest(
      h.router,
      new Request('http://localhost/v1/threads/thr_parent/fork', {
        method: 'POST',
        headers: { authorization: 'Bearer tok-1', 'content-type': 'application/json' },
        body: JSON.stringify({ relation: 'side' })
      })
    )
    expect(forkResponse.status).toBe(201)
    const fork = (await readJson(forkResponse)) as {
      id: string
      relation?: string
      parentThreadId?: string
      title: string
    }
    expect(fork.relation).toBe('side')
    expect(fork.parentThreadId).toBe('thr_parent')
    expect(fork.title).toBe('Parent · side')

    // Default list hides side threads.
    const listResponse = await dispatchRequest(
      h.router,
      new Request('http://localhost/v1/threads', {
        headers: { authorization: 'Bearer tok-1' }
      })
    )
    const listBody = (await readJson(listResponse)) as {
      threads: Array<{ id: string; relation?: string }>
    }
    expect(listBody.threads.find((t) => t.id === fork.id)).toBeUndefined()
    expect(listBody.threads.find((t) => t.id === 'thr_parent')).toBeDefined()

    // Opt-in include=side surfaces them.
    const includeResponse = await dispatchRequest(
      h.router,
      new Request('http://localhost/v1/threads?include=side', {
        headers: { authorization: 'Bearer tok-1' }
      })
    )
    const includeBody = (await readJson(includeResponse)) as {
      threads: Array<{ id: string; relation?: string }>
    }
    expect(includeBody.threads.find((t) => t.id === fork.id)).toMatchObject({ relation: 'side' })
  })

  it('bodyless fork still defaults to relation: fork', async () => {
    const h = buildHarness()
    await h.threadService.create(
      { workspace: '/tmp/project', model: 'deepseek-chat', mode: 'agent' },
      { id: 'thr_default_fork', title: 'Forker' }
    )
    const response = await dispatchRequest(
      h.router,
      new Request('http://localhost/v1/threads/thr_default_fork/fork', {
        method: 'POST',
        headers: { authorization: 'Bearer tok-1' }
      })
    )
    expect(response.status).toBe(201)
    const body = (await readJson(response)) as { relation?: string; parentThreadId?: string }
    expect(body.relation).toBe('fork')
    expect(body.parentThreadId).toBe('thr_default_fork')
  })

  it('resumes a persisted session into a new Kun thread', async () => {
    const h = buildHarness()
    await h.threadService.create(
      { workspace: '/tmp/project', model: 'deepseek-chat', mode: 'agent' },
      { id: 'thr_source', title: 'Source Thread' }
    )
    await h.turnService.startTurn({
      threadId: 'thr_source',
      request: { prompt: 'restore this' }
    })

    const response = await dispatchRequest(
      h.router,
      new Request('http://localhost/v1/sessions/thr_source/resume-thread', {
        method: 'POST',
        headers: { authorization: 'Bearer tok-1', 'content-type': 'application/json' },
        body: JSON.stringify({ workspace: '/tmp/override', model: 'deepseek-coder', mode: 'plan' })
      })
    )

    expect(response.status).toBe(201)
    const body = (await readJson(response)) as {
      thread_id: string
      session_id: string
      message_count: number
      summary: string
    }
    expect(body.session_id).toBe('thr_source')
    expect(body.message_count).toBe(1)
    expect(body.summary).toBe('Source Thread resumed')
    const resumed = await h.threadService.get(body.thread_id)
    expect(resumed).toMatchObject({
      workspace: '/tmp/override',
      model: 'deepseek-coder',
      mode: 'plan',
      status: 'idle',
      forkedFromThreadId: 'thr_source'
    })
    expect(resumed?.turns[0]?.status).toBe('completed')
    expect(resumed?.turns[0]?.items[0]).toMatchObject({
      threadId: body.thread_id,
      kind: 'user_message',
      text: 'restore this'
    })
    const copiedItems = await h.sessionStore.loadItems(body.thread_id)
    expect(copiedItems).toHaveLength(1)
  })

  it('returns 404 when resuming an unknown session', async () => {
    const h = buildHarness()
    const response = await dispatchRequest(
      h.router,
      new Request('http://localhost/v1/sessions/missing/resume-thread', {
        method: 'POST',
        headers: { authorization: 'Bearer tok-1', 'content-type': 'application/json' },
        body: JSON.stringify({})
      })
    )

    expect(response.status).toBe(404)
  })

  it('returns cumulative usage from /v1/usage', async () => {
    const h = buildHarness()
    h.runtime.usageService.record('thr_1', {
      promptTokens: 5,
      completionTokens: 3,
      totalTokens: 8,
      cachedTokens: 2,
      cacheHitTokens: 2,
      cacheMissTokens: 3,
      cacheHitRate: 0.4,
      turns: 1
    })
    const response = await dispatchRequest(
      h.router,
      new Request('http://localhost/v1/usage', {
        headers: { authorization: 'Bearer tok-1' }
      })
    )
    expect(response.status).toBe(200)
    const body = (await readJson(response)) as { total: { promptTokens: number } }
    expect(body.total.promptTokens).toBe(5)
  })

  it('returns live thread-grouped usage buckets from /v1/usage?group_by=thread', async () => {
    const h = buildHarness()
    await h.threadService.create(
      { workspace: '/tmp/project', model: 'deepseek-chat', mode: 'agent' },
      { id: 'thr_live', title: 'Live usage' }
    )
    h.runtime.usageService.record('thr_live', usageSnapshot({ promptTokens: 12, completionTokens: 8 }))

    const response = await dispatchRequest(
      h.router,
      new Request('http://localhost/v1/usage?group_by=thread', {
        headers: { authorization: 'Bearer tok-1' }
      })
    )

    expect(response.status).toBe(200)
    const body = (await readJson(response)) as {
      group_by: string
      buckets: Array<{ thread_id: string; total_tokens: number; turns: number }>
    }
    expect(body.group_by).toBe('thread')
    expect(body.buckets).toEqual([
      expect.objectContaining({ thread_id: 'thr_live', total_tokens: 20, turns: 1 })
    ])
  })

  it('filters thread-grouped usage buckets by thread_id', async () => {
    const h = buildHarness()
    await h.threadService.create(
      { workspace: '/tmp/project', model: 'deepseek-chat', mode: 'agent' },
      { id: 'thr_live', title: 'Live usage' }
    )
    await h.threadService.create(
      { workspace: '/tmp/project', model: 'deepseek-chat', mode: 'agent' },
      { id: 'thr_other', title: 'Other usage' }
    )
    h.runtime.usageService.record('thr_live', usageSnapshot({ promptTokens: 12, completionTokens: 8 }))
    h.runtime.usageService.record('thr_other', usageSnapshot({ promptTokens: 90, completionTokens: 10 }))

    const response = await dispatchRequest(
      h.router,
      new Request('http://localhost/v1/usage?group_by=thread&thread_id=thr_live', {
        headers: { authorization: 'Bearer tok-1' }
      })
    )

    expect(response.status).toBe(200)
    const body = (await readJson(response)) as {
      group_by: string
      buckets: Array<{ thread_id: string; total_tokens: number; turns: number }>
    }
    expect(body.group_by).toBe('thread')
    expect(body.buckets).toEqual([
      expect.objectContaining({ thread_id: 'thr_live', total_tokens: 20, turns: 1 })
    ])
  })

  it('derives daily usage from persisted cumulative usage events', async () => {
    const h = buildHarness()
    await h.threadService.create(
      { workspace: '/tmp/project', model: 'deepseek-chat', mode: 'agent' },
      { id: 'thr_usage', title: 'Persisted usage' }
    )
    await h.sessionStore.appendEvent('thr_usage', {
      kind: 'usage',
      seq: 2,
      timestamp: '2026-06-02T09:00:00.000Z',
      threadId: 'thr_usage',
      usage: usageSnapshot({
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
        turns: 1,
        tokenEconomySavingsTokens: 100,
        tokenEconomySavingsUsd: 0.001
      })
    })
    await h.sessionStore.appendEvent('thr_usage', {
      kind: 'usage',
      seq: 3,
      timestamp: '2026-06-02T09:05:00.000Z',
      threadId: 'thr_usage',
      usage: usageSnapshot({
        promptTokens: 30,
        completionTokens: 10,
        totalTokens: 40,
        turns: 2,
        tokenEconomySavingsTokens: 250,
        tokenEconomySavingsUsd: 0.0025
      })
    })

    const response = await dispatchRequest(
      h.router,
      new Request('http://localhost/v1/usage?group_by=day&from=2026-06-02&to=2026-06-02&timezone=UTC', {
        headers: { authorization: 'Bearer tok-1' }
      })
    )

    expect(response.status).toBe(200)
    const body = (await readJson(response)) as {
      group_by: string
      buckets: Array<{ date: string; total_tokens: number; turns: number; thread_count: number }>
      totals: {
        total_tokens: number
        turns: number
        active_days: number
        token_economy_savings_tokens: number
        token_economy_savings_usd: number
      }
    }
    expect(body.group_by).toBe('day')
    expect(body.buckets[0]).toMatchObject({
      date: '2026-06-02',
      total_tokens: 40,
      turns: 2,
      thread_count: 1
    })
    expect(body.totals).toMatchObject({
      total_tokens: 40,
      turns: 2,
      active_days: 1,
      token_economy_savings_tokens: 250,
      token_economy_savings_usd: 0.0025
    })
  })

  it('encodes SSE events with sequence numbers and event names', () => {
    const frame = encodeSseEvent({
      kind: 'heartbeat',
      seq: 7,
      timestamp: 't',
      threadId: 'th'
    })
    expect(frame).toContain('id: 7')
    expect(frame).toContain('event: heartbeat')
    expect(frame.endsWith('\n\n')).toBe(true)
  })

  it('returns a 404 for unknown routes', async () => {
    const h = buildHarness()
    const response = await dispatchRequest(
      h.router,
      new Request('http://localhost/v1/unknown')
    )
    expect(response.status).toBe(404)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(await readJson(response)).toEqual({
      code: 'not_found',
      message: 'route not found'
    })
  })

  it('streams a workspace status response', async () => {
    const h = buildHarness()
    const response = await dispatchRequest(
      h.router,
      new Request('http://localhost/v1/workspace/status?path=/tmp', {
        headers: { authorization: 'Bearer tok-1' }
      })
    )
    expect(response.status).toBe(200)
    const body = (await readJson(response)) as { path: string }
    expect(body.path).toBe(resolve('/tmp'))
  })
})
