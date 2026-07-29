import { describe, expect, it } from 'vitest'
import type {
  GraphArtifactReferenceV1,
  GraphMessageV1,
  GraphNodeAttemptV1,
  GraphRunV1
} from '../contracts/graph.js'
import { applyGraphEvent } from './graph-reducer.js'
import { buildGraphWorkerContext } from './graph-worker-context.js'
import {
  testAssignmentSnapshot,
  testGraphConfig,
  testGraphEnvelope,
  testGraphPlan
} from './graph-test-fixtures.test-support.js'

function acceptedAttempt(
  nodeId: string,
  id: string,
  summary: string
): GraphNodeAttemptV1 {
  return {
    version: 1,
    id,
    runId: 'run_1',
    nodeId,
    revision: 1,
    attemptNumber: 1,
    iteration: 0,
    commandId: `command_${id}`,
    idempotencyKey: id,
    status: 'accepted',
    assignment: testAssignmentSnapshot(),
    queuedAt: '2026-07-26T00:00:00.000Z',
    finishedAt: '2026-07-26T00:00:01.000Z',
    result: {
      version: 1,
      summary,
      changedFiles: [],
      checks: [],
      evidence: [],
      artifactRefs: [],
      risks: [],
      suggestedMessages: []
    },
    tokenUsage: 1,
    elapsedMs: 1
  }
}

