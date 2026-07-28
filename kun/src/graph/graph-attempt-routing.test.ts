import { describe, expect, it, vi } from 'vitest'
import { applyGraphEvent } from './graph-reducer.js'
import { resolveGraphAttemptAssignment } from './graph-attempt-routing.js'
import {
  testAssignmentSnapshot,
  testGraphConfig,
  testGraphEnvelope,
  testGraphPlan
} from './graph-test-fixtures.test-support.js'

function runningPlan() {
  return applyGraphEvent(undefined, testGraphEnvelope(1, {
    type: 'run_created',
    payload: {
      plan: testGraphPlan(),
      projectId: 'project_1',
      sourceTurnId: 'turn_1'
    }
  }))
}

describe('resolveGraphAttemptAssignment', () => {
  it('preserves explicit plan and node wall-time limits below the 24-hour host default', async () => {
    const run = runningPlan()
    const resolve = vi.fn(async () => testAssignmentSnapshot())
    const options = {
      authorityForRun: vi.fn(async () => ({})),
      assignments: { resolve },
      config: () => testGraphConfig({
        scheduler: { maxNodeWallTimeMs: 24 * 60 * 60_000 }
      })
    } as never

    await resolveGraphAttemptAssignment(options, run, run.nodes.research)
    expect(resolve).toHaveBeenLastCalledWith(expect.objectContaining({
      maxWallTimeMs: 30 * 60_000
    }))

    await resolveGraphAttemptAssignment(options, run, {
      ...run.nodes.research,
      node: {
        ...run.nodes.research.node,
        timeoutMs: 10 * 60_000
      }
    })
    expect(resolve).toHaveBeenLastCalledWith(expect.objectContaining({
      maxWallTimeMs: 10 * 60_000
    }))
  })
})
