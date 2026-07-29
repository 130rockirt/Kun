import { describe, expect, it, vi } from 'vitest'
import type { GraphPlanningDraftV1 } from '../../contracts/graph.js'
import { TurnCapacityError } from '../../services/turn-service.js'
import type { ServerRuntime } from './server-runtime.js'
import { buildRouter } from './index.js'

function runtime(): ServerRuntime {
  let draft: GraphPlanningDraftV1 = {
    version: 1,
    id: 'draft_1',
    reservedRunId: 'run_reserved_1',
    threadId: 'thread_1',
    sourceTurnId: 'turn_1',
    projectId: 'project_1',
    goal: 'Implement the requested change.',
    revision: 2,
    status: 'needs_correction',
    issues: [{
      code: 'invalid_plan',
      path: ['tasks', 0, 'loop'],
      message: 'ordinary tasks cannot contain loop',
      repairHint: 'Remove loop from the ordinary task.'
    }],
    repairCount: 1,
    createdAt: '2026-07-26T00:00:00.000Z',
    updatedAt: '2026-07-26T00:01:00.000Z'
  }
  const identity = {
    version: 1,
    projectId: 'project_1',
    canonicalWorkspaceRoot: '/workspace',
    source: 'workspace_root',
    resolvedAt: '2026-07-26T00:00:00.000Z'
  }
  return {
    runtimeToken: 'graph-route-token',
    insecure: false,
    events: {
      record: vi.fn(async () => undefined)
    },
    turnService: {
      resumeGraphPlanningTurn: vi.fn(async () => 'resumed'),
      suspendGraphPlanningTurn: vi.fn(async () => {
        draft = {
          ...draft,
          revision: draft.revision + 1,
          status: 'needs_correction',
          updatedAt: '2026-07-26T00:03:00.000Z'
        }
        return 'suspended'
      }),
      interruptTurn: vi.fn(async () => undefined)
    },
    runTurn: vi.fn(),
    graph: {
      drafts: {
        list: vi.fn(async ({ threadId }: { threadId?: string } = {}) =>
          !threadId || threadId === draft.threadId ? [draft] : []),
        require: vi.fn(async (id: string) => {
          if (id !== draft.id) throw new Error(`missing ${id}`)
          return draft
        }),
        update: vi.fn(async (_id: string, input: {
          expectedRevision: number
          status: GraphPlanningDraftV1['status']
        }) => {
          draft = {
            ...draft,
            revision: draft.revision + 1,
            status: input.status,
            updatedAt: '2026-07-26T00:02:00.000Z'
          }
          return draft
        }),
        readCandidate: vi.fn(async () => ({
          tasks: [{
            key: 'work',
            kind: 'work',
            title: 'Implement'
          }]
        }))
      },
      control: {
        get: vi.fn(async (id: string) => ({
          id,
          lastEventSeq: 2,
          artifacts: [{
            version: 1,
            artifactId: 'art_abcdef',
            contentHash: '0'.repeat(64),
            mimeType: 'text/plain',
            byteLength: 10,
            summary: 'bounded artifact',
            visibility: 'run',
            retention: 'run',
            createdAt: '2026-07-26T00:00:00.000Z'
          }]
        })),
        list: vi.fn(async () => []),
        retryNode: vi.fn()
      },
      store: {
        list: vi.fn(async () => []),
        events: vi.fn(async () => [
          { eventId: 'event_2', graphSeq: 2 }
        ])
      },
      registry: {
        identify: vi.fn(async () => identity),
        listProjectIdentities: vi.fn(async () => []),
        getProfile: vi.fn(async (_projectId: string, profileId: string) => ({
          version: 1,
          profileId,
          profileVersion: 1
        })),
        recordProfileExport: vi.fn(async () => undefined),
        transitionProfile: vi.fn(async (
          _identity: unknown,
          profileId: string,
          lifecycle: string
        ) => ({ profileId, lifecycle })),
        route: vi.fn()
      },
      learning: {
        listJobs: vi.fn(async () => [])
      },
      artifacts: {
        stat: vi.fn(async (artifactId: string) => artifactId === 'art_abcdef'
          ? {
              id: artifactId,
              byteSize: 10,
              lineCount: 1,
              mimeType: 'text/plain',
              createdAt: '2026-07-26T00:00:00.000Z'
            }
          : null),
        readRange: vi.fn(async (artifactId: string) =>
          artifactId === 'art_abcdef' ? 'abc' : null)
      },
      writes: {
        list: vi.fn(async () => ({
          leases: [{
            leaseId: 'lease_1',
            state: 'active',
            workspaceRoot: '/private/secret-workspace'
          }],
          worktrees: [{
            worktreeId: 'worktree_1',
            state: 'preserved',
            path: '/private/secret-worktree'
          }]
        }))
      },
      scheduler: {
        diagnostics: vi.fn(() => ({ active: [], fairCursor: 0 }))
      },
      config: vi.fn(() => ({ enabled: true }))
    }
  } as unknown as ServerRuntime
}

