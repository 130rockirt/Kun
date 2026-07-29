import { describe, expect, it } from 'vitest'
import { GraphIntentSchema, compileGraphIntent } from './graph-intent-compiler.js'
import { testGraphConfig } from './graph-test-fixtures.test-support.js'

const nowIso = '2026-07-29T00:00:00.000Z'

function compile(input: unknown) {
  const config = testGraphConfig()
  return compileGraphIntent({
    intent: GraphIntentSchema.parse(input),
    workspaceRoot: '/workspace',
    start: true,
    nowIso,
    config,
    budgetDefaults: {
      maxNodes: config.scheduler.maxNodes,
      maxEdges: config.scheduler.maxEdges,
      maxConcurrentNodes: config.scheduler.maxConcurrentNodesPerRun,
      maxAttemptsPerNode: config.scheduler.maxAttemptsPerNode,
      maxRevisions: config.scheduler.maxRevisions,
      maxLoopIterations: config.scheduler.maxLoopIterations,
      maxWallTimeMs: config.scheduler.maxRunWallTimeMs,
      maxNodeWallTimeMs: config.scheduler.maxNodeWallTimeMs,
      maxMessages: config.mailbox.maxMessagesPerRun,
      maxArtifactBytes: config.scheduler.maxArtifactBytes,
      warningRatio: config.scheduler.budgetWarningRatio
    }
  })
}

function task(id: string, patch: Record<string, unknown> = {}) {
  return {
    id,
    title: id,
    objective: `Complete ${id}.`,
    ...patch
  }
}

describe('compileGraphIntent', () => {
  it('resolves independent auto tasks to fan-out without serial edges', () => {
    const plan = compile({
      title: 'Parallel audit',
      goal: 'Audit independent areas.',
      strategy: 'auto',
      tasks: [task('api'), task('ui'), task('tests')]
    })

    expect(plan.strategy).toMatchObject({ kind: 'fanout_join', selectedBy: 'host' })
    expect(plan.edges).toEqual([])
    expect(plan.completionNodeIds).toEqual(['api', 'ui', 'tests'])
    expect(plan.nodes.every((node) => node.completion.review.kinds.includes('lead'))).toBe(true)
  })

  it('chains omitted pipeline dependencies and preserves data handoffs', () => {
    const pipeline = compile({
      title: 'Pipeline',
      goal: 'Run ordered work.',
      strategy: 'pipeline',
      tasks: [task('inspect'), task('implement'), task('verify')]
    })
    expect(pipeline.edges.map((edge) => [edge.from, edge.to])).toEqual([
      ['inspect', 'implement'],
      ['implement', 'verify']
    ])

    const hybrid = compile({
      title: 'Hybrid',
      goal: 'Fan out and integrate.',
      strategy: 'hybrid',
      tasks: [
        task('api'),
        task('ui'),
        task('integrate', {
          dataFrom: [
            { taskId: 'api', name: 'api-result' },
            { taskId: 'ui', name: 'ui-result' }
          ]
        })
      ]
    })
    expect(hybrid.strategy?.kind).toBe('hybrid')
    expect(hybrid.edges).toEqual([
      expect.objectContaining({ kind: 'data', from: 'api', to: 'integrate' }),
      expect.objectContaining({ kind: 'data', from: 'ui', to: 'integrate' })
    ])
    expect(hybrid.completionNodeIds).toEqual(['integrate'])
  })

  it('records explicit state-machine strategy and rejects invalid references', () => {
    const plan = compile({
      title: 'States',
      goal: 'Move through explicit states.',
      strategy: 'state_machine',
      tasks: [
        task('discover'),
        task('design', { dependsOn: ['discover'] }),
        task('evaluate', { dependsOn: ['design'], required: false })
      ],
      completionTaskIds: ['evaluate']
    })
    expect(plan.strategy).toMatchObject({ kind: 'state_machine', selectedBy: 'lead' })

    expect(() => GraphIntentSchema.parse({
      title: 'Invalid',
      goal: 'Reject invalid ids.',
      tasks: [task('only', { dependsOn: ['missing'] })]
    })).toThrow(/dependency task missing does not exist/)
  })

  it('requires an explicit loop gate for bounded-loop strategy', () => {
    expect(() => GraphIntentSchema.parse({
      title: 'Loop',
      goal: 'Iterate.',
      strategy: 'bounded_loop',
      tasks: [task('work')]
    })).toThrow(/requires at least one loop_gate task/)
  })
})
