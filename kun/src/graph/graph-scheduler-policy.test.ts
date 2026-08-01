import { describe, expect, it } from 'vitest'
import type {
  GraphNodeAttemptV1,
  GraphNodeProjectionV1
} from '../contracts/graph.js'
import {
  GraphReviewResultV1Schema,
  GraphRunSummaryV1Schema
} from '../contracts/graph.js'
import { applyGraphEvent } from './graph-reducer.js'
import {
  dependencyDecision,
  deterministicReview,
  deterministicSummary,
  outcomeOf,
  parseWorkerResult,
  validationFailureSummary,
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

  it('does not invent a failed outcome for unfinished control predecessors', () => {
    const plan = testGraphPlan({
      edges: [{
        id: 'repair_on_failure',
        kind: 'control',
        from: 'research',
        to: 'finish',
        requiredOutcomes: ['failed']
      }]
    })
    const run = structuredClone(applyGraphEvent(undefined, testGraphEnvelope(1, {
      type: 'run_created',
      payload: { plan, projectId: 'project_1', sourceTurnId: 'turn_1' }
    })))

    for (const status of [
      'pending',
      'blocked',
      'ready',
      'queued',
      'running',
      'submitted',
      'reviewing'
    ] as const) {
      run.nodes.research.status = status
      expect(outcomeOf(run.nodes.research)).toBeUndefined()
      expect(dependencyDecision(run, plan.edges)).toBe('blocked')
    }

    run.nodes.research.status = 'failed'
    expect(outcomeOf(run.nodes.research)).toBe('failed')
    expect(dependencyDecision(run, plan.edges)).toBe('ready')
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

  it('projects host-only verification details out of the durable run summary', () => {
    const plan = testGraphPlan({
      nodes: [projection.node],
      edges: [],
      completionNodeIds: [projection.node.id]
    })
    const run = structuredClone(applyGraphEvent(undefined, testGraphEnvelope(1, {
      type: 'run_created',
      payload: { plan, projectId: 'project_1', sourceTurnId: 'turn_1' }
    })))
    const attempt: GraphNodeAttemptV1 = {
      ...baseAttempt,
      status: 'accepted',
      result: {
        version: 1,
        summary: 'Host verification completed.',
        artifactRefs: [],
        changedFiles: [],
        reportedChecks: [],
        verifiedChecks: [{
          name: 'verification',
          status: 'passed',
          summary: 'Host verification passed.',
          artifactRefs: [],
          command: ['npm', 'test'],
          exitCode: 0,
          workspaceRevision: 'abc123:clean',
          outputSummary: 'All tests passed.'
        }],
        evidence: ['host evidence'],
        risks: [],
        suggestedMessages: []
      }
    }
    run.nodes.research = {
      ...run.nodes.research,
      status: 'accepted',
      attempts: [attempt],
      acceptedAttemptId: attempt.id
    }

    const summary = deterministicSummary(run, '2026-07-26T12:00:00.000Z')

    expect(() => GraphRunSummaryV1Schema.parse(summary)).not.toThrow()
    expect(summary.validationResults).toEqual([{
      name: 'verification',
      status: 'passed',
      summary: 'Host verification passed.',
      artifactRefs: []
    }])
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

  it('bounds the persisted preview for the screenshot-sized normal prose result', () => {
    const fullResponse = '审'.repeat(4_311)
    const child = {
      ...testCompletedChild('child_long_prose', 'unused'),
      summary: fullResponse,
      evidence: undefined
    }

    const result = parseWorkerResult(child)

    expect(child.summary).toHaveLength(4_311)
    expect(result.summary).toHaveLength(4_096)
    expect(result.evidence).toHaveLength(1)
    expect(result.evidence[0]).toHaveLength(4_096)
    expect(result.evidence[0]).toMatch(/^Executor final response: /)
    expect(validateWorkerResult(projection, result).valid).toBe(true)
  })

  it('clips oversized structured optional fields instead of throwing', () => {
    const child = {
      ...testCompletedChild('child_long_structured', 'unused'),
      summary: JSON.stringify({
        summary: 'Structured result.',
        evidence: ['证'.repeat(12_000)],
        risks: Array.from({ length: 80 }, (_, index) => `risk-${index}-${'x'.repeat(5_000)}`)
      }),
      evidence: undefined
    }

    const result = parseWorkerResult(child)

    expect(result.summary).toBe('Structured result.')
    expect(result.evidence).toHaveLength(1)
    expect(result.evidence[0]).toHaveLength(4_096)
    expect(result.risks).toHaveLength(64)
    expect(result.risks.every((risk) => risk.length <= 4_096)).toBe(true)
  })

  it('aggregates hundreds of scope violations into a bounded validation issue', () => {
    const result = parseWorkerResult({
      ...testCompletedChild('child_many_files', 'unused'),
      summary: JSON.stringify({
        summary: 'Changed many files.',
        changedFiles: Array.from(
          { length: 600 },
          (_, index) => `outside/file-${index}.txt`
        )
      })
    })

    const validation = validateWorkerResult(projection, result)

    expect(validation.valid).toBe(false)
    expect(validation.issues).toEqual([
      expect.objectContaining({
        code: 'changed_file_outside_scope',
        severity: 'error'
      })
    ])
    expect(validation.issues[0]!.message.length).toBeLessThanOrEqual(2_048)
  })

  it('checks every host-observed file before the persisted preview is clipped', () => {
    const scopedProjection: GraphNodeProjectionV1 = {
      ...projection,
      node: {
        ...projection.node,
        writeScopes: ['src/allowed']
      }
    }
    const observedChangedFiles = [
      ...Array.from(
        { length: 1_000 },
        (_, index) => `src/allowed/file-${index}.txt`
      ),
      'outside/unauthorized.txt'
    ]
    const result = parseWorkerResult({
      ...testCompletedChild('child_host_files', 'unused'),
      summary: 'Done.'
    })

    const validation = validateWorkerResult(scopedProjection, result, {
      observedChangedFiles
    })

    expect(validation.valid).toBe(false)
    expect(validation.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        'observed_changed_files_overflow',
        'changed_file_outside_scope'
      ])
    )
    expect(validation.issues.find((issue) =>
      issue.code === 'changed_file_outside_scope')?.message
    ).toContain('outside/unauthorized.txt')
  })

  it('drops fabricated optional artifacts as a warning instead of throwing', () => {
    const result = parseWorkerResult({
      ...testCompletedChild('child_artifact_warning', 'unused'),
      summary: 'Done.'
    })
    const validation = validateWorkerResult(projection, result, {
      rejectedArtifactRefs: [{
        artifactId: 'fabricated_artifact',
        reason: 'not_published_by_attempt'
      }]
    })

    expect(validation.valid).toBe(true)
    expect(validation.issues).toEqual([
      expect.objectContaining({
        code: 'worker_artifact_ref_rejected',
        severity: 'warning',
        message: expect.stringContaining('fabricated_artifact')
      })
    ])
  })

  it('keeps deterministic review and transition summaries inside durable limits', () => {
    const validationIssues = Array.from({ length: 512 }, (_, index) => ({
      code: `issue_${index}`,
      path: ['changedFiles'],
      message: 'x'.repeat(2_048),
      severity: 'error' as const
    }))
    const artifactRefs = Array.from({ length: 128 }, (_, index) => ({
      version: 1 as const,
      artifactId: `artifact_${index}`,
      contentHash: index.toString(16).padStart(64, '0'),
      mimeType: `text/${'x'.repeat(300)}`,
      byteLength: 1,
      summary: 'artifact'.repeat(1_000),
      logicalNames: Array.from(
        { length: 140 },
        (_, logicalIndex) => `${'n'.repeat(300)}-${logicalIndex}`
      ),
      visibility: 'lead' as const,
      retention: 'run' as const,
      createdAt: '2026-07-26T00:00:00.000Z'
    }))
    const attempt: GraphNodeAttemptV1 = {
      ...baseAttempt,
      validation: {
        version: 1,
        valid: false,
        issues: validationIssues,
        normalizedNodeCount: 1,
        normalizedEdgeCount: 0
      },
      result: {
        version: 1,
        summary: 'Done.',
        artifactRefs,
        changedFiles: [],
        reportedChecks: [],
        verifiedChecks: Array.from({ length: 128 }, (_, index) => ({
          name: `verification_${index}`,
          status: 'failed' as const,
          summary: 'y'.repeat(4_096),
          artifactRefs: [],
          command: ['verify'],
          exitCode: 1,
          workspaceRevision: 'revision',
          outputSummary: 'failed'
        })),
        evidence: [],
        risks: [],
        suggestedMessages: []
      }
    }

    const review = deterministicReview(
      projection,
      attempt,
      'review_bounded',
      '2026-07-26T00:00:00.000Z'
    )

    expect(() => GraphReviewResultV1Schema.parse(review)).not.toThrow()
    expect(review.summary.length).toBeLessThanOrEqual(4_096)
    expect(review.evidence).toHaveLength(128)
    expect(review.evidence.every((entry) => entry.length <= 4_096)).toBe(true)
    expect(review.artifactRefs).toHaveLength(64)
    expect(review.artifactRefs[0]?.mimeType).toHaveLength(256)
    expect(review.artifactRefs[0]?.summary).toHaveLength(4_096)
    expect(review.artifactRefs[0]?.logicalNames).toHaveLength(128)
    expect(review.artifactRefs[0]?.logicalNames?.[0]).toHaveLength(256)
    expect(validationFailureSummary(attempt).length).toBeLessThanOrEqual(4_096)
  })
})