describe('Graph HTTP routes', () => {
  it('requires runtime authentication before exposing durable graph state', async () => {
    const response = await dispatch(runtime(), 'GET', '/v1/graphs/run_1')
    expect(response.status).toBe(401)
    expect(response.body).not.toContain('run_1')
  })

  it('strictly validates list filters and mutation idempotency context', async () => {
    const testRuntime = runtime()
    const headers = { authorization: 'Bearer graph-route-token' }

    expect((await dispatch(
      testRuntime,
      'GET',
      '/v1/graphs?status=definitely_invalid',
      undefined,
      headers
    )).status).toBe(400)
    expect((await dispatch(
      testRuntime,
      'POST',
      '/v1/graphs/run_1/retry',
      { nodeId: 'node_1' },
      headers
    )).status).toBe(400)
    expect(testRuntime.graph!.control.retryNode).not.toHaveBeenCalled()
  })

  it('returns a bounded summary page instead of full GraphRun snapshots', async () => {
    const testRuntime = runtime()
    vi.mocked(testRuntime.graph!.control.list).mockResolvedValueOnce([{
      id: 'run_1',
      threadId: 'thread_1',
      projectId: 'project_1',
      sourceTurnId: 'turn_1',
      status: 'running',
      currentRevision: 2,
      lastEventSeq: 7,
      plans: [{ title: 'Bounded run', goal: 'Verify list projections' }],
      nodes: { node_1: {}, node_2: {} },
      createdAt: '2026-07-26T00:00:00.000Z',
      updatedAt: '2026-07-26T00:01:00.000Z'
    }] as never)

    const response = await dispatch(
      testRuntime,
      'GET',
      '/v1/graphs?thread_id=thread_1&limit=1',
      undefined,
      { authorization: 'Bearer graph-route-token' }
    )
    const body = JSON.parse(response.body)
    expect(body.runs).toEqual([expect.objectContaining({
      id: 'run_1',
      title: 'Bounded run',
      nodeCount: 2
    })])
    expect(body.runs[0]).not.toHaveProperty('plans')
    expect(body.runs[0]).not.toHaveProperty('nodes')
  })

  it('lists correction drafts and resumes the same source turn with revision safety', async () => {
    const testRuntime = runtime()
    const headers = { authorization: 'Bearer graph-route-token' }
    const listed = await dispatch(
      testRuntime,
      'GET',
      '/v1/graph-drafts?thread_id=thread_1',
      undefined,
      headers
    )
    expect(listed.status).toBe(200)
    expect(JSON.parse(listed.body)).toMatchObject({
      drafts: [{
        draft: {
          id: 'draft_1',
          revision: 2,
          status: 'needs_correction'
        },
        tasks: [{ key: 'work', kind: 'work', title: 'Implement' }]
      }]
    })

    const resumed = await dispatch(
      testRuntime,
      'POST',
      '/v1/graph-drafts/draft_1/resume',
      { expectedRevision: 2 },
      headers
    )
    expect(resumed.status).toBe(202)
    expect(JSON.parse(resumed.body)).toMatchObject({
      draft: { id: 'draft_1', revision: 3, status: 'planning' }
    })
    expect(testRuntime.turnService.resumeGraphPlanningTurn).toHaveBeenCalledWith({
      threadId: 'thread_1',
      turnId: 'turn_1'
    })
    expect(testRuntime.runTurn).toHaveBeenCalledWith('thread_1', 'turn_1')
    expect(testRuntime.events.record).toHaveBeenCalledTimes(1)
  })

  it('does not launch a duplicate loop when a concurrent resume already owns execution', async () => {
    const testRuntime = runtime()
    vi.mocked(testRuntime.turnService.resumeGraphPlanningTurn)
      .mockResolvedValueOnce('already_running')

    const response = await dispatch(
      testRuntime,
      'POST',
      '/v1/graph-drafts/draft_1/resume',
      { expectedRevision: 2 },
      { authorization: 'Bearer graph-route-token' }
    )

    expect(response.status).toBe(202)
    expect(JSON.parse(response.body)).toMatchObject({
      draft: {
        revision: 3,
        status: 'planning'
      }
    })
    expect(testRuntime.runTurn).not.toHaveBeenCalled()
  })

  it('restores a retryable correction revision when execution capacity rejects resume', async () => {
    const testRuntime = runtime()
    const headers = { authorization: 'Bearer graph-route-token' }
    vi.mocked(testRuntime.turnService.resumeGraphPlanningTurn)
      .mockImplementationOnce(async (input) => {
        await testRuntime.turnService.suspendGraphPlanningTurn({
          ...input,
          force: true
        })
        throw new TurnCapacityError(1)
      })

    const rejected = await dispatch(
      testRuntime,
      'POST',
      '/v1/graph-drafts/draft_1/resume',
      { expectedRevision: 2 },
      headers
    )
    expect(rejected.status).toBe(429)
    expect(JSON.parse(rejected.body)).toMatchObject({
      code: 'rate_limited',
      details: { maxConcurrentTurns: 1 }
    })
    expect(testRuntime.turnService.suspendGraphPlanningTurn).toHaveBeenCalledWith({
      threadId: 'thread_1',
      turnId: 'turn_1',
      force: true
    })
    expect(testRuntime.runTurn).not.toHaveBeenCalled()

    const restored = await dispatch(
      testRuntime,
      'GET',
      '/v1/graph-drafts/draft_1',
      undefined,
      headers
    )
    expect(JSON.parse(restored.body)).toMatchObject({
      draft: {
        revision: 4,
        status: 'needs_correction'
      }
    })

    const retried = await dispatch(
      testRuntime,
      'POST',
      '/v1/graph-drafts/draft_1/resume',
      { expectedRevision: 4 },
      headers
    )
    expect(retried.status).toBe(202)
    expect(JSON.parse(retried.body)).toMatchObject({
      draft: {
        revision: 5,
        status: 'planning'
      }
    })
  })

  it('cancels a planning draft once and rejects a stale revision', async () => {
    const testRuntime = runtime()
    const headers = { authorization: 'Bearer graph-route-token' }
    const stale = await dispatch(
      testRuntime,
      'POST',
      '/v1/graph-drafts/draft_1/cancel',
      { expectedRevision: 1 },
      headers
    )
    expect(stale.status).toBe(409)
    expect(testRuntime.turnService.interruptTurn).not.toHaveBeenCalled()

    const cancelled = await dispatch(
      testRuntime,
      'POST',
      '/v1/graph-drafts/draft_1/cancel',
      { expectedRevision: 2 },
      headers
    )
    expect(cancelled.status).toBe(200)
    expect(JSON.parse(cancelled.body)).toMatchObject({
      draft: { status: 'cancelled', revision: 3 }
    })
    expect(testRuntime.turnService.interruptTurn).toHaveBeenCalledWith({
      threadId: 'thread_1',
      turnId: 'turn_1'
    })
    const retried = await dispatch(
      testRuntime,
      'POST',
      '/v1/graph-drafts/draft_1/cancel',
      { expectedRevision: 2 },
      headers
    )
    expect(retried.status).toBe(200)
    expect(JSON.parse(retried.body)).toMatchObject({
      draft: { status: 'cancelled', revision: 3 }
    })
    expect(testRuntime.turnService.interruptTurn).toHaveBeenCalledTimes(2)
  })

  it('returns bounded replay events after reconciling the selected run', async () => {
    const testRuntime = runtime()
    const response = await dispatch(
      testRuntime,
      'GET',
      '/v1/graphs/run_1/events?since_seq=1',
      undefined,
      { authorization: 'Bearer graph-route-token' }
    )

    expect(response.status).toBe(200)
    expect(JSON.parse(response.body)).toEqual({
      events: [{ eventId: 'event_2', graphSeq: 2 }],
      replayFloorSeq: 1,
      currentSeq: 0,
      snapshotSeq: 0,
      truncated: false
    })
    expect(testRuntime.graph!.control.get).toHaveBeenCalledWith('run_1')
    expect(testRuntime.graph!.store.events).toHaveBeenCalledWith('run_1', 1)
  })

  it('reads only artifacts referenced by the selected run through bounded pages', async () => {
    const testRuntime = runtime()
    const headers = { authorization: 'Bearer graph-route-token' }
    const response = await dispatch(
      testRuntime,
      'GET',
      '/v1/graphs/run_1/artifacts/art_abcdef?offset=0&length=3',
      undefined,
      headers
    )

    expect(response.status).toBe(200)
    expect(JSON.parse(response.body)).toMatchObject({
      content: 'abc',
      truncated: true,
      nextOffset: 3,
      meta: { byteSize: 10, lineCount: 1, mimeType: 'text/plain' }
    })
    expect((testRuntime.graph as NonNullable<ServerRuntime['graph']>).artifacts.readRange)
      .toHaveBeenCalledWith('art_abcdef', { offset: 0, length: 3 })

    const invalidRange = await dispatch(
      testRuntime,
      'GET',
      '/v1/graphs/run_1/artifacts/art_abcdef?offset=0&length=0',
      undefined,
      headers
    )
    expect(invalidRange.status).toBe(400)

    const missing = await dispatch(
      testRuntime,
      'GET',
      '/v1/graphs/run_1/artifacts/art_deadbeef',
      undefined,
      headers
    )
    expect(missing.status).toBe(404)
    expect((testRuntime.graph as NonNullable<ServerRuntime['graph']>).artifacts.stat)
      .toHaveBeenCalledTimes(1)
  })

  it('verifies canonical project identity and attributes lifecycle governance to the user', async () => {
    const testRuntime = runtime()
    const headers = { authorization: 'Bearer graph-route-token' }
    const mismatch = await dispatch(
      testRuntime,
      'POST',
      '/v1/graph-projects/project_wrong/agents/route',
      {
        workspace: '/workspace',
        request: {
          version: 1,
          projectId: 'project_wrong',
          query: 'Review TypeScript',
          riskClass: 'low',
          requiredTools: [],
          requiredSkills: [],
          requiredMcpServers: [],
          readScopes: [],
          writeScopes: [],
          networkRequired: false,
          modelCapabilityTags: []
        }
      },
      headers
    )
    expect(mismatch.status).toBe(409)
    expect(testRuntime.graph!.registry.route).not.toHaveBeenCalled()

    const transitioned = await dispatch(
      testRuntime,
      'POST',
      '/v1/graph-projects/project_1/agents/profile_1/lifecycle',
      {
        workspace: '/workspace',
        lifecycle: 'dormant',
        reason: 'User disabled this specialist.'
      },
      headers
    )
    expect(transitioned.status).toBe(200)
    expect(testRuntime.graph!.registry.transitionProfile).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'project_1' }),
      'profile_1',
      'dormant',
      'User disabled this specialist.',
      'user'
    )
  })

  it('exposes sanitized aggregate diagnostics without resource paths', async () => {
    const response = await dispatch(
      runtime(),
      'GET',
      '/v1/graphs/diagnostics',
      undefined,
      { authorization: 'Bearer graph-route-token' }
    )
    expect(response.status).toBe(200)
    expect(response.body).not.toContain('/private/secret')
    expect(response.body).not.toContain('workspaceRoot')
    expect(JSON.parse(response.body)).toMatchObject({
      enabled: true,
      resources: {
        leaseStates: { active: 1 },
        worktreeStates: { preserved: 1 },
        activeLeases: 1,
        preservedWorktrees: 1
      }
    })
  })

  it('records portable profile exports in the governance audit trail', async () => {
    const testRuntime = runtime()
    const response = await dispatch(
      testRuntime,
      'GET',
      '/v1/graph-projects/project_1/agents/profile_1/export',
      undefined,
      { authorization: 'Bearer graph-route-token' }
    )
    expect(response.status).toBe(200)
    expect(testRuntime.graph!.registry.recordProfileExport).toHaveBeenCalledWith(
      'project_1',
      expect.objectContaining({ profileId: 'profile_1', profileVersion: 1 })
    )
  })
})

async function dispatch(
  runtimeValue: ServerRuntime,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: string }> {
  const router = buildRouter(runtimeValue)
  const request = new Request(`http://127.0.0.1${path}`, {
    method,
    headers: {
      ...headers,
      ...(body === undefined ? {} : { 'content-type': 'application/json' })
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  })
  const match = router.match(method, new URL(request.url).pathname)
  if (!match) throw new Error(`route not found: ${method} ${path}`)
  const result = await match.handler(request, { params: match.params })
  return result instanceof Response
    ? { status: result.status, body: await result.text() }
    : { status: result.status, body: result.body }
}
