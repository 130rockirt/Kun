import { describe, expect, it } from 'vitest'
import {
  GraphIntentSchema,
  GraphPlanIntentV2Schema,
  compileGraphIntent,
  compileGraphPlanIntentV2
} from './graph-intent-compiler.js'
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

function planTask(key: string, patch: Record<string, unknown> = {}) {
  return {
    key,
    kind: 'work',
    title: key,
    objective: `Complete ${key}.`,
    dependsOn: [],
    dataFrom: [],
    acceptanceCriteria: [`${key} is complete.`],
    readScopes: ['.'],
    writeScopes: [],
    ...patch
  }
}

function compileV2(input: unknown) {
  const config = testGraphConfig()
  return compileGraphPlanIntentV2({
    intent: GraphPlanIntentV2Schema.parse(input),
    goal: 'Implement and verify the requested change.',
    workspaceRoot: '/workspace',
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

describe('compileGraphPlanIntentV2', () => {
  it('derives parallel, pipeline, and named data dependencies from task relationships', () => {
    const parallel = compileV2({
      tasks: [planTask('api'), planTask('ui')]
    })
    expect(parallel.strategy?.kind).toBe('fanout_join')
    expect(parallel.edges).toEqual([])

    const pipeline = compileV2({
      tasks: [
        planTask('inspect'),
        planTask('implement', { dependsOn: ['inspect'] }),
        planTask('verify', { dependsOn: ['implement'] })
      ]
    })
    expect(pipeline.strategy?.kind).toBe('pipeline')
    expect(pipeline.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: 'inspect', to: 'implement', kind: 'control' }),
      expect.objectContaining({ from: 'implement', to: 'verify', kind: 'control' })
    ]))

    const withData = compileV2({
      tasks: [
        planTask('implement'),
        planTask('verify', {
          dataFrom: [{ taskKey: 'implement', name: 'implementation' }]
        })
      ]
    })
    expect(withData.strategy?.kind).toBe('pipeline')
    expect(withData.edges).toContainEqual(
      expect.objectContaining({ from: 'implement', to: 'verify', kind: 'data' })
    )
  })

  it('adds only the safe write check and requires only a worker summary', () => {
    const plan = compileV2({
      tasks: [planTask('implement', {
        writeScopes: ['src']
      })]
    })

    expect(plan.nodes[0]?.completion).toMatchObject({
      requiredResultFields: ['summary'],
      review: {
        kinds: ['lead'],
        deterministicChecks: ['git diff --check']
      }
    })
  })

  it('rejects loop on ordinary tasks and compiles an explicit bounded loop gate', () => {
    expect(() => GraphPlanIntentV2Schema.parse({
      tasks: [planTask('work', {
        loop: {
          conditionTaskKey: 'work',
          continueTaskKey: 'work',
          exitTaskKey: 'work',
          continueOn: ['repair_required'],
          maxIterations: 2
        }
      })]
    })).toThrow()

    const plan = compileV2({
      tasks: [
        planTask('work', { writeScopes: ['src'] }),
        planTask('review', { kind: 'review', dependsOn: ['work'] }),
        planTask('finish', { dependsOn: ['review'] }),
        planTask('gate', {
          kind: 'loop_gate',
          dependsOn: ['review'],
          loop: {
            conditionTaskKey: 'review',
            continueTaskKey: 'work',
            exitTaskKey: 'finish',
            continueOn: ['repair_required', 'failed'],
            maxIterations: 2
          }
        })
      ],
      completionTaskKeys: ['finish']
    })
    expect(plan.strategy?.kind).toBe('bounded_loop')
    expect(plan.nodes.find((node) => node.id === 'gate')?.loopGate).toMatchObject({
      maxIterations: 2,
      continueTargetNodeId: 'work',
      exitTargetNodeId: 'finish'
    })
    expect(plan.nodes.find((node) => node.id === 'gate')?.required).toBe(false)
    expect(plan.nodes.find((node) => node.id === 'review')?.writeScopes).toEqual([])
    expect(plan.nodes.find((node) => node.id === 'work')?.writeScopes).toEqual(['src'])
    expect(plan.edges).toContainEqual(expect.objectContaining({
      kind: 'control',
      from: 'review',
      to: 'gate',
      requiredOutcomes: ['accepted', 'repair_required', 'failed', 'skipped']
    }))
  })
})
