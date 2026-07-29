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

  it('rejects worker-to-worker message flow in favor of Lead-approved data handoff', () => {
    const plan = testGraphPlan({
      edges: [{
        id: 'legacy_worker_message',
        kind: 'message',
        from: 'research',
        to: 'finish',
        allowedTypes: ['finding']
      }]
    })
    expect(validateGraphPlan(plan, testGraphConfig()).result.issues).toContainEqual(
      expect.objectContaining({ code: 'executor_message_edge_unsupported' })
    )
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
    ).result.valid).toBe(true)
  })

  it('rejects a bypass cycle even when the same component contains a LoopGate', () => {
    const base = testGraphPlan()
    const workA = { ...base.nodes[0]!, id: 'work_a' }
    const workB = { ...base.nodes[0]!, id: 'work_b' }
    const gate = {
      ...base.nodes[0]!,
      id: 'gate',
      kind: 'loop_gate' as const,
      loopGate: {
        maxIterations: 2,
        condition: { sourceNodeId: 'work_b', outcomeIn: ['repair_required'] as const },
        continueTargetNodeId: 'work_a',
        exitTargetNodeId: 'finish',
        exhaustionTargetNodeId: 'finish'
      }
    }
    const plan = GraphPlanV1Schema.parse({
      ...base,
      nodes: [{ ...base.nodes[0]!, id: 'start' }, workA, workB, gate, base.nodes[1]],
      edges: [
        { id: 'start_a', kind: 'control', from: 'start', to: 'work_a', requiredOutcomes: ['accepted'] },
        { id: 'a_b', kind: 'control', from: 'work_a', to: 'work_b', requiredOutcomes: ['accepted'] },
        { id: 'b_gate', kind: 'control', from: 'work_b', to: 'gate', requiredOutcomes: ['accepted'] },
        { id: 'bypass', kind: 'control', from: 'work_b', to: 'work_a', requiredOutcomes: ['repair_required'] },
        { id: 'continue', kind: 'control', from: 'gate', to: 'work_a', requiredOutcomes: ['repair_required'] },
        { id: 'exit', kind: 'control', from: 'gate', to: 'finish', requiredOutcomes: ['accepted'] }
      ]
    })

    expect(validateGraphPlan(plan, testGraphConfig()).result.issues)
      .toContainEqual(expect.objectContaining({ code: 'unbounded_cycle' }))
  })

  it('bounds duplicate-id diagnostics at the contract issue limit', () => {
    const base = testGraphPlan()
    const duplicated = GraphPlanV1Schema.parse({
      ...base,
      nodes: Array.from({ length: 600 }, () => ({ ...base.nodes[0]!, id: 'duplicate' })),
      edges: [],
      completionNodeIds: ['duplicate'],
      budget: { ...base.budget, maxNodes: 1_000 }
    })

    const result = validateGraphPlan(
      duplicated,
      testGraphConfig({ scheduler: { maxNodes: 1_000 } })
    ).result
    expect(result.valid).toBe(false)
    expect(result.issues).toHaveLength(512)
    expect(result.issues.every((issue) => issue.code === 'duplicate_node_id')).toBe(true)
  })

  it('validates a 10k-node chain without recursive traversal', () => {
    const base = testGraphPlan()
    const nodes = Array.from({ length: 10_000 }, (_, index) => ({
      ...base.nodes[index === 9_999 ? 1 : 0]!,
      id: `node_${index}`
    }))
    const edges = Array.from({ length: 9_999 }, (_, index) => ({
      id: `edge_${index}`,
      kind: 'control' as const,
      from: `node_${index}`,
      to: `node_${index + 1}`,
      requiredOutcomes: ['accepted'] as const
    }))
    const plan = GraphPlanV1Schema.parse({
      ...base,
      nodes,
      edges,
      completionNodeIds: ['node_9999'],
      budget: { ...base.budget, maxNodes: 10_000, maxEdges: 50_000 }
    })

    expect(validateGraphPlan(
      plan,
      testGraphConfig({ scheduler: { maxNodes: 10_000, maxEdges: 50_000 } })
    ).result.valid).toBe(true)
  })

  it('enforces every host budget boundary', () => {
    const plan = testGraphPlan({
      budget: {
        ...testGraphPlan().budget,
        maxConcurrentNodes: 99,
        maxArtifactBytes: 99_999_999_999
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