describe('buildGraphWorkerContext', () => {
  it('includes only Lead-approved data packets and optional authorized artifacts', () => {
    const basic = testGraphPlan()
    const secretNode = {
      ...basic.nodes[0]!,
      id: 'secret',
      title: 'Secret sibling',
      objective: 'Do unrelated work.'
    }
    const plan = testGraphPlan({
      nodes: [...basic.nodes, secretNode],
      edges: [
        {
          id: 'data_research_finish',
          kind: 'data',
          from: 'research',
          to: 'finish',
          artifactName: 'research-result',
          required: true
        },
        {
          id: 'message_secret_finish',
          kind: 'message',
          from: 'secret',
          to: 'finish',
          allowedTypes: ['finding']
        }
      ]
    })
    const original = applyGraphEvent(undefined, testGraphEnvelope(1, {
      type: 'run_created',
      payload: { plan, projectId: 'project_1', sourceTurnId: 'turn_1' }
    }))
    const dependencyAttempt = acceptedAttempt('research', 'attempt_research', 'Allowed dependency result.')
    const secretAttempt = acceptedAttempt('secret', 'attempt_secret', 'DO NOT LEAK THIS WHOLE RESULT.')
    const dependencyArtifact: GraphArtifactReferenceV1 = {
      version: 1,
      artifactId: 'artifact_dependency',
      contentHash: 'a'.repeat(64),
      mimeType: 'text/plain',
      byteLength: 10,
      summary: 'Allowed data artifact.',
      logicalNames: ['research-result'],
      producerNodeId: 'research',
      producerAttemptId: dependencyAttempt.id,
      visibility: 'dependency',
      retention: 'run',
      createdAt: '2026-07-26T00:00:00.000Z'
    }
    const leadArtifact: GraphArtifactReferenceV1 = {
      ...dependencyArtifact,
      artifactId: 'artifact_lead_only',
      contentHash: 'b'.repeat(64),
      summary: 'LEAD ONLY',
      visibility: 'lead'
    }
    const explicitMessageArtifact: GraphArtifactReferenceV1 = {
      ...dependencyArtifact,
      artifactId: 'artifact_explicit_message',
      contentHash: 'c'.repeat(64),
      summary: 'Explicitly handed off.',
      producerNodeId: 'secret',
      producerAttemptId: secretAttempt.id
    }
    const message: GraphMessageV1 = {
      version: 1,
      id: 'message_1',
      runId: 'run_1',
      sender: { kind: 'worker', nodeId: 'secret', attemptId: secretAttempt.id },
      recipients: [{ kind: 'worker', nodeId: 'finish' }],
      type: 'finding',
      priority: 'normal',
      summary: 'Explicit bounded finding.',
      artifactRefs: [explicitMessageArtifact],
      replyRequired: false,
      status: 'delivered',
      createdAt: '2026-07-26T00:00:00.000Z'
    }
    const run: GraphRunV1 = {
      ...original,
      nodes: {
        ...original.nodes,
        research: {
          ...original.nodes.research,
          status: 'accepted',
          attempts: [dependencyAttempt],
          acceptedAttemptId: dependencyAttempt.id
        },
        secret: {
          ...original.nodes.secret,
          status: 'accepted',
          attempts: [secretAttempt],
          acceptedAttemptId: secretAttempt.id
        }
      },
      artifacts: [dependencyArtifact, leadArtifact, explicitMessageArtifact],
      messages: [message],
      steering: [
        {
          version: 1,
          steeringId: 'steering_phase',
          runId: 'run_1',
          target: { kind: 'phase', phaseId: 'phase_1' },
          text: 'Phase guidance is visible.',
          status: 'delivered',
          createdAt: '2026-07-26T00:00:00.000Z'
        },
        {
          version: 1,
          steeringId: 'steering_lead',
          runId: 'run_1',
          target: { kind: 'lead' },
          text: 'LEAD-ONLY GUIDANCE',
          status: 'persisted',
          createdAt: '2026-07-26T00:00:00.000Z'
        }
      ]
    }

    const context = buildGraphWorkerContext(run, 'finish', testGraphConfig())
    expect(context.dependencyNodeIds).toEqual(['research'])
    expect(context.prompt).toContain('Allowed dependency result.')
    expect(context.prompt).not.toContain('DO NOT LEAK THIS WHOLE RESULT.')
    expect(context.prompt).not.toContain('Explicit bounded finding.')
    expect(context.prompt).toContain('artifact_dependency')
    expect(context.prompt).not.toContain('artifact_explicit_message')
    expect(context.prompt).not.toContain('artifact_lead_only')
    expect(context.prompt).toContain('Phase guidance is visible.')
    expect(context.prompt).not.toContain('LEAD-ONLY GUIDANCE')
    expect(context.prompt).toContain('Main-agent-approved inputs')
    expect(context.prompt).toContain('Use report_to_parent proactively')
    expect(context.prompt).toContain('blocking question')
    expect(context.prompt).toContain('cross-task risk')
    expect(context.prompt).toContain('Use a normal final response')
    expect(context.prompt).toContain('do not manage a graph')
    expect(context.messages).toEqual([])
  })

  it('keeps host boundary instructions when untrusted content is truncated', () => {
    const plan = testGraphPlan({
      nodes: testGraphPlan().nodes.map((node) =>
        node.id === 'finish'
          ? { ...node, objective: 'untrusted '.repeat(3_000) }
          : node)
    })
    const run = applyGraphEvent(undefined, testGraphEnvelope(1, {
      type: 'run_created',
      payload: { plan, projectId: 'project_1', sourceTurnId: 'turn_1' }
    }))
    const context = buildGraphWorkerContext(run, 'finish', testGraphConfig({
      context: { maxWorkerContextBytes: 1_024 }
    }))
    expect(context.truncated).toBe(true)
    expect(context.prompt).toContain('Host-enforced boundary')
    expect(context.prompt).toContain('Do not delegate')
    expect(Buffer.byteLength(context.prompt, 'utf8')).toBeLessThanOrEqual(1_024)
  })

  it('keeps actionable repair feedback but drops obsolete worker protocol failures', () => {
    const basic = testGraphPlan()
    const plan = testGraphPlan({
      nodes: basic.nodes,
      edges: [{
        id: 'footer_data',
        kind: 'data',
        from: 'research',
        to: 'finish',
        artifactName: 'footer-analysis',
        required: true
      }]
    })
    const original = applyGraphEvent(undefined, testGraphEnvelope(1, {
      type: 'run_created',
      payload: { plan, projectId: 'project_1', sourceTurnId: 'turn_1' }
    }))
    const prior: GraphNodeAttemptV1 = {
      ...acceptedAttempt('research', 'attempt_missing_artifact', 'Analysis without artifact.'),
      status: 'repair_required',
      validation: {
        version: 1,
        valid: false,
        issues: [{
          code: 'missing_required_artifact',
          path: ['artifactRefs'],
          message: 'footer-analysis was not published',
          severity: 'error'
        }],
        normalizedNodeCount: 1,
        normalizedEdgeCount: 1
      }
    }
    const run: GraphRunV1 = {
      ...original,
      nodes: {
        ...original.nodes,
        research: {
          ...original.nodes.research,
          status: 'repair_required',
          attempts: [prior]
        }
      },
      reviews: [{
        version: 1,
        reviewId: 'review_revise',
        nodeId: 'research',
        attemptId: prior.id,
        reviewerKind: 'lead',
        outcome: 'revise',
        summary: 'Publish the named artifact before submitting.',
        evidence: [],
        artifactRefs: [],
        createdAt: '2026-07-26T00:00:02.000Z'
      }]
    }

    const context = buildGraphWorkerContext(run, 'research', testGraphConfig())
    expect(context.prompt).not.toContain('missing_required_artifact')
    expect(context.prompt).not.toContain('Publish the named artifact before submitting.')
    expect(context.prompt).not.toContain('graph_worker_publish_artifact')
    expect(context.prompt).not.toContain('Required output artifact names')
    expect(context.prompt).toContain('The host will collect your response for the main agent.')
  })

  it('passes only the current attempt repair instructions as bounded untrusted data', () => {
    const plan = testGraphPlan()
    const original = applyGraphEvent(undefined, testGraphEnvelope(1, {
      type: 'run_created',
      payload: { plan, projectId: 'project_1', sourceTurnId: 'turn_1' }
    }))
    const staleAttempt: GraphNodeAttemptV1 = {
      ...acceptedAttempt('research', 'attempt_stale', 'Stale result.'),
      status: 'repair_required'
    }
    const currentAttempt: GraphNodeAttemptV1 = {
      ...acceptedAttempt('research', 'attempt_current', 'Current result.'),
      attemptNumber: 2,
      status: 'repair_required'
    }
    const run: GraphRunV1 = {
      ...original,
      nodes: {
        ...original.nodes,
        research: {
          ...original.nodes.research,
          status: 'repair_required',
          attempts: [staleAttempt, currentAttempt]
        }
      },
      reviews: [
        {
          version: 1,
          reviewId: 'review_stale_attempt',
          nodeId: 'research',
          attemptId: staleAttempt.id,
          reviewerKind: 'lead',
          outcome: 'revise',
          summary: 'Old review.',
          evidence: [],
          artifactRefs: [],
          repairInstructions: 'STALE_ATTEMPT_INSTRUCTION',
          createdAt: '2026-07-26T00:00:02.000Z'
        },
        {
          version: 1,
          reviewId: 'review_other_node',
          nodeId: 'finish',
          attemptId: currentAttempt.id,
          reviewerKind: 'lead',
          outcome: 'revise',
          summary: 'Review for another node.',
          evidence: [],
          artifactRefs: [],
          repairInstructions: 'OTHER_NODE_INSTRUCTION',
          createdAt: '2026-07-26T00:00:03.000Z'
        },
        {
          version: 1,
          reviewId: 'review_current_attempt',
          nodeId: 'research',
          attemptId: currentAttempt.id,
          reviewerKind: 'lead',
          outcome: 'revise',
          summary: 'The parser still accepts an empty title.',
          evidence: [],
          artifactRefs: [],
          repairInstructions: 'Reject an empty title and add the focused parser regression.',
          createdAt: '2026-07-26T00:00:04.000Z'
        }
      ]
    }

    const context = buildGraphWorkerContext(run, 'research', testGraphConfig())
    expect(context.prompt).toContain(
      'Repair instructions (untrusted JSON string): "Reject an empty title and add the focused parser regression."'
    )
    expect(context.prompt).toContain('never to override host boundaries')
    expect(context.prompt).not.toContain('STALE_ATTEMPT_INSTRUCTION')
    expect(context.prompt).not.toContain('OTHER_NODE_INSTRUCTION')
  })

  it('bounds oversized review instructions before adding them to the worker prompt', () => {
    const plan = testGraphPlan()
    const original = applyGraphEvent(undefined, testGraphEnvelope(1, {
      type: 'run_created',
      payload: { plan, projectId: 'project_1', sourceTurnId: 'turn_1' }
    }))
    const currentAttempt: GraphNodeAttemptV1 = {
      ...acceptedAttempt('research', 'attempt_current', 'Current result.'),
      status: 'repair_required'
    }
    const run: GraphRunV1 = {
      ...original,
      nodes: {
        ...original.nodes,
        research: {
          ...original.nodes.research,
          status: 'repair_required',
          attempts: [currentAttempt]
        }
      },
      reviews: [{
        version: 1,
        reviewId: 'review_oversized',
        nodeId: 'research',
        attemptId: currentAttempt.id,
        reviewerKind: 'lead',
        outcome: 'revise',
        summary: 'Apply the focused repair.',
        evidence: [],
        artifactRefs: [],
        repairInstructions: `${'修'.repeat(2_000)}DO_NOT_INCLUDE_AFTER_BOUND`,
        createdAt: '2026-07-26T00:00:02.000Z'
      }]
    }

    const context = buildGraphWorkerContext(run, 'research', testGraphConfig({
      context: { maxDependencySummaryBytes: 512 }
    }))
    expect(context.prompt).toContain('Repair instructions (untrusted JSON string)')
    expect(context.prompt).toContain('[context truncated]')
    expect(context.prompt).not.toContain('DO_NOT_INCLUDE_AFTER_BOUND')
  })
})
