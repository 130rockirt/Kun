import { describe, expect, it } from 'vitest'
import type {
  GraphChildRuntime,
  GraphNodeProjection,
  GraphPlanNode,
  GraphRun
} from '../../graph/graph-types'
import {
  fitComposerGraphLabel,
  getComposerGraphProgress,
  graphRunOwnsThreadProgress,
  layoutComposerGraph
} from './composer-graph-preview'

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

function graphRunWithIncomingEdge(target: GraphNodeProjection): GraphRun {
  const run = graphRun(target)
  const upstream: GraphPlanNode = {
    ...target.node,
    id: 'node_upstream',
    title: 'Prepare input'
  }
  run.plans[0]!.nodes.unshift(upstream)
  run.plans[0]!.edges.push({
    id: 'edge_upstream_target',
    kind: 'control',
    from: upstream.id,
    to: target.node.id
  })
  run.nodes[upstream.id] = {
    node: upstream,
    status: 'accepted',
    attempts: [],
    loopIteration: 0
  }
  return run
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

  it('treats terminal run state as authoritative over stale running child state', () => {
    const run = graphRun(readyNode())
    run.status = 'cancelled'
    const progress = getComposerGraphProgress(run, { child_1: child('running') })

    expect(progress.activeCount).toBe(0)
    expect(progress.activeAgents).toEqual([])
  })

  it('flows incoming edges when a correlated child runs before durable node status catches up', () => {
    const run = graphRunWithIncomingEdge(readyNode())
    const layout = layoutComposerGraph(run, { child_1: child('running') })

    expect(layout.nodes.find((node) => node.id === 'node_1')?.processing).toBe(true)
    expect(layout.edges).toEqual([
      expect.objectContaining({
        id: 'edge_upstream_target',
        flowing: true
      })
    ])
  })

  it('keeps incoming edges static for waiting and terminal runs', () => {
    const waitingRun = graphRunWithIncomingEdge(readyNode())
    expect(layoutComposerGraph(waitingRun, { child_1: child('completed') }).edges[0]?.flowing)
      .toBe(false)

    waitingRun.status = 'completed'
    expect(layoutComposerGraph(waitingRun, { child_1: child('running') }).edges[0]?.flowing)
      .toBe(false)
  })
})

describe('graphRunOwnsThreadProgress (#1202)', () => {
  it('hands progress authority to a live Graph run on the same thread', () => {
    expect(graphRunOwnsThreadProgress([graphRun(readyNode())], 'thread_1')).toBe(true)
  })

  it('leaves authority with the plan checklist once every run is terminal', () => {
    const run = graphRun(readyNode())
    run.status = 'completed'

    expect(graphRunOwnsThreadProgress([run], 'thread_1')).toBe(false)
  })

  it('ignores live runs that belong to another thread', () => {
    expect(graphRunOwnsThreadProgress([graphRun(readyNode())], 'thread_2')).toBe(false)
    expect(graphRunOwnsThreadProgress([graphRun(readyNode())], null)).toBe(false)
    expect(graphRunOwnsThreadProgress([], 'thread_1')).toBe(false)
  })
})

describe('composer Graph SVG label fitting', () => {
  it('keeps short labels at their preferred font size', () => {
    expect(fitComposerGraphLabel('Kun', 80, 11, 8)).toEqual({
      text: 'Kun',
      fontSize: 11,
      estimatedWidth: expect.any(Number),
      truncated: false
    })
  })

  it('shrinks mixed labels before truncating them', () => {
    const fitted = fitComposerGraphLabel('work-优化-docs', 70, 11, 8)

    expect(fitted.fontSize).toBeGreaterThanOrEqual(8)
    expect(fitted.fontSize).toBeLessThan(11)
    expect(fitted.estimatedWidth).toBeLessThanOrEqual(70)
    expect(fitted.truncated).toBe(false)
  })

  it('uses the minimum readable size and ellipsis for long CJK labels', () => {
    const fitted = fitComposerGraphLabel('摸清文档顶部页与官网设计语言', 110, 11, 8)

    expect(fitted.fontSize).toBe(8)
    expect(fitted.text).toMatch(/…$/)
    expect(fitted.estimatedWidth).toBeLessThanOrEqual(110)
    expect(fitted.truncated).toBe(true)
  })

  it('bounds extremely long labels without returning an undersized font', () => {
    const fitted = fitComposerGraphLabel('A'.repeat(200), 44, 9, 7)

    expect(fitted.fontSize).toBe(7)
    expect(fitted.text.length).toBeLessThan(200)
    expect(fitted.text).toMatch(/…$/)
    expect(fitted.estimatedWidth).toBeLessThanOrEqual(44)
  })
})
