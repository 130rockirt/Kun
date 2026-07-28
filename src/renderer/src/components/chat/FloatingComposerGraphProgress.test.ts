import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '../../i18n'
import { useGraphStore } from '../../graph/graph-store'
import type { GraphPlanNode, GraphRun } from '../../graph/graph-types'
import {
  FloatingComposerGraphPreview,
  FloatingComposerGraphProgress
} from './FloatingComposerGraphProgress'
import {
  getComposerGraphProgress,
  layoutComposerGraph,
  selectComposerGraphRun
} from './composer-graph-preview'
import { calculateComposerPopoverPlacement } from './floating-composer-popover-placement'

function graphNode(
  id: string,
  phaseId: string,
  assignmentName?: string
): GraphPlanNode {
  return {
    id,
    phaseId,
    kind: 'work',
    title: `Node ${id}`,
    objective: `Complete the detailed objective for ${id}.`,
    priority: 1,
    required: true,
    riskClass: 'low',
    assignment: assignmentName
      ? {
          kind: 'ephemeral',
          name: assignmentName,
          systemPrompt: `Own ${id}.`
        }
      : undefined,
    readScopes: [],
    writeScopes: []
  }
}

function graphRun({
  id = 'run_1',
  status = 'running'
}: {
  id?: string
  status?: GraphRun['status']
} = {}): GraphRun {
  const nodes = [
    graphNode('audit', 'discover', 'Explorer'),
    graphNode('implement', 'build', 'Builder'),
    graphNode('review', 'verify', 'Reviewer')
  ]
  return {
    version: 1,
    id,
    projectId: 'project_1',
    threadId: 'thread_1',
    sourceTurnId: 'turn_1',
    status,
    currentRevision: 1,
    plans: [{
      version: 1,
      revision: 1,
      title: 'Ship a usable Graph experience',
      goal: 'Plan, implement, and verify the feature.',
      workspaceRoot: '/repo',
      phases: [
        { id: 'verify', title: 'Verify', order: 3 },
        { id: 'discover', title: 'Discover', order: 1 },
        { id: 'build', title: 'Build', order: 2 }
      ],
      nodes,
      edges: [
        { id: 'edge_audit_build', kind: 'control', from: 'audit', to: 'implement' },
        { id: 'edge_build_review', kind: 'control', from: 'implement', to: 'review' }
      ],
      completionNodeIds: ['review'],
      createdAt: '2026-07-27T00:00:00.000Z'
    }],
    nodes: {
      audit: { node: nodes[0]!, status: 'accepted', attempts: [], loopIteration: 0 },
      implement: { node: nodes[1]!, status: 'running', attempts: [], loopIteration: 0 },
      review: { node: nodes[2]!, status: 'pending', attempts: [], loopIteration: 0 }
    },
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
      attempts: 1,
      revisions: 0,
      loopIterations: 0,
      elapsedMs: 1_000,
      totalTokens: 500,
      messages: 0,
      artifactBytes: 0,
      warningKinds: [],
      closed: false
    },
    lastEventSeq: 5,
    createdAt: '2026-07-27T00:00:00.000Z',
    updatedAt: '2026-07-27T00:01:00.000Z'
  }
}

const originalRefreshThread = useGraphStore.getState().refreshThread

