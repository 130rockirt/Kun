import { type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type {
  GraphAttempt,
  GraphChildRuntime,
  GraphPlanNode,
  GraphRun
} from '../../graph/graph-types'
import {
  criticalPathNodeIds,
  filterGraphElementsByPhases,
  graphElements,
  plannedAssignmentLabel,
  runProgress
} from './GraphModePanel'
import { reconcileInteractiveGraphNodes } from './graph-canvas-state'
import { clampGraphInspectorWidth } from './graph-workspace-layout'

function node(id: string, phaseId: string): GraphPlanNode {
  return {
    id,
    phaseId,
    kind: 'work',
    title: id,
    objective: `Complete ${id}`,
    priority: 0,
    required: true,
    riskClass: 'low',
    readScopes: [],
    writeScopes: []
  }
}

function graphRun(nodes: GraphPlanNode[], edges: GraphRun['plans'][number]['edges']): GraphRun {
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
      title: 'Test graph',
      goal: 'Verify projection',
      workspaceRoot: '/repo',
      phases: [
        { id: 'phase_1', title: 'One', order: 1 },
        { id: 'phase_2', title: 'Two', order: 2 },
        { id: 'phase_3', title: 'Three', order: 3 }
      ],
      nodes,
      edges,
      completionNodeIds: [nodes.at(-1)!.id],
      createdAt: '2026-07-26T00:00:00.000Z'
    }],
    nodes: Object.fromEntries(nodes.map((item, index) => [
      item.id,
      {
        node: item,
        status: index === 0 ? 'accepted' : 'pending',
        attempts: [],
        loopIteration: 0
      }
    ])),
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
    lastEventSeq: 1,
    createdAt: '2026-07-26T00:00:00.000Z',
    updatedAt: '2026-07-26T00:00:00.000Z'
  }
}

