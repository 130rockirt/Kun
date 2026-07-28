import { describe, expect, it } from 'vitest'
import type {
  GraphNodeAttemptV1,
  GraphNodeProjectionV1
} from '../contracts/graph.js'
import { applyGraphEvent } from './graph-reducer.js'
import {
  dependencyDecision,
  deterministicReview,
  parseWorkerResult,
  validateWorkerResult
} from './graph-scheduler-policy.js'
import {
  testAssignmentSnapshot,
  testCompletedChild,
  testGraphEnvelope,
  testGraphPlan
} from './graph-test-fixtures.test-support.js'

describe('Graph scheduler data dependencies', () => {
  it('requires source Lead acceptance but not worker artifact publication', () => {
    const plan = testGraphPlan({
      edges: [{
        id: 'research_output',
        kind: 'data',
        from: 'research',
        to: 'finish',
        artifactName: 'research-result',
        required: true
      }]
    })
    const created = applyGraphEvent(undefined, testGraphEnvelope(1, {
      type: 'run_created',
      payload: { plan, projectId: 'project_1', sourceTurnId: 'turn_1' }
    }))
    const run = structuredClone(created)
    const edge = plan.edges
    run.nodes.research.status = 'running'
    expect(dependencyDecision(run, edge)).toBe('blocked')

    run.nodes.research.status = 'accepted'
    expect(dependencyDecision(run, edge)).toBe('ready')
  })
})

describe('Graph deterministic evidence', () => {
  const projection = {
    node: {
      ...testGraphPlan().nodes[0]!,
      completion: {
        ...testGraphPlan().nodes[0]!.completion,
        review: {
          kinds: ['deterministic'] as const,
          requireAll: true,
          deterministicChecks: ['verification']
        }
      }
    },
    status: 'reviewing',
    attempts: [],
    loopIteration: 0
  } satisfies GraphNodeProjectionV1

  const baseAttempt = {
    version: 1,
    id: 'attempt_1',
    runId: 'run_1',
    nodeId: projection.node.id,
    revision: 1,
    attemptNumber: 1,
    iteration: 0,
    commandId: 'command_1',
    idempotencyKey: 'attempt_1',
    status: 'reviewing',
    assignment: testAssignmentSnapshot(),
    queuedAt: '2026-07-26T00:00:00.000Z',
    tokenUsage: 0,
    elapsedMs: 0,
    validation: {
      version: 1,
      valid: true,
      issues: [],
      normalizedNodeCount: 1,
      normalizedEdgeCount: 0
    }
  } satisfies GraphNodeAttemptV1

  it('does not accept a worker self-report as deterministic verification', () => {
    const attempt: GraphNodeAttemptV1 = {
      ...baseAttempt,
      result: {
        version: 1,
        summary: 'Done.',
        artifactRefs: [],
        changedFiles: [],
        reportedChecks: [{
          name: 'verification',
          status: 'passed',
          summary: 'Worker says it passed.',
          artifactRefs: []
        }],
        evidence: ['worker report'],
        risks: [],
        suggestedMessages: []
      }
    }
    expect(deterministicReview(
      projection,
      attempt,
      'review_1',
      '2026-07-26T00:00:00.000Z'
    ).outcome).toBe('revise')
  })

  it('accepts only host-captured command evidence at a workspace revision', () => {
    const attempt: GraphNodeAttemptV1 = {
      ...baseAttempt,
      result: {
        version: 1,
        summary: 'Done.',
        artifactRefs: [],
        changedFiles: [],
        reportedChecks: [],
        verifiedChecks: [{
          name: 'verification',
          status: 'passed',
          summary: 'Host verification passed.',
          artifactRefs: [],
          command: ['git', 'diff', '--check'],
          exitCode: 0,
          workspaceRevision: 'abc123:clean',
          outputSummary: 'No output.'
        }],
        evidence: ['host evidence'],
        risks: [],
        suggestedMessages: []
      }
    }
    expect(deterministicReview(
      projection,
      attempt,
      'review_2',
      '2026-07-26T00:00:00.000Z'
    ).outcome).toBe('pass')
  })

  it('treats an empty optional artifact list as valid executor output', () => {
    const result = validateWorkerResult(projection, {
      version: 1,
      summary: 'Done.',
      artifactRefs: [],
      changedFiles: [],
      reportedChecks: [],
      verifiedChecks: [],
      evidence: ['evidence'],
      risks: [],
      suggestedMessages: []
    })
    expect(result.valid).toBe(true)
    expect(result.issues).toEqual([])
  })

  it('accepts explicit empty change/risk arrays and normalizes string checks', () => {
    const allFieldsProjection: GraphNodeProjectionV1 = {
      ...projection,
      node: {
        ...projection.node,
        completion: {
          ...projection.node.completion,
          requiredResultFields: [
            'summary',
            'changedFiles',
            'checks',
            'evidence',
            'risks'
          ]
        }
      }
    }
    const child = {
      ...testCompletedChild('child_no_tools', 'unused'),
      summary: JSON.stringify({
        summary: 'PASS',
        changedFiles: [],
        checks: ['PASS'],
        evidence: ['No tools or files were used.'],
        risks: []
      }),
      evidence: undefined
    }
    const result = parseWorkerResult(child)
    expect(result.reportedChecks).toEqual([
      expect.objectContaining({
        name: 'PASS',
        status: 'not_run'
      })
    ])
    expect(validateWorkerResult(allFieldsProjection, result).valid).toBe(true)
  })
})
