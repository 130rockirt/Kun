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

  it('resolves an approval through the HTTP endpoint', async () => {
    const h = buildHarness()
    const approval = createApprovalRequest({
      id: 'appr_1',
      threadId: 'thr_1',
      turnId: 'turn_1',
      toolName: 'echo',
      summary: 'run echo'
    })
    const pending = h.approvalGate.request(approval)
    const consent = (decision: 'allow' | 'deny') => createApprovalConsentToken({
      runtimeToken: 'tok-1',
      approvalId: 'appr_1',
      decision,
      expiresAt: Date.now() + 30_000
    })
    const missingConsent = await dispatchRequest(
      h.router,
      new Request('http://localhost/v1/approvals/appr_1', {
        method: 'POST',
        headers: { authorization: 'Bearer tok-1', 'content-type': 'application/json' },
        body: JSON.stringify({ decision: 'allow' })
      })
    )
    expect(missingConsent.status).toBe(403)
    const decide = await dispatchRequest(
      h.router,
      new Request('http://localhost/v1/approvals/appr_1', {
        method: 'POST',
        headers: {
          authorization: 'Bearer tok-1',
          'content-type': 'application/json',
          [KUN_APPROVAL_CONSENT_HEADER]: consent('allow')
        },
        body: JSON.stringify({ decision: 'allow' })
      })
    )
    expect(decide.status).toBe(200)
    const body = (await readJson(decide)) as { decision: string }
    expect(body.decision).toBe('allow')
    await expect(pending).resolves.toBe('allow')

    const replay = await dispatchRequest(
      h.router,
      new Request('http://localhost/v1/approvals/appr_1', {
        method: 'POST',
        headers: {
          authorization: 'Bearer tok-1',
          'content-type': 'application/json',
          [KUN_APPROVAL_CONSENT_HEADER]: consent('allow')
        },
        body: JSON.stringify({ decision: 'allow' })
      })
    )
    expect(replay.status).toBe(200)
    expect(await readJson(replay)).toMatchObject({
      decision: 'allow',
      alreadyResolved: true
    })

    const conflict = await dispatchRequest(
      h.router,
      new Request('http://localhost/v1/approvals/appr_1', {
        method: 'POST',
        headers: {
          authorization: 'Bearer tok-1',
          'content-type': 'application/json',
          [KUN_APPROVAL_CONSENT_HEADER]: consent('deny')
        },
        body: JSON.stringify({ decision: 'deny' })
      })
    )
    expect(conflict.status).toBe(409)
  })

  it('persists approval audit data before releasing an allowed tool waiter', async () => {
    const h = buildHarness()
    const approval = createApprovalRequest({
      id: 'appr_audited',
      threadId: 'thr_1',
      turnId: 'turn_1',
      toolName: 'echo',
      summary: 'run echo'
    })
    const pending = h.approvalGate.request(approval)
    const originalAppend = h.sessionStore.appendEvent.bind(h.sessionStore)
    let releaseAudit!: () => void
    const auditBlocked = new Promise<void>((resolve) => { releaseAudit = resolve })
    let auditStarted = false
    vi.spyOn(h.sessionStore, 'appendEvent').mockImplementation(async (threadId, event) => {
      if (event.kind === 'approval_resolved') {
        auditStarted = true
        await auditBlocked
      }
      await originalAppend(threadId, event)
    })

    let waiterReleased = false
    void pending.then(() => { waiterReleased = true })
    const request = dispatchRequest(
      h.router,
      new Request('http://localhost/v1/approvals/appr_audited', {
        method: 'POST',
        headers: {
          authorization: 'Bearer tok-1',
          'content-type': 'application/json',
          [KUN_APPROVAL_CONSENT_HEADER]: approvalConsent('appr_audited', 'allow')
        },
        body: JSON.stringify({ decision: 'allow' })
      })
    )
    await vi.waitFor(() => expect(auditStarted).toBe(true))
    expect(waiterReleased).toBe(false)
    expect(h.approvalGate.get('appr_audited')?.status).toBe('pending')

    releaseAudit()
    expect((await request).status).toBe(200)
    await expect(pending).resolves.toBe('allow')
  })

  it('rolls back a reserved decision when audit persistence fails', async () => {
    const h = buildHarness()
    const pending = h.approvalGate.request(createApprovalRequest({
      id: 'appr_audit_failure',
      threadId: 'thr_1',
      turnId: 'turn_1',
      toolName: 'echo',
      summary: 'run echo'
    }))
    vi.spyOn(h.sessionStore, 'appendEvent').mockImplementation(async (_threadId, event) => {
      if (event.kind === 'approval_resolved') throw new Error('audit write failed')
    })

    await expect(dispatchRequest(
      h.router,
      new Request('http://localhost/v1/approvals/appr_audit_failure', {
        method: 'POST',
        headers: {
          authorization: 'Bearer tok-1',
          'content-type': 'application/json',
          [KUN_APPROVAL_CONSENT_HEADER]: approvalConsent('appr_audit_failure', 'allow')
        },
        body: JSON.stringify({ decision: 'allow' })
      })
    )).rejects.toThrow('audit write failed')
    expect(h.approvalGate.get('appr_audit_failure')?.status).toBe('pending')
    expect(h.approvalGate.decide('appr_audit_failure', 'deny')).toBe(true)
    await expect(pending).resolves.toBe('deny')
  })

  it('coalesces concurrent identical approval decisions into one audit event', async () => {
    const h = buildHarness()
    void h.approvalGate.request(createApprovalRequest({
      id: 'appr_same_decision',
      threadId: 'thr_1',
      turnId: 'turn_1',
      toolName: 'echo',
      summary: 'run echo'
    }))
    const originalAppend = h.sessionStore.appendEvent.bind(h.sessionStore)
    let releaseAudit!: () => void
    const auditBlocked = new Promise<void>((resolve) => { releaseAudit = resolve })
    let auditStarted = false
    vi.spyOn(h.sessionStore, 'appendEvent').mockImplementation(async (threadId, event) => {
      if (event.kind === 'approval_resolved') {
        auditStarted = true
        await auditBlocked
      }
      await originalAppend(threadId, event)
    })
    const makeRequest = () => dispatchRequest(
      h.router,
      new Request('http://localhost/v1/approvals/appr_same_decision', {
        method: 'POST',
        headers: {
          authorization: 'Bearer tok-1',
          'content-type': 'application/json',
          [KUN_APPROVAL_CONSENT_HEADER]: approvalConsent('appr_same_decision', 'allow')
        },
        body: JSON.stringify({ decision: 'allow' })
      })
    )

    const first = makeRequest()
    await vi.waitFor(() => expect(auditStarted).toBe(true))
    const second = makeRequest()
    releaseAudit()
    const responses = await Promise.all([first, second])
    expect(responses.map((response) => response.status)).toEqual([200, 200])
    const events = await h.sessionStore.loadEventsSince('thr_1', 0)
    expect(events.filter((event) => event.kind === 'approval_resolved')).toHaveLength(1)
  })

  it('returns conflict for the losing concurrent opposite decision', async () => {
    const h = buildHarness()
    void h.approvalGate.request(createApprovalRequest({
      id: 'appr_opposite_decision',
      threadId: 'thr_1',
      turnId: 'turn_1',
      toolName: 'echo',
      summary: 'run echo'
    }))
    const originalAppend = h.sessionStore.appendEvent.bind(h.sessionStore)
    let releaseAudit!: () => void
    const auditBlocked = new Promise<void>((resolve) => { releaseAudit = resolve })
    let auditStarted = false
    vi.spyOn(h.sessionStore, 'appendEvent').mockImplementation(async (threadId, event) => {
      if (event.kind === 'approval_resolved') {
        auditStarted = true
        await auditBlocked
      }
      await originalAppend(threadId, event)
    })
    const request = (decision: 'allow' | 'deny') => dispatchRequest(
      h.router,
      new Request('http://localhost/v1/approvals/appr_opposite_decision', {
        method: 'POST',
        headers: {
          authorization: 'Bearer tok-1',
          'content-type': 'application/json',
          [KUN_APPROVAL_CONSENT_HEADER]: approvalConsent('appr_opposite_decision', decision)
        },
        body: JSON.stringify({ decision })
      })
    )

    const allow = request('allow')
    await vi.waitFor(() => expect(auditStarted).toBe(true))
    const deny = request('deny')
    releaseAudit()
    const [allowResponse, denyResponse] = await Promise.all([allow, deny])
    expect(allowResponse.status).toBe(200)
    expect(denyResponse.status).toBe(409)
    expect(h.approvalGate.get('appr_opposite_decision')?.status).toBe('allowed')
  })

  it('rejects oversized approval reasons without resolving the request', async () => {
    const h = buildHarness()
    void h.approvalGate.request(createApprovalRequest({
      id: 'appr_reason_limit',
      threadId: 'thr_1',
      turnId: 'turn_1',
      toolName: 'echo',
      summary: 'run echo'
    }))

    const response = await dispatchRequest(
      h.router,
      new Request('http://localhost/v1/approvals/appr_reason_limit', {
        method: 'POST',
        headers: { authorization: 'Bearer tok-1', 'content-type': 'application/json' },
        body: JSON.stringify({ decision: 'deny', reason: 'x'.repeat(4097) })
      })
    )

    expect(response.status).toBe(400)
    expect(h.approvalGate.get('appr_reason_limit')?.status).toBe('pending')
  })

  it('resolves GUI user input through both HTTP compatibility endpoints', async () => {
    const h = buildHarness()
    const pending = h.userInputGate.request({
      id: 'in_1',
      threadId: 'thr_1',
      turnId: 'turn_1',
      itemId: 'item_in_1',
      prompt: 'Pick one',
      questions: []
    })
    const submit = await dispatchRequest(
      h.router,
      new Request('http://localhost/v1/user-inputs/in_1', {
        method: 'POST',
        headers: { authorization: 'Bearer tok-1', 'content-type': 'application/json' },
        body: JSON.stringify({
          answers: [{ id: 'choice', label: 'Yes', value: 'yes' }]
        })
      })
    )
    expect(submit.status).toBe(200)
    await expect(pending).resolves.toEqual({
      status: 'submitted',
      answers: [{ id: 'choice', label: 'Yes', value: 'yes' }]
    })

    const cancelPending = h.userInputGate.request({
      id: 'in_2',
      threadId: 'thr_1',
      turnId: 'turn_1',
      itemId: 'item_in_2',
      prompt: 'Cancel?',
      questions: []
    })
    const cancel = await dispatchRequest(
      h.router,
      new Request('http://localhost/v1/user-input/in_2', {
        method: 'POST',
        headers: { authorization: 'Bearer tok-1', 'content-type': 'application/json' },
        body: JSON.stringify({ cancelled: true })
      })
    )
    expect(cancel.status).toBe(200)
    await expect(cancelPending).resolves.toEqual({ status: 'cancelled' })
    const events = await h.sessionStore.loadEventsSince('thr_1', 0)
    expect(events.filter((event) => event.kind === 'user_input_resolved')).toHaveLength(2)
  })

  it('serializes concurrent resolutions for the same GUI user input', async () => {
    const h = buildHarness()
    const pending = h.userInputGate.request({
      id: 'in_race', threadId: 'thr_1', turnId: 'turn_1', itemId: 'item_in_race', prompt: 'Pick one', questions: []
    })
    const request = () => dispatchRequest(h.router, new Request('http://localhost/v1/user-inputs/in_race', {
      method: 'POST',
      headers: { authorization: 'Bearer tok-1', 'content-type': 'application/json' },
      body: JSON.stringify({ answers: [{ id: 'choice', label: 'Yes', value: 'yes' }] })
    }))

    const [first, second] = await Promise.all([request(), request()])
    expect([first.status, second.status].sort()).toEqual([200, 404])
    await expect(pending).resolves.toEqual({
      status: 'submitted', answers: [{ id: 'choice', label: 'Yes', value: 'yes' }]
    })
    const events = await h.sessionStore.loadEventsSince('thr_1', 0)
    expect(events.filter((event) => event.kind === 'user_input_resolved')).toHaveLength(1)
  })

  it('rejects answers that do not match pending user input questions', async () => {
    const h = buildHarness()
    const pending = h.userInputGate.request({
      id: 'in_validate', threadId: 'thr_1', turnId: 'turn_1', itemId: 'item_in_validate', prompt: 'Pick',
      questions: [{ header: 'Pick', id: 'choice', question: 'Choose', options: [{ label: 'Yes', description: '' }], selectionMode: 'single' }]
    })
    const invalid = await dispatchRequest(h.router, new Request('http://localhost/v1/user-inputs/in_validate', {
      method: 'POST', headers: { authorization: 'Bearer tok-1', 'content-type': 'application/json' },
      body: JSON.stringify({ answers: [{ id: 'choice', label: 'No', value: 'no' }] })
    }))
    expect(invalid.status).toBe(400)
    expect(h.userInputGate.get('in_validate')).toBeDefined()
    h.userInputGate.resolve('in_validate', { status: 'cancelled' })
    await expect(pending).resolves.toEqual({ status: 'cancelled' })
  })
})
