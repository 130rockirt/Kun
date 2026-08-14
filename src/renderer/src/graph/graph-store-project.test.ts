import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  GraphEventEnvelope,
  GraphPlanNode,
  GraphPlanningDraftView,
  GraphRun
} from './graph-types'

const client = vi.hoisted(() => ({
  delegationDiagnostics: vi.fn(),
  listRuns: vi.fn(),
  listDrafts: vi.fn(),
  resumeDraft: vi.fn(),
  cancelDraft: vi.fn(),
  getDraft: vi.fn(),
  getRun: vi.fn(),
  identity: vi.fn(),
  listProfiles: vi.fn(),
  listEvidence: vi.fn(),
  listScores: vi.fn(),
  listAudit: vi.fn(),
  listCandidates: vi.fn(),
  listJobs: vi.fn(),
  patch: vi.fn(),
  steer: vi.fn(),
  readArtifact: vi.fn()
}))

vi.mock('./graph-runtime-client', () => ({
  graphRuntimeClient: client
}))

import {
  receiveGraphChildRuntimeEvent,
  receiveGraphPlanningRuntimeEvent,
  receiveGraphRuntimeEvent,
  selectGraphPlanningCorrectionDraft,
  useGraphStore
} from './graph-store'

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

function runWithNode(id: string, seq: number, nodeId: string): GraphRun {
  const node: GraphPlanNode = {
    id: nodeId,
    phaseId: 'phase_1',
    kind: 'work',
    title: 'Selected node',
    objective: 'Keep the selected inspector visible.',
    priority: 1,
    required: true,
    riskClass: 'low',
    readScopes: [],
    writeScopes: []
  }
  return {
    ...run(id, seq),
    plans: [{
      version: 1,
      revision: 1,
      title: 'Selection test',
      goal: 'Preserve durable selection',
      workspaceRoot: '/repo',
      phases: [{ id: 'phase_1', title: 'Phase', order: 1 }],
      nodes: [node],
      edges: [],
      completionNodeIds: [nodeId],
      createdAt: '2026-07-26T00:00:00.000Z'
    }],
    nodes: {
      [nodeId]: {
        node,
        status: 'running',
        attempts: [],
        loopIteration: 0
      }
    }
  }
}

function planningDraft(
  status: GraphPlanningDraftView['draft']['status'] = 'needs_correction',
  revision = 1
): GraphPlanningDraftView {
  return {
    draft: {
      version: 1,
      id: 'draft_1',
      reservedRunId: 'run_reserved_1',
      threadId: 'thread_1',
      sourceTurnId: 'turn_1',
      projectId: 'project_1',
      goal: 'Implement the requested change.',
      revision,
      status,
      issues: [],
      repairCount: status === 'planning' ? 0 : 1,
      createdAt: '2026-07-29T00:00:00.000Z',
      updatedAt: '2026-07-29T00:00:01.000Z'
    },
    tasks: []
  }
}

describe('Graph renderer project and artifact operations', () => {
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

  it('routes active source-turn guidance to the owning GraphRun Lead', async () => {
    const current = run('run_1', 3)
    const steered = {
      ...current,
      lastEventSeq: 4,
      steering: [{
        steeringId: 'steering_1',
        target: { kind: 'lead' },
        text: 'Inspect the failing check.',
        status: 'persisted',
        createdAt: '2026-07-26T00:00:01.000Z'
      }]
    } as GraphRun
    useGraphStore.setState({
      threadId: current.threadId,
      runs: [current],
      selectedRunId: current.id
    })
    client.steer.mockResolvedValue(steered)

    await expect(useGraphStore.getState().steerSourceTurn(
      current.threadId,
      current.sourceTurnId,
      'Inspect the failing check.'
    )).resolves.toBe(true)

    expect(client.steer).toHaveBeenCalledWith(
      current.id,
      'Inspect the failing check.',
      { kind: 'lead' }
    )
    expect(useGraphStore.getState().runs[0]).toBe(steered)
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
