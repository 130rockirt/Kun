import { describe, expect, it } from 'vitest'
import { replayGraphEvents } from './graph-reducer.js'
import {
  testGraphEnvelope,
  testGraphPlan
} from './graph-test-fixtures.test-support.js'
import { canonicalWorkerArtifactRefs } from './graph-artifact-policy.js'
import type { GraphArtifactReferenceV1 } from '../contracts/graph.js'

describe('Graph worker artifact policy', () => {
  it('accepts only host-published artifacts from the exact attempt', () => {
    const run = replayGraphEvents([
      testGraphEnvelope(1, {
        type: 'run_created',
        payload: {
          plan: testGraphPlan(),
          projectId: 'project_1',
          sourceTurnId: 'turn_1'
        }
      })
    ])
    const artifact: GraphArtifactReferenceV1 = {
      version: 1,
      artifactId: 'artifact_1',
      contentHash: 'a'.repeat(64),
      mimeType: 'text/plain',
      byteLength: 4,
      summary: 'safe',
      producerNodeId: 'research',
      producerAttemptId: 'attempt_1',
      visibility: 'dependency',
      retention: 'run',
      createdAt: '2026-07-26T00:00:00.000Z'
    }
    run.artifacts.push(artifact)
    expect(canonicalWorkerArtifactRefs(
      run,
      'research',
      'attempt_1',
      [artifact]
    )).toEqual([artifact])
    expect(() => canonicalWorkerArtifactRefs(
      run,
      'research',
      'attempt_other',
      [artifact]
    )).toThrow(/was not published/)
    expect(() => canonicalWorkerArtifactRefs(
      run,
      'research',
      'attempt_1',
      [{ ...artifact, contentHash: 'b'.repeat(64) }]
    )).toThrow(/metadata does not match/)
  })
})
