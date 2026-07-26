import { describe, expect, it } from 'vitest'
import type { GraphArtifactReferenceV1 } from '../contracts/graph.js'
import { applyGraphEvent } from './graph-reducer.js'
import { dependencyDecision } from './graph-scheduler-policy.js'
import {
  testGraphEnvelope,
  testGraphPlan
} from './graph-test-fixtures.test-support.js'

describe('Graph scheduler data dependencies', () => {
  it('requires an accepted source and the exact declared artifact name', () => {
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
    const artifact: GraphArtifactReferenceV1 = {
      version: 1,
      artifactId: 'artifact_research',
      contentHash: 'a'.repeat(64),
      mimeType: 'application/json',
      byteLength: 10,
      summary: 'Research result.',
      logicalNames: ['research-result'],
      producerNodeId: 'research',
      producerAttemptId: 'attempt_research',
      visibility: 'dependency',
      retention: 'run',
      createdAt: '2026-07-26T00:00:00.000Z'
    }

    run.nodes.research.status = 'running'
    run.artifacts = [artifact]
    expect(dependencyDecision(run, edge)).toBe('blocked')

    run.nodes.research.status = 'accepted'
    run.artifacts = [{ ...artifact, logicalNames: ['some-other-result'] }]
    expect(dependencyDecision(run, edge)).toBe('unsatisfiable')

    run.artifacts = [artifact]
    expect(dependencyDecision(run, edge)).toBe('ready')
  })
})
