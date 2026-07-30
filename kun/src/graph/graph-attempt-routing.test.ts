import { describe, expect, it, vi } from 'vitest'
import { applyGraphEvent } from './graph-reducer.js'
import { resolveGraphAttemptAssignment } from './graph-attempt-routing.js'
import { GraphAssignmentResolver, type GraphParentAuthority } from './graph-assignment.js'
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

function implicitPlan() {
  const plan = testGraphPlan()
  const research = plan.nodes[0]!
  const { assignment: _assignment, ...implicitResearch } = research
  return applyGraphEvent(undefined, testGraphEnvelope(1, {
    type: 'run_created',
    payload: {
      plan: testGraphPlan({
        nodes: [implicitResearch, plan.nodes[1]!]
      }),
      projectId: 'project_1',
      sourceTurnId: 'turn_1'
    }
  }))
}

const parent: GraphParentAuthority = {
  workspaceRoot: '/workspace',
  model: 'lead-model',
  providerId: 'lead-provider',
  allowedModelProviderIds: ['lead-provider', 'worker-provider'],
  allowedModels: ['lead-model', 'worker-model'],
  allowedProviderIds: ['builtin'],
  reasoningEffort: 'medium',
  approvalPolicy: 'never',
  sandboxMode: 'read-only',
  allowedTools: ['read'],
  blockedTools: [],
  allowedSkills: [],
  blockedSkills: [],
  allowedMcpServers: [],
  blockedMcpServers: [],
  readScopes: ['.'],
  writeScopes: [],
  networkAllowed: false
}

describe('resolveGraphAttemptAssignment', () => {
  it('preserves explicit plan and node wall-time limits below the 24-hour host default', async () => {
    const run = runningPlan()
    const resolve = vi.fn(async (_input: { reference: unknown }) =>
      testAssignmentSnapshot())
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

  it('uses the configured model only for an implicit ephemeral assignment', async () => {
    const run = implicitPlan()
    const resolve = vi.fn(async (_input: { reference: unknown }) =>
      testAssignmentSnapshot())
    const options = {
      authorityForRun: async () => parent,
      registry: {
        identify: async () => {
          throw new Error('routing unavailable')
        }
      },
      assignments: { resolve },
      config: () => testGraphConfig({
        workerModel: {
          mode: 'fixed',
          providerId: 'worker-provider',
          model: 'worker-model',
          reasoningEffort: 'high'
        }
      })
    } as never

    await resolveGraphAttemptAssignment(options, run, run.nodes.research)
    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({
      reference: expect.objectContaining({
        kind: 'ephemeral',
        model: 'worker-model',
        providerId: 'worker-provider',
        reasoningEffort: 'high'
      })
    }))

    const explicitRun = runningPlan()
    await resolveGraphAttemptAssignment(options, explicitRun, explicitRun.nodes.research)
    expect(resolve.mock.calls.at(-1)?.[0].reference)
      .toEqual(explicitRun.nodes.research.node.assignment)
  })

  it('fails closed when a configured worker model is outside parent authority', async () => {
    const run = implicitPlan()
    const narrowParent = {
      ...parent,
      allowedModelProviderIds: ['lead-provider'],
      allowedModels: ['lead-model']
    }
    const registry = {
      identify: async () => {
        throw new Error('routing unavailable')
      },
      getProfile: async () => null
    }
    const options = {
      authorityForRun: async () => narrowParent,
      registry,
      assignments: new GraphAssignmentResolver({ registry: registry as never }),
      config: () => testGraphConfig({
        workerModel: {
          mode: 'fixed',
          providerId: 'worker-provider',
          model: 'worker-model'
        }
      })
    } as never

    await expect(resolveGraphAttemptAssignment(
      options,
      run,
      run.nodes.research
    )).rejects.toThrow(/expands parent authority/)
  })
})