describe('FloatingComposerGraphProgress', () => {
  beforeAll(async () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    await i18n.changeLanguage('en')
  })

  afterAll(() => {
    useGraphStore.setState({ refreshThread: originalRefreshThread })
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT
  })

  beforeEach(() => {
    useGraphStore.setState({
      threadId: 'thread_1',
      runs: [graphRun()],
      childRuns: {},
      childReturnTarget: null,
      selectedRunId: 'run_1',
      selectedNodeId: null,
      refreshThread: vi.fn().mockResolvedValue(undefined)
    })
  })

  it('selects an active run and keeps the selected terminal run readable as fallback', () => {
    const failed = graphRun({ id: 'failed', status: 'failed' })
    const active = graphRun({ id: 'active' })

    expect(selectComposerGraphRun([failed, active], 'failed')?.id).toBe('active')
    expect(selectComposerGraphRun([failed], 'failed')?.id).toBe('failed')
    expect(selectComposerGraphRun([], null)).toBeNull()
  })

  it('projects progress, ordered phases, assigned subagents, and directed edges', () => {
    const run = graphRun()
    expect(getComposerGraphProgress(run)).toEqual({
      completed: 1,
      total: 3,
      fraction: 1 / 3,
      activeAgents: ['Builder'],
      activeCount: 1,
      currentNodeTitle: 'Node implement',
      currentNodeId: 'implement',
      currentStatus: 'running',
      currentAgent: 'Builder',
      attemptNumber: null,
      childThreadId: null,
      childRuntime: null
    })

    const layout = layoutComposerGraph(run)
    expect(layout.phases.map((phase) => phase.id)).toEqual(['discover', 'build', 'verify'])
    expect(layout.nodes.map((node) => node.id)).toEqual(['audit', 'implement', 'review'])
    expect(layout.nodes.find((node) => node.id === 'implement')?.agentName).toBe('Builder')
    expect(layout.edges).toHaveLength(2)
    expect(layout.edges[0]?.path).toMatch(/^M .+ C .+/)
  })

  it('separates zero accepted completion from an actively running node', () => {
    const run = graphRun()
    run.nodes.audit!.status = 'blocked'
    const progress = getComposerGraphProgress(run)

    expect(progress).toMatchObject({
      completed: 0,
      total: 3,
      fraction: 0,
      activeCount: 1,
      currentNodeId: 'implement',
      currentStatus: 'running',
      activeAgents: ['Builder']
    })
  })

  it('does not count skipped or superseded nodes as accepted progress', () => {
    const run = graphRun({ status: 'failed' })
    run.nodes.audit!.status = 'accepted'
    run.nodes.implement!.status = 'skipped'
    run.nodes.review!.status = 'superseded'

    expect(getComposerGraphProgress(run)).toMatchObject({
      completed: 1,
      total: 3,
      fraction: 1 / 3,
      activeCount: 0
    })
  })

  it('places the bounded Graph preview above the composer when room is available', () => {
    const placement = calculateComposerPopoverPlacement({
      anchorRect: { left: 430, right: 1130, top: 720, bottom: 764 },
      popoverHeight: 390,
      viewportHeight: 900,
      viewportWidth: 1560,
      preferredWidth: 680,
      maximumHeight: 420
    })

    expect(placement).toEqual({
      left: 440,
      top: 322,
      width: 680,
      maxHeight: 420
    })
  })

  it('renders the full preview and opens a selected node in the Graph workbench', async () => {
    const onOpenGraph = vi.fn()
    let renderer: ReactTestRenderer
    await act(async () => {
      renderer = create(createElement(FloatingComposerGraphPreview, {
        run: graphRun(),
        onOpenGraph
      }))
    })

    const node = renderer!.root.find((instance) =>
      instance.props['data-graph-preview-node'] === 'implement')
    act(() => node.props.onClick())
    expect(onOpenGraph).toHaveBeenCalledWith('run_1', 'implement')

    const html = renderToStaticMarkup(createElement(FloatingComposerGraphPreview, {
      run: graphRun(),
      onOpenGraph
    }))
    expect(html).toContain('Directed Graph preview with 3 phases and 3 nodes')
    expect(html).toContain('data-graph-preview-edge="edge_audit_build"')
    expect(html).toContain('marker-end="url(#graph-composer-arrow-run_1)"')
    expect(html).toContain('Builder')
    renderer!.unmount()
  })

  it('refreshes durable truth and opens the preview on hover', async () => {
    let renderer: ReactTestRenderer
    await act(async () => {
      renderer = create(createElement(FloatingComposerGraphProgress, {
        threadId: 'thread_1',
        enabled: true,
        onOpenGraph: vi.fn()
      }))
    })

    expect(useGraphStore.getState().refreshThread).toHaveBeenCalledWith('thread_1')
    const trigger = renderer!.root.find((instance) => instance.props['aria-haspopup'] === 'dialog')
    expect(trigger.props['aria-expanded']).toBe(false)
    await act(async () => trigger.props.onPointerEnter())
    expect(renderer!.root.find((instance) =>
      instance.props['aria-haspopup'] === 'dialog').props['aria-expanded']).toBe(true)
    renderer!.unmount()
  })

  it('occupies no composer space when only another thread has a Graph run', async () => {
    let renderer: ReactTestRenderer
    await act(async () => {
      renderer = create(createElement(FloatingComposerGraphProgress, {
        threadId: 'thread_2',
        enabled: true
      }))
    })
    expect(renderer!.toJSON()).toBeNull()
    renderer!.unmount()
  })
})
