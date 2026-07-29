import { describe, expect, it } from 'vitest'
import {
  GRAPH_CONTRACT_VERSION,
  GraphPatchV1Schema
} from '../contracts/graph.js'
import { applyPatchToPlan } from './graph-patch-service.js'
import { applyGraphEvent, replayGraphEvents } from './graph-reducer.js'
import {
  TEST_GRAPH_NOW,
  testGraphEnvelope,
  testGraphPlan
} from './graph-test-fixtures.test-support.js'

describe('Graph patch service', () => {
  it('atomically redirects exhausted terminal work to a zero-attempt replacement', () => {
    const base = testGraphPlan()
    const loopGate = {
      id: 'quality_gate',
      phaseId: 'phase_1',
      kind: 'loop_gate' as const,
      title: 'Quality gate',
      objective: 'Route the bounded result.',
      priority: 0,
      required: true,
      riskClass: 'low' as const,
      completion: {
        requiredResultFields: ['summary' as const],
        acceptanceCriteria: ['The gate routes the result.'],
        review: {
          kinds: ['lead' as const],
          requireAll: true,
          deterministicChecks: []
        }
      },
      readScopes: [],
      writeScopes: [],
      loopGate: {
        maxIterations: 2,
        condition: {
          sourceNodeId: 'research',
          outcomeIn: ['repair_required' as const]
        },
        continueTargetNodeId: 'research',
        exitTargetNodeId: 'finish'
      },
      metadata: {}
    }
    const plan = testGraphPlan({
      nodes: [...base.nodes, loopGate],
      completionNodeIds: ['research']
    })
    const run = replayGraphEvents([
      testGraphEnvelope(1, {
        type: 'run_created',
        payload: { plan, projectId: 'project_1', sourceTurnId: 'turn_1' }
      })
    ])
    run.nodes.research.status = 'failed'
    run.nodes.finish.status = 'blocked'
    const replacement = {
      ...run.nodes.research.node,
      id: 'research_v2',
      title: 'Recovered research'
    }
    const patch = GraphPatchV1Schema.parse({
      version: GRAPH_CONTRACT_VERSION,
      patchId: 'patch_recover_failed',
      commandId: 'command_recover_failed',
      runId: run.id,
      baseRevision: run.currentRevision,
      requester: { kind: 'lead', id: 'turn_1' },
      reason: 'Replace exhausted host-failed work.',
      operations: [{
        op: 'replace_node',
        nodeId: 'research',
        replacement,
        supersedesAcceptedWork: false
      }],
      createdAt: TEST_GRAPH_NOW
    })

    run.nodes.finish.status = 'running'
    expect(() => applyPatchToPlan(run, patch, TEST_GRAPH_NOW))
      .toThrow(/affected node finish reached running/)
    run.nodes.finish.status = 'blocked'

    const revised = applyPatchToPlan(run, patch, TEST_GRAPH_NOW)

    expect(revised.supersededNodeIds).toEqual(['research'])
    expect(revised.plan.edges[0]).toMatchObject({
      from: 'research_v2',
      to: 'finish'
    })
    expect(revised.plan.completionNodeIds).toEqual(['research_v2'])
    expect(
      revised.plan.nodes.find((node) => node.id === 'quality_gate')?.loopGate
    ).toMatchObject({
      condition: { sourceNodeId: 'research_v2' },
      continueTargetNodeId: 'research_v2',
      exitTargetNodeId: 'finish'
    })

    const reduced = applyGraphEvent(run, testGraphEnvelope(2, {
      type: 'plan_revised',
      payload: {
        patch,
        plan: revised.plan,
        supersededNodeIds: revised.supersededNodeIds
      }
    }, { graphRevision: 2 }))
    expect(reduced.nodes.research.status).toBe('superseded')
    expect(reduced.nodes.research_v2).toMatchObject({
      status: 'pending',
      attempts: []
    })
  })
})
