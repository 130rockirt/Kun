import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import i18n from '../../i18n'
import type {
  GraphPlanNode,
  GraphRun,
  GraphSupervisionLiveness,
  GraphSupervisionProjection
} from '../../graph/graph-types'
import { GraphSupervisionBanner } from './GraphSupervisionBanner'

const planNode: GraphPlanNode = {
  id: 'node_1',
  phaseId: 'phase_1',
  kind: 'work',
  title: 'Verify the result',
  objective: 'Review durable evidence.',
  priority: 1,
  required: true,
  riskClass: 'low',
  readScopes: [],
  writeScopes: []
}

function run(): GraphRun {
  return {
    version: 1,
    id: 'run_1',
    projectId: 'project_1',
    threadId: 'thread_1',
    sourceTurnId: 'turn_1',
    status: 'awaiting_supervision',
    currentRevision: 1,
    plans: [{
      version: 1,
      revision: 1,
      title: 'Review run',
      goal: 'Verify the result.',
      workspaceRoot: '/repo',
      phases: [{ id: 'phase_1', title: 'Review', order: 1 }],
      nodes: [planNode],
      edges: [],
      completionNodeIds: ['node_1'],
      createdAt: '2026-07-31T00:00:00.000Z'
    }],
    nodes: {
      node_1: {
        node: planNode,
        status: 'reviewing',
        attempts: [],
        loopIteration: 0
      }
    },
    reviews: [],
    messages: [],
    artifacts: [],
    cleanup: [],
    steering: [],
    budget: {
      limits: { maxWallTimeMs: 600_000, maxAttemptsPerNode: 3 },
      attempts: 1,
      revisions: 0,
      loopIterations: 0,
      elapsedMs: 1_000,
      totalTokens: 1,
      messages: 0,
      artifactBytes: 0,
      warningKinds: [],
      closed: false
    },
    lastEventSeq: 9,
    createdAt: '2026-07-31T00:00:00.000Z',
    updatedAt: '2026-07-31T00:01:00.000Z'
  }
}

function projection(
  liveness: Exclude<GraphSupervisionLiveness, 'idle'>
): GraphSupervisionProjection {
  const canWake = liveness !== 'active_review'
  return {
    version: 1,
    runId: 'run_1',
    lastEventSeq: 9,
    leadActive: liveness === 'active_review',
    liveness,
    pendingActions: [{
      obligationId: 'obligation_1',
      pendingAction: 'review_required',
      nodeIds: ['node_1'],
      liveness,
      retryCount: liveness === 'retry_scheduled' ? 2 : 0,
      noProgressCount: liveness === 'needs_attention' ? 3 : 0,
      ...(liveness === 'retry_scheduled'
        ? { nextWakeAt: '2026-07-31T00:02:00.000Z' }
        : {}),
      ...(liveness === 'needs_attention'
        ? { attentionReason: 'The Graph run needs user attention before supervision can continue.' }
        : {}),
      canWake
    }],
    canWake,
    updatedAt: '2026-07-31T00:01:00.000Z'
  }
}

describe('GraphSupervisionBanner', () => {
  beforeAll(async () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    await i18n.changeLanguage('en')
  })

  it.each([
    ['waiting_for_lead', 'Waiting for the source Lead'],
    ['active_review', 'The source Lead is reviewing'],
    ['retry_scheduled', 'Lead wake retry scheduled'],
    ['needs_attention', 'Graph supervision needs attention']
  ] as const)('renders the %s state truthfully', (liveness, label) => {
    const html = renderToStaticMarkup(createElement(GraphSupervisionBanner, {
      run: run(),
      supervision: projection(liveness),
      wakingObligationId: null,
      onWakeLead: vi.fn()
    }))

    expect(html).toContain(`data-graph-supervision="${liveness}"`)
    expect(html).toContain(label)
    expect(html).toContain('Review the submitted result')
    expect(html).not.toContain('ds-subagent-lane-sweep')
    expect(html.includes('data-graph-supervision-wake')).toBe(liveness !== 'active_review')
  })

  it('shows bounded retry and attention metadata', () => {
    const retryHtml = renderToStaticMarkup(createElement(GraphSupervisionBanner, {
      run: run(),
      supervision: projection('retry_scheduled'),
      wakingObligationId: null,
      onWakeLead: vi.fn()
    }))
    const attentionHtml = renderToStaticMarkup(createElement(GraphSupervisionBanner, {
      run: run(),
      supervision: projection('needs_attention'),
      wakingObligationId: null,
      onWakeLead: vi.fn()
    }))

    expect(retryHtml).toContain('Wake retries')
    expect(retryHtml).toContain('>2<')
    expect(retryHtml).toContain('dateTime="2026-07-31T00:02:00.000Z"')
    expect(attentionHtml).toContain('No-progress rounds')
    expect(attentionHtml).toContain('needs user attention')
  })

  it('wakes the original obligation and disables duplicate clicks in flight', async () => {
    const onWakeLead = vi.fn()
    let renderer: ReactTestRenderer
    await act(async () => {
      renderer = create(createElement(GraphSupervisionBanner, {
        run: run(),
        supervision: projection('waiting_for_lead'),
        wakingObligationId: null,
        onWakeLead
      }))
    })
    const button = renderer!.root.find((node) => node.props['data-graph-supervision-wake'])
    act(() => button.props.onClick())
    expect(onWakeLead).toHaveBeenCalledWith('obligation_1')
    act(() => renderer!.unmount())

    const busyHtml = renderToStaticMarkup(createElement(GraphSupervisionBanner, {
      run: run(),
      supervision: projection('waiting_for_lead'),
      wakingObligationId: 'obligation_1',
      onWakeLead
    }))
    expect(busyHtml).toContain('disabled=""')
    expect(busyHtml).toContain('Waking…')
  })
})
