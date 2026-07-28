import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import i18n from '../../i18n'
import type {
  GraphAttempt,
  GraphPlanNode,
  GraphRun
} from '../../graph/graph-types'
import { GraphNodeInspector } from './GraphNodeInspector'

beforeAll(async () => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  await i18n.changeLanguage('en')
})

afterAll(() => {
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT
})

describe('GraphNodeInspector', () => {
  it('shows planned assignment and failure details before an attempt exists', () => {
    const run = graphRun()
    run.nodes.audit!.status = 'failed'
    run.nodes.audit!.lastTransitionReason =
      'Graph node admission failed: assignment policy unavailable'

    const html = renderInspector(run)

    expect(html).toContain('Planned subagent')
    expect(html).toContain('explore@2')
    expect(html).toContain('admission failed')
    expect(html).toContain('assignment policy unavailable')
    expect(html).toContain('Inspect the codebase')
  })

  it('shows requested and effective subagents with the dispatched child session', () => {
    const run = graphRun()
    run.nodes.audit!.status = 'running'
    run.nodes.audit!.attempts = [fallbackAttempt()]

    const html = renderInspector(run)

    expect(html).toContain('Requested profile')
    expect(html).toContain('explore')
    expect(html).toContain('Audit fallback')
    expect(html).toContain('thread_child')
    expect(html).toContain('requested profile was unavailable')
    expect(html).toContain('Open child session')
    expect(html).toContain('Open attempt #1 session')
  })

  it('opens the exact child attempt while preserving node identity', async () => {
    const run = graphRun()
    run.nodes.audit!.status = 'running'
    run.nodes.audit!.attempts = [fallbackAttempt()]
    const onOpenChild = vi.fn()
    let renderer: ReactTestRenderer
    await act(async () => {
      renderer = create(createElement(GraphNodeInspector, {
        run,
        node: run.nodes.audit!,
        onRetry: () => undefined,
        onReview: () => undefined,
        onRebind: () => undefined,
        onOpenChild,
        artifactPage: null,
        artifactContent: '',
        artifactLoading: false,
        onOpenArtifact: () => undefined,
        onNextArtifactPage: () => undefined,
        onCloseArtifact: () => undefined
      }))
    })

    const openButtons = renderer!.root.findAllByType('button').filter((button) =>
      button.children.join('').includes('Open child session'))
    act(() => openButtons[0]!.props.onClick())

    expect(onOpenChild).toHaveBeenCalledWith('thread_child', 'audit', 'attempt_1')
    await act(async () => renderer!.unmount())
  })
})

function renderInspector(run: GraphRun): string {
  return renderToStaticMarkup(createElement(GraphNodeInspector, {
    run,
    node: run.nodes.audit!,
    onRetry: () => undefined,
    onReview: () => undefined,
    onRebind: () => undefined,
    onOpenChild: () => undefined,
    artifactPage: null,
    artifactContent: '',
    artifactLoading: false,
    onOpenArtifact: () => undefined,
    onNextArtifactPage: () => undefined,
    onCloseArtifact: () => undefined
  }))
}

function graphRun(): GraphRun {
  const node: GraphPlanNode = {
    id: 'audit',
    phaseId: 'phase_1',
    kind: 'work',
    title: 'Audit',
    objective: 'Inspect the codebase',
    priority: 1,
    required: true,
    riskClass: 'low',
    assignment: {
      kind: 'existing',
      profileId: 'explore',
      profileVersion: 2
    },
    completion: {
      requiredResultFields: ['summary'],
      acceptanceCriteria: ['Return an evidence-backed report'],
      review: {
        kinds: ['lead'],
        requireAll: true,
        deterministicChecks: []
      }
    },
    readScopes: ['src'],
    writeScopes: []
  }
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
      title: 'Audit graph',
      goal: 'Inspect',
      workspaceRoot: '/repo',
      phases: [{ id: 'phase_1', title: 'Audit', order: 1 }],
      nodes: [node],
      edges: [],
      completionNodeIds: ['audit'],
      createdAt: '2026-07-27T00:00:00.000Z'
    }],
    nodes: {
      audit: {
        node,
        status: 'ready',
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
    createdAt: '2026-07-27T00:00:00.000Z',
    updatedAt: '2026-07-27T00:00:00.000Z'
  }
}

function fallbackAttempt(): GraphAttempt {
  return {
    id: 'attempt_1',
    attemptNumber: 1,
    status: 'running',
    childThreadId: 'thread_child',
    tokenUsage: 120,
    elapsedMs: 2_000,
    assignment: {
      profileId: 'ephemeral_audit',
      profileVersion: 1,
      profileOrigin: 'ephemeral',
      requestedProfileId: 'explore',
      requestedProfileVersion: 2,
      routingReason: 'The requested profile was unavailable; using a constrained fallback.',
      name: 'Audit fallback',
      systemPrompt: 'Inspect only the assigned node.',
      model: 'test-model',
      providerId: 'default',
      allowedModelProviderIds: ['default'],
      allowedModels: ['test-model'],
      allowedProviderIds: ['builtin'],
      reasoningEffort: 'medium',
      toolPolicy: 'readOnly',
      allowedTools: ['read'],
      blockedTools: [],
      allowedSkills: [],
      blockedSkills: [],
      allowedMcpServers: [],
      blockedMcpServers: [],
      approvalPolicy: 'on-request',
      sandboxMode: 'workspace-write',
      workspaceRoot: '/repo',
      readScopes: ['src'],
      writeScopes: [],
      networkAllowed: false,
      maxWallTimeMs: 60_000,
      capturedAt: '2026-07-27T00:00:00.000Z'
    }
  }
}