describe('Graph Mode panel projection', () => {
  it('marks the longest forward dependency path as critical and ignores message edges', () => {
    const nodes = [
      node('start', 'phase_1'),
      node('middle', 'phase_2'),
      node('side', 'phase_2'),
      node('finish', 'phase_3')
    ]
    const run = graphRun(nodes, [
      { id: 'e1', kind: 'control', from: 'start', to: 'middle' },
      { id: 'e2', kind: 'control', from: 'middle', to: 'finish' },
      { id: 'e3', kind: 'message', from: 'side', to: 'finish' }
    ])

    run.nodes.middle!.status = 'skipped'
    run.nodes.side!.status = 'superseded'

    expect([...criticalPathNodeIds(run)]).toEqual(['finish', 'middle', 'start'])
    expect(runProgress(run)).toEqual({ completed: 1, total: 4 })
  })

  it('projects a large graph without truncating nodes or edges', () => {
    const nodes = Array.from({ length: 500 }, (_, index) =>
      node(`node_${index}`, `phase_${index % 3 + 1}`))
    const edges = nodes.slice(1).map((item, index) => ({
      id: `edge_${index}`,
      kind: 'control' as const,
      from: nodes[index]!.id,
      to: item.id
    }))

    const elements = graphElements(graphRun(nodes, edges))

    expect(elements.nodes).toHaveLength(500)
    expect(elements.edges).toHaveLength(499)
  })

  it('keeps node labels accessible and disables animated edges for reduced motion', () => {
    const nodes = [node('start', 'phase_1'), node('finish', 'phase_2')]
    const run = graphRun(nodes, [{
      id: 'edge_1',
      kind: 'control',
      from: 'start',
      to: 'finish'
    }])
    run.nodes.finish!.status = 'running'

    const animated = graphElements(run, false)
    const reduced = graphElements(run, true)

    expect(animated.edges[0]?.animated).toBe(true)
    expect(animated.edges[0]?.className).toBe('graph-flow-edge-processing')
    expect(reduced.edges[0]?.animated).toBe(false)
    expect(reduced.edges[0]?.className).toBe('graph-flow-edge-processing')
    expect(reduced.nodes.map((item) => item.ariaLabel)).toEqual([
      'start: accepted; Kun auto route',
      'finish: running; Kun auto route'
    ])
    expect(renderToStaticMarkup(animated.nodes[1]?.data.label as ReactElement))
      .toContain('ds-subagent-lane-sweep')
    expect(renderToStaticMarkup(reduced.nodes[1]?.data.label as ReactElement))
      .not.toContain('ds-subagent-lane-sweep')
  })

  it('animates only edges flowing into processing nodes', () => {
    const nodes = [
      node('start', 'phase_1'),
      node('side', 'phase_1'),
      node('working', 'phase_2'),
      node('waiting', 'phase_3')
    ]
    const run = graphRun(nodes, [
      { id: 'into_working', kind: 'control', from: 'start', to: 'working' },
      { id: 'side_into_working', kind: 'data', from: 'side', to: 'working' },
      { id: 'out_of_working', kind: 'control', from: 'working', to: 'waiting' }
    ])
    run.nodes.working!.status = 'reviewing'

    const projected = graphElements(run)

    expect(projected.edges.map((edge) => [edge.id, edge.animated])).toEqual([
      ['into_working', true],
      ['side_into_working', true],
      ['out_of_working', false]
    ])
  })

  it('keeps all edges static after the Graph run becomes terminal', () => {
    const nodes = [node('start', 'phase_1'), node('finish', 'phase_2')]
    const run = graphRun(nodes, [{
      id: 'edge_1',
      kind: 'control',
      from: 'start',
      to: 'finish'
    }])
    run.nodes.finish!.status = 'running'
    run.status = 'completed'

    expect(graphElements(run).edges[0]).toMatchObject({
      animated: false,
      className: undefined
    })
  })

  it('animates into a ready node when its correlated child is already running', () => {
    const nodes = [node('start', 'phase_1'), node('finish', 'phase_2')]
    const run = graphRun(nodes, [{
      id: 'edge_1',
      kind: 'control',
      from: 'start',
      to: 'finish'
    }])
    run.nodes.finish!.status = 'ready'
    run.nodes.finish!.attempts = [{
      id: 'attempt_1',
      attemptNumber: 1,
      status: 'running',
      childThreadId: 'child_1',
      tokenUsage: 0,
      elapsedMs: 0,
      assignment: { name: 'Builder' } as GraphAttempt['assignment']
    }]
    const childRuns: Record<string, GraphChildRuntime> = {
      child_1: {
        childId: 'child_1',
        parentThreadId: 'thread_1',
        parentTurnId: 'turn_1',
        status: 'running',
        updatedAt: '2026-07-29T00:00:00.000Z'
      }
    }

    expect(graphElements(run, false, null, { childRuns }).edges[0]).toMatchObject({
      animated: true,
      className: 'graph-flow-edge-processing'
    })
  })

  it('uses neutral styling for ordinary dependency waiting', () => {
    const waiting = node('waiting', 'phase_1')
    const run = graphRun([waiting], [])
    run.nodes.waiting!.status = 'blocked'

    const projected = graphElements(run)

    expect(projected.nodes[0]?.style).toMatchObject({
      border: '1px solid var(--ds-border-muted)'
    })
    expect(renderToStaticMarkup(projected.nodes[0]?.data.label as ReactElement))
      .toContain('Waiting for upstream node')
  })

  it('collapses phases without leaving dangling edges and supports a bounded list fallback', () => {
    const nodes = [
      node('start', 'phase_1'),
      node('middle', 'phase_2'),
      node('finish', 'phase_3')
    ]
    const run = graphRun(nodes, [
      { id: 'e1', kind: 'control', from: 'start', to: 'middle' },
      { id: 'e2', kind: 'control', from: 'middle', to: 'finish' }
    ])

    const filtered = filterGraphElementsByPhases(
      run,
      graphElements(run),
      new Set(['phase_2'])
    )

    expect(filtered.nodes.map((item) => item.id)).toEqual(['start', 'finish'])
    expect(filtered.edges).toEqual([])
  })

  it('shows the planned subagent before dispatch and the selected node clearly', () => {
    const planned = {
      ...node('research', 'phase_1'),
      assignment: {
        kind: 'existing' as const,
        profileId: 'explore',
        profileVersion: 2
      }
    }
    const projected = graphElements(graphRun([planned], []), false, 'research')

    expect(plannedAssignmentLabel(planned)).toBe('explore@2')
    expect(projected.nodes[0]).toMatchObject({
      id: 'research',
      selected: true,
      ariaLabel: 'research: accepted; explore@2'
    })
  })

  it('preserves dragged positions while refreshing status and selection data', () => {
    const incoming = graphElements(graphRun([
      node('start', 'phase_1'),
      node('finish', 'phase_2')
    ], [])).nodes
    const current = [{
      ...incoming[0]!,
      position: { x: 812, y: 408 }
    }]

    const reconciled = reconcileInteractiveGraphNodes(current, incoming, 'start')

    expect(reconciled[0]?.position).toEqual({ x: 812, y: 408 })
    expect(reconciled[0]?.selected).toBe(true)
    expect(reconciled[1]?.position).toEqual(incoming[1]?.position)
  })

  it('bounds the inspector while reserving usable canvas space', () => {
    expect(clampGraphInspectorWidth(360, 900)).toBe(360)
    expect(clampGraphInspectorWidth(800, 900)).toBe(378)
    expect(clampGraphInspectorWidth(100, 900)).toBe(280)
    expect(clampGraphInspectorWidth(360, 760)).toBe(319)
  })
})
