import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GraphEventEnvelope, GraphRun } from './graph-types'

const client = vi.hoisted(() => ({
  listRuns: vi.fn(),
  getRun: vi.fn(),
  identity: vi.fn(),
  listProfiles: vi.fn(),
  listEvidence: vi.fn(),
  listScores: vi.fn(),
  listAudit: vi.fn(),
  listCandidates: vi.fn(),
  listJobs: vi.fn(),
  patch: vi.fn(),
  readArtifact: vi.fn()
}))

vi.mock('./graph-runtime-client', () => ({
  graphRuntimeClient: client
}))

import { receiveGraphRuntimeEvent, useGraphStore } from './graph-store'

function run(id: string, seq: number): GraphRun {
  return {
    version: 1,
    id,
    projectId: 'project_1',
    threadId: 'thread_1',
    sourceTurnId: 'turn_1',
    status: 'running',
    currentRevision: 1,
    plans: [],
    nodes: {},
    reviews: [],
    messages: [],
    artifacts: [],
    cleanup: [],
    steering: [],
    budget: {
      limits: {
        maxTotalTokens: 10_000,
        maxWallTimeMs: 60_000,
        maxAttemptsPerNode: 3
      },
      attempts: 0,
      revisions: 0,
      loopIterations: 0,
      elapsedMs: 0,
      totalTokens: 0,
      messages: 0,
      artifactBytes: 0,
      warningKinds: [],
      closed: false
    },
    lastEventSeq: seq,
    createdAt: '2026-07-26T00:00:00.000Z',
    updatedAt: '2026-07-26T00:00:00.000Z'
  }
}

describe('Graph renderer store', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useGraphStore.setState({
      threadId: null,
      workspace: '',
      runs: [],
      selectedRunId: null,
      selectedNodeId: null,
      identity: null,
      profiles: [],
      evidence: [],
      scores: [],
      audit: [],
      candidates: [],
      jobs: [],
      artifactPage: null,
      artifactContent: '',
      artifactLoading: false,
      loading: false,
      error: null
    })
  })

  it('reconciles an SSE hint against durable HTTP truth without optimistic mutation', async () => {
    client.listRuns.mockResolvedValueOnce([run('run_1', 1)])
    await useGraphStore.getState().refreshThread('thread_1')
    expect(useGraphStore.getState().runs[0]?.lastEventSeq).toBe(1)

    client.listRuns.mockResolvedValueOnce([run('run_1', 2)])
    receiveGraphRuntimeEvent({
      version: 1,
      eventId: 'event_2',
      runId: 'run_1',
      threadId: 'thread_1',
      graphSeq: 2,
      graphRevision: 1,
      timestamp: '2026-07-26T00:00:01.000Z',
      event: { type: 'node_status_changed', payload: {} }
    } satisfies GraphEventEnvelope)

    await vi.waitFor(() => {
      expect(useGraphStore.getState().runs[0]?.lastEventSeq).toBe(2)
    })
    expect(client.listRuns).toHaveBeenCalledTimes(2)
  })

  it('ignores stale, malformed, and unrelated runtime events', async () => {
    client.listRuns.mockResolvedValue([run('run_1', 3)])
    await useGraphStore.getState().refreshThread('thread_1')

    receiveGraphRuntimeEvent({ version: 1, graphSeq: 4 })
    receiveGraphRuntimeEvent({
      version: 1,
      eventId: 'event_4',
      runId: 'run_1',
      threadId: 'thread_other',
      graphSeq: 4,
      graphRevision: 1,
      timestamp: '2026-07-26T00:00:01.000Z',
      event: { type: 'node_status_changed', payload: {} }
    })
    receiveGraphRuntimeEvent({
      version: 1,
      eventId: 'event_2',
      runId: 'run_1',
      threadId: 'thread_1',
      graphSeq: 2,
      graphRevision: 1,
      timestamp: '2026-07-26T00:00:01.000Z',
      event: { type: 'node_status_changed', payload: {} }
    })

    await Promise.resolve()
    expect(client.listRuns).toHaveBeenCalledTimes(1)
  })

  it('loads project agents, scores, governance and learning state together', async () => {
    client.identity.mockResolvedValue({
      version: 1,
      projectId: 'project_1',
      canonicalWorkspaceRoot: '/repo',
      source: 'workspace_root',
      resolvedAt: '2026-07-26T00:00:00.000Z'
    })
    client.listProfiles.mockResolvedValue([])
    client.listEvidence.mockResolvedValue([])
    client.listScores.mockResolvedValue([{ profileId: 'agent_1', aggregate: 0.8 }])
    client.listAudit.mockResolvedValue([{ auditId: 'audit_1' }])
    client.listCandidates.mockResolvedValue([])
    client.listJobs.mockResolvedValue([])

    await useGraphStore.getState().refreshProject('/repo')

    expect(useGraphStore.getState()).toMatchObject({
      identity: { projectId: 'project_1' },
      scores: [{ profileId: 'agent_1', aggregate: 0.8 }],
      audit: [{ auditId: 'audit_1' }]
    })
  })

  it('applies rebind patches only from durable server truth', async () => {
    const current = run('run_1', 3)
    const revised = { ...current, currentRevision: 2, lastEventSeq: 4 }
    useGraphStore.setState({ runs: [current], selectedRunId: current.id })
    client.patch.mockResolvedValue(revised)

    await useGraphStore.getState().rebindNode('node_1', 'profile_1')

    expect(client.patch).toHaveBeenCalledWith(
      current,
      [{
        op: 'rebind_node',
        nodeId: 'node_1',
        assignment: { kind: 'existing', profileId: 'profile_1' }
      }],
      expect.stringContaining('node_1')
    )
    expect(useGraphStore.getState().runs[0]).toBe(revised)
  })

  it('pages artifact previews without requesting unbounded content', async () => {
    const current = run('run_1', 3)
    useGraphStore.setState({ runs: [current], selectedRunId: current.id })
    client.readArtifact
      .mockResolvedValueOnce({
        reference: {
          artifactId: 'art_abcdef',
          summary: 'output',
          mimeType: 'text/plain',
          byteLength: 6
        },
        meta: { byteSize: 6, lineCount: 1, mimeType: 'text/plain' },
        content: 'abc',
        range: { offset: 0, length: 3 },
        truncated: true,
        nextOffset: 3
      })
      .mockResolvedValueOnce({
        reference: {
          artifactId: 'art_abcdef',
          summary: 'output',
          mimeType: 'text/plain',
          byteLength: 6
        },
        meta: { byteSize: 6, lineCount: 1, mimeType: 'text/plain' },
        content: 'def',
        range: { offset: 3, length: 3 },
        truncated: false
      })

    await useGraphStore.getState().loadArtifact('art_abcdef')
    await useGraphStore.getState().loadNextArtifactPage()

    expect(client.readArtifact).toHaveBeenNthCalledWith(1, 'run_1', 'art_abcdef')
    expect(client.readArtifact).toHaveBeenNthCalledWith(
      2,
      'run_1',
      'art_abcdef',
      { offset: 3 }
    )
    expect(useGraphStore.getState().artifactContent).toBe('def')
  })
})
