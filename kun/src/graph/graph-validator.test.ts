import { describe, expect, it } from 'vitest'
import { GraphPlanV1Schema } from '../contracts/graph.js'
import { parseAndValidateGraphPlan, validateGraphPlan } from './graph-validator.js'
import { testGraphConfig, testGraphPlan } from './graph-test-fixtures.test-support.js'

describe('GraphPlan host validation', () => {
  it('accepts a bounded reachable DAG', () => {
    const validation = validateGraphPlan(testGraphPlan(), testGraphConfig())
    expect(validation.result).toMatchObject({
      valid: true,
      normalizedNodeCount: 2,
      normalizedEdgeCount: 1
    })
    expect(validation.plan?.title).toBe('Test graph')
  })

  it('rejects Graph creation while disabled', () => {
    const validation = validateGraphPlan(testGraphPlan(), testGraphConfig({ enabled: false }))
    expect(validation.result.valid).toBe(false)
    expect(validation.result.issues).toContainEqual(expect.objectContaining({ code: 'graph_disabled' }))
  })

  it('reports schema, identity, reference, reachability, and terminal errors', () => {
    const base = testGraphPlan()
    const input = {
      ...base,
      nodes: [
        base.nodes[0],
        { ...base.nodes[1], id: 'research', phaseId: 'missing_phase' },
        { ...base.nodes[1], id: 'orphan' }
      ],
      edges: [
        ...base.edges,
        { id: 'edge_1', kind: 'control', from: 'missing', to: 'orphan', requiredOutcomes: ['accepted'] },
        { id: 'orphan_self', kind: 'control', from: 'orphan', to: 'orphan', requiredOutcomes: ['accepted'] }
      ],
      completionNodeIds: ['research', 'missing']
    }
    const parsed = GraphPlanV1Schema.parse(input)
    const validation = validateGraphPlan(parsed, testGraphConfig())
    const codes = validation.result.issues.map((issue) => issue.code)
    expect(codes).toEqual(expect.arrayContaining([
      'duplicate_node_id',
      'duplicate_edge_id',
      'missing_phase',
      'missing_edge_source',
      'missing_completion_node',
      'completion_node_not_terminal',
      'unreachable_required_node'
    ]))
  })

  it('rejects unbounded cycles and accepts an explicit bounded LoopGate', () => {
    const base = testGraphPlan()
    const unbounded = GraphPlanV1Schema.parse({
      ...base,
      edges: [
        ...base.edges,
        { id: 'edge_back', kind: 'control', from: 'finish', to: 'research', requiredOutcomes: ['accepted'] }
      ],
      completionNodeIds: ['finish']
    })
    expect(validateGraphPlan(unbounded, testGraphConfig()).result.issues)
      .toContainEqual(expect.objectContaining({ code: 'unbounded_cycle' }))

    const loopGate = {
      ...base.nodes[0],
      id: 'gate',
      kind: 'loop_gate' as const,
      title: 'Repair gate',
      loopGate: {
        maxIterations: 2,
        condition: { sourceNodeId: 'research', outcomeIn: ['repair_required'] as const },
        continueTargetNodeId: 'research',
        exitTargetNodeId: 'finish',
        exhaustionTargetNodeId: 'finish'
      }
    }
    const start = {
      ...base.nodes[0],
      id: 'start',
      title: 'Start',
      objective: 'Prepare the first repair attempt.'
    }
    const bounded = GraphPlanV1Schema.parse({
      ...base,
      nodes: [start, base.nodes[0], loopGate, base.nodes[1]],
      edges: [
        { id: 'start_research', kind: 'control', from: 'start', to: 'research', requiredOutcomes: ['accepted'] },
        { id: 'to_gate', kind: 'control', from: 'research', to: 'gate', requiredOutcomes: ['accepted'] },
        { id: 'loop_back', kind: 'control', from: 'gate', to: 'research', requiredOutcomes: ['repair_required'] },
        { id: 'loop_exit', kind: 'control', from: 'gate', to: 'finish', requiredOutcomes: ['accepted'] }
      ]
    })
    expect(validateGraphPlan(bounded, testGraphConfig()).result.valid).toBe(true)
    expect(validateGraphPlan(
      bounded,
      testGraphConfig({ rolloutStage: 'alpha' })
    ).result.issues).toContainEqual(expect.objectContaining({
      code: 'rollout_loop_not_enabled'
    }))
  })

  it('enforces every host budget boundary', () => {
    const plan = testGraphPlan({
      budget: {
        ...testGraphPlan().budget,
        maxConcurrentNodes: 99,
        maxArtifactBytes: 999_999_999_999
      }
    })
    const validation = validateGraphPlan(plan, testGraphConfig({
      scheduler: { maxConcurrentNodesPerRun: 2, maxArtifactBytes: 1_000 }
    }))
    expect(validation.result.issues.filter((issue) => issue.code === 'budget_exceeds_host_limit'))
      .toHaveLength(2)
  })

  it('returns bounded schema errors for malformed input', () => {
    const validation = parseAndValidateGraphPlan({ version: 99, nodes: [] }, testGraphConfig())
    expect(validation.result.valid).toBe(false)
    expect(validation.result.issues[0]).toMatchObject({ code: 'schema_invalid' })
  })
})
