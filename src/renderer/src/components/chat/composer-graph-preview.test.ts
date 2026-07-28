import { describe, expect, it } from 'vitest'
import type {
  GraphChildRuntime,
  GraphNodeProjection,
  GraphPlanNode,
  GraphRun
} from '../../graph/graph-types'
import { getComposerGraphProgress } from './composer-graph-preview'

function graphRun(node: GraphNodeProjection): GraphRun {
  return {
    version: 1,
    id: 'run_1',
    projectId: 'project_1',
    threadId: 'thread_1',
    sourceTurnId: 'turn_1',
    status: 'running',
    currentRevision: 1,
    plans: [{
      version: 1,
      revision: 1,
      title: 'Progress race',
      goal: 'Keep live child state truthful.',
      workspaceRoot: '/repo',
      phases: [{ id: 'phase_1', title: 'Phase', order: 1 }],
      nodes: [node.node],
      edges: [],
      completionNodeIds: [node.node.id],
      createdAt: '2026-07-28T00:00:00.000Z'
    }],
    nodes: { [node.node.id]: node },
    reviews: [],
    messages: [],
    artifacts: [],
    cleanup: [],
    steering: [],
    budget: {
      limits: {
        maxWallTimeMs: 86_400_000,
        maxAttemptsPerNode: 3
      },
      attempts: 1,
      revisions: 0,
      loopIterations: 0,
      elapsedMs: 0,
      totalTokens: 0,
      messages: 0,
      artifactBytes: 0,
      warningKinds: [],
      closed: false
    },
    lastEventSeq: 2,
    createdAt: '2026-07-28T00:00:00.000Z',
    updatedAt: '2026-07-28T00:00:01.000Z'
  }
}

function readyNode(): GraphNodeProjection {
  const node: GraphPlanNode = {
    id: 'node_1',
    phaseId: 'phase_1',
    kind: 'work',
    title: 'Inspect runtime',
    objective: 'Inspect the runtime state.',
    priority: 1,
    required: true,
    riskClass: 'low',
    readScopes: [],
    writeScopes: []
  }
  return {
    node,
    status: 'ready',
    attempts: [{
      id: 'attempt_1',
      attemptNumber: 1,
      status: 'running',
      assignment: {
        profileId: 'runtime-inspector',
        profileVersion: 1,
        profileOrigin: 'ephemeral',
        name: 'Runtime Inspector',
        model: 'model',
        providerId: 'provider',
        allowedModelProviderIds: ['provider'],
        allowedModels: ['model'],
        allowedProviderIds: ['builtin'],
        reasoningEffort: 'medium',
        systemPrompt: 'Inspect.',
        toolPolicy: 'readOnly',
        allowedTools: [],
        blockedTools: [],
        allowedSkills: [],
        blockedSkills: [],
        allowedMcpServers: [],
        blockedMcpServers: [],
        approvalPolicy: 'never',
        sandboxMode: 'read-only',
        workspaceRoot: '/repo',
        readScopes: [],
        writeScopes: [],
        networkAllowed: false,
        maxWallTimeMs: 86_400_000,
        capturedAt: '2026-07-28T00:00:00.000Z'
      },
      childThreadId: 'child_1',
      queuedAt: '2026-07-28T00:00:00.000Z',
      startedAt: '2026-07-28T00:00:01.000Z',
      tokenUsage: 0,
      elapsedMs: 0
    }],
    loopIteration: 0
  }
}

function child(status: GraphChildRuntime['status']): GraphChildRuntime {
  return {
    childId: 'child_1',
    parentThreadId: 'thread_1',
    parentTurnId: 'turn_1',
    status,
    updatedAt: '2026-07-28T00:00:02.000Z'
  }
}

describe('composer Graph progress', () => {
  it('counts a correlated running child while the durable node is still ready', () => {
    const progress = getComposerGraphProgress(
      graphRun(readyNode()),
      { child_1: child('running') }
    )

    expect(progress).toMatchObject({
      completed: 0,
      activeCount: 1,
      currentNodeId: 'node_1',
      childThreadId: 'child_1'
    })
    expect(progress.activeAgents).toEqual(['Runtime Inspector'])
  })

  it('does not count a terminal child as active for a ready node', () => {
    const progress = getComposerGraphProgress(
      graphRun(readyNode()),
      { child_1: child('completed') }
    )

    expect(progress.activeCount).toBe(0)
  })
})
