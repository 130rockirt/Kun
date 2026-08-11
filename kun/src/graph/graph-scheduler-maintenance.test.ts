import { describe, expect, it, vi } from 'vitest'
import { applyGraphEvent } from './graph-reducer.js'
import { enforceGraphBudgets } from './graph-scheduler-maintenance.js'
import {
  TEST_GRAPH_NOW,
  testGraphEnvelope,
  testGraphPlan
} from './graph-test-fixtures.test-support.js'

describe('Graph scheduler budget maintenance', () => {
  it('allows a GraphRun with a zero artifact budget before any artifacts are published', async () => {
    const defaultPlan = testGraphPlan()
    const plan = testGraphPlan({
      budget: { ...defaultPlan.budget, maxArtifactBytes: 0 }
    })
    const run = applyGraphEvent(undefined, testGraphEnvelope(1, {
      type: 'run_created',
      payload: { plan, projectId: 'project_1', sourceTurnId: 'turn_1' }
    }))
    const updateBudget = vi.fn(async () => run)
    const failForBudget = vi.fn(async () => run)
    const append = vi.fn(async () => run)
    const requestSupervision = vi.fn(async () => undefined)

    const result = await enforceGraphBudgets(run, {
      nowIso: () => TEST_GRAPH_NOW,
      updateBudget,
      failForBudget,
      append,
      requestSupervision
    })

    expect(result).toBe(run)
    expect(run.budget.artifactBytes).toBe(0)
    expect(run.budget.limits.maxArtifactBytes).toBe(0)
    expect(failForBudget).not.toHaveBeenCalled()
    expect(updateBudget).not.toHaveBeenCalled()
    expect(append).not.toHaveBeenCalled()
    expect(requestSupervision).not.toHaveBeenCalled()
  })
})
