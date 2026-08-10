import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ToolHostContext } from '../../ports/tool-host.js'
import {
  FileGraphPlanningDraftStore
} from '../../graph/graph-planning-draft-store.js'
import { GraphPlanValidationError } from '../../graph/graph-validator.js'
import {
  buildGraphDefinePlanTool,
  GRAPH_DEFINE_PLAN_INPUT_JSON_SCHEMA
} from './graph-define-plan-tool.js'

const roots: string[] = []

function context(): ToolHostContext {
  return {
    threadId: 'thread_1',
    turnId: 'turn_1',
    workspace: '/workspace',
    orchestration: 'graph',
    approvalPolicy: 'never',
    abortSignal: new AbortController().signal,
    awaitApproval: async () => 'deny'
  }
}

async function harness() {
  const rootDir = await mkdtemp(join(tmpdir(), 'kun-graph-define-'))
  roots.push(rootDir)
  const drafts = new FileGraphPlanningDraftStore({
    rootDir,
    nowIso: () => '2026-07-29T00:00:00.000Z'
  })
  await drafts.create({
    id: 'draft_1',
    reservedRunId: 'run_1',
    threadId: 'thread_1',
    sourceTurnId: 'turn_1',
    projectId: 'project_1',
    goal: 'Implement and verify the requested change.'
  })
  const create = vi.fn()
  const get = vi.fn()
  const start = vi.fn()
  const cancel = vi.fn()
  const record = vi.fn()
  const tool = buildGraphDefinePlanTool({
    control: {
      create,
      get,
      start,
      cancel
    } as never,
    drafts,
    registry: {
      identify: async () => ({
        projectId: 'project_1',
        canonicalWorkspaceRoot: '/workspace'
      })
    } as never,
    events: { record } as never,
    shouldAdvertise: () => true,
    nowIso: () => '2026-07-29T00:00:00.000Z',
    nextId: () => 'command_1'
  })
  return { cancel, create, drafts, get, record, start, tool }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })))
})

describe('graph_define_plan', () => {
  it('exposes ordinary and loop tasks as separate schema branches and hides host mechanics', () => {
    const schema = GRAPH_DEFINE_PLAN_INPUT_JSON_SCHEMA as {
      properties: {
        plan: {
          properties: {
            tasks: {
              items: {
                oneOf: Array<{
                  properties: Record<string, unknown>
                  required: string[]
                }>
              }
            }
          }
        }
      }
    }
    const branches = schema.properties.plan.properties.tasks.items.oneOf
    const ordinary = branches.find((branch) => !branch.required.includes('loop'))
    const loop = branches.find((branch) => branch.required.includes('loop'))

    expect(ordinary?.properties).not.toHaveProperty('loop')
    expect(loop?.properties).toHaveProperty('loop')
    const encoded = JSON.stringify(schema)
    for (const forbidden of [
      'budget',
      'model',
      'providerId',
      'reasoningEffort',
      'timeout',
      'maxAttempts',
      'priority',
      'phase',
      'revision',
      'workspaceRoot',
      'runId',
      'timestamp'
    ]) {
      expect(encoded).not.toContain(`"${forbidden}"`)
    }
  })

  it('defensively unwraps a complete __raw transport envelope and commits one run', async () => {
    const { create, drafts, get, start, tool } = await harness()
    create.mockResolvedValue({
      run: { id: 'run_1', status: 'ready' },
      validation: { valid: true, issues: [] }
    })
    get.mockResolvedValue({ id: 'run_1', status: 'ready' })
    start.mockResolvedValue({ id: 'run_1', status: 'running' })

    await expect(tool.execute({
      tool_name: 'graph_define_plan',
      __raw: JSON.stringify(validPlan())
    }, context())).resolves.toMatchObject({
      output: {
        status: 'committed',
        draft: { status: 'committed', committedRunId: 'run_1' },
        run: { id: 'run_1', status: 'running' }
      }
    })

    expect(await drafts.readCandidate('draft_1')).toEqual(validPlan().plan)
    expect(create).toHaveBeenCalledOnce()
    expect(start).toHaveBeenCalledOnce()
  })

  it('does not let a parseable raw envelope overwrite an explicit business plan', async () => {
    const { create, drafts, start, tool } = await harness()
    const explicitPlan = validPlan().plan
    const raw = JSON.stringify({
      plan: { ...explicitPlan, title: 'private-inner-plan-marker' }
    })

    const result = await tool.execute({ __raw: raw, plan: explicitPlan }, context())

    expect(result).toMatchObject({
      isError: true,
      output: {
        code: 'graph_plan_invalid',
        retryable: true,
        issues: expect.any(Array)
      }
    })
    expect(await drafts.readCandidate('draft_1')).toEqual(explicitPlan)
    expect(JSON.stringify(result)).not.toContain('private-inner-plan-marker')
    expect(create).not.toHaveBeenCalled()
    expect(start).not.toHaveBeenCalled()
  })

  it('returns a bounded structured repair for truncated __raw arguments and commits a changed correction', async () => {
    const { create, drafts, get, start, tool } = await harness()
    create.mockResolvedValue({
      run: { id: 'run_1', status: 'ready' },
      validation: { valid: true, issues: [] }
    })
    get.mockResolvedValue({ id: 'run_1', status: 'ready' })
    start.mockResolvedValue({ id: 'run_1', status: 'running' })
    const raw = '{"plan":{"title":"private-regression-marker","tasks":['

    const first = await tool.execute({ __raw: raw }, context())

    expect(first).toMatchObject({
      isError: true,
      output: {
        code: 'graph_plan_invalid',
        error: expect.stringContaining('smaller structured plan'),
        retryable: true,
        repairHint: expect.stringContaining('never use __raw'),
        validExample: expect.objectContaining({ plan: expect.any(Object) }),
        issues: [expect.objectContaining({
          code: 'incomplete_tool_arguments',
          path: ['plan'],
          message: expect.stringContaining('not a complete structured JSON object'),
          repairHint: expect.stringContaining('Shorten titles')
        })],
        draft: {
          status: 'repairing',
          repairCount: 1,
          candidateHash: expect.stringMatching(/^[a-f0-9]{64}$/)
        }
      }
    })
    expect(JSON.stringify(first)).not.toContain('private-regression-marker')
    expect(await drafts.readCandidate('draft_1')).toBeNull()
    expect(create).not.toHaveBeenCalled()

    await expect(tool.execute(validPlan(), context())).resolves.toMatchObject({
      output: {
        status: 'committed',
        draft: { status: 'committed', committedRunId: 'run_1' }
      }
    })
    expect(create).toHaveBeenCalledOnce()
  })

  it('stops an unchanged truncated retry without persisting or echoing the raw payload', async () => {
    const { create, drafts, tool } = await harness()
    const raw = '{"plan":{"title":"do-not-echo-this-marker"'

    const first = await tool.execute({ __raw: raw }, context())
    const repeated = await tool.execute({ __raw: raw }, context())

    expect(first).toMatchObject({
      isError: true,
      output: { code: 'graph_plan_invalid', retryable: true }
    })
    expect(repeated).toMatchObject({
      isError: true,
      output: {
        code: 'unchanged_invalid_plan',
        retryable: false,
        draft: { status: 'needs_correction', repairCount: 1 }
      }
    })
    expect(JSON.stringify([first, repeated])).not.toContain('do-not-echo-this-marker')
    expect(await drafts.readCandidate('draft_1')).toBeNull()
    expect(create).not.toHaveBeenCalled()
  })

  it('recognizes changed but still incomplete arguments without treating them as an unchanged retry', async () => {
    const { create, tool } = await harness()

    await tool.execute({ __raw: '{"plan":{"title":"first"' }, context())
    const changed = await tool.execute({
      __raw: '{"plan":{"title":"second","tasks":['
    }, context())

    expect(changed).toMatchObject({
      isError: true,
      output: {
        code: 'graph_plan_needs_correction',
        retryable: false,
        issues: [expect.objectContaining({ code: 'incomplete_tool_arguments' })],
        draft: { status: 'needs_correction', repairCount: 1 }
      }
    })
    expect(create).not.toHaveBeenCalled()
  })

  it('returns one precise repair and pauses immediately when identical invalid arguments repeat', async () => {
    const { create, drafts, tool } = await harness()
    const invalidPlan = {
      plan: {
        title: 'Invalid screenshot regression',
        tasks: ['inspect', 'implement', 'test', 'review'].map((key) => ({
          key,
          kind: 'work',
          title: key,
          objective: `Complete ${key}.`,
          dependsOn: [],
          dataFrom: [],
          acceptanceCriteria: [`${key} is complete.`],
          readScopes: ['.'],
          writeScopes: [],
          loop: {
            conditionTaskKey: 'inspect',
            continueTaskKey: 'implement',
            exitTaskKey: 'review',
            continueOn: ['repair_required'],
            maxIterations: 3
          }
        }))
      }
    }

    const first = await tool.execute(invalidPlan, context())
    const afterFirst = await drafts.require('draft_1')
    const repeated = await tool.execute(invalidPlan, context())
    const afterRepeated = await drafts.require('draft_1')

    expect(first).toMatchObject({
      isError: true,
      output: {
        code: 'graph_plan_invalid',
        retryable: true,
        draft: { status: 'repairing', repairCount: 1 }
      }
    })
    expect(afterFirst.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: expect.arrayContaining(['tasks', 0])
      })
    ]))
    expect(repeated).toMatchObject({
      isError: true,
      output: {
        code: 'unchanged_invalid_plan',
        retryable: false,
        draft: { status: 'needs_correction', repairCount: 1 }
      }
    })
    expect(afterRepeated.status).toBe('needs_correction')
    expect(create).not.toHaveBeenCalled()
  })

  it('commits one reserved run and returns it idempotently on duplicate submission', async () => {
    const { create, drafts, get, start, tool } = await harness()
    const run = { id: 'run_1', status: 'running' }
    const readyRun = { id: 'run_1', status: 'ready' }
    create.mockResolvedValue({
      run: readyRun,
      validation: { valid: true, issues: [] }
    })
    start.mockResolvedValue(run)
    get.mockResolvedValue(readyRun)
    const valid = {
      plan: {
        title: 'Implement safely',
        tasks: [{
          key: 'implement',
          kind: 'work',
          title: 'Implement',
          objective: 'Implement the requested change.',
          dependsOn: [],
          dataFrom: [],
          acceptanceCriteria: ['The requested behavior works.'],
          readScopes: ['.'],
          writeScopes: ['src']
        }],
        completionTaskKeys: ['implement']
      }
    }

    const first = await tool.execute(valid, context())
    const repeated = await tool.execute(valid, context())

    expect(first).toMatchObject({
      output: {
        status: 'committed',
        draft: {
          status: 'committed',
          committedRunId: 'run_1'
        },
        run
      }
    })
    expect(repeated).toMatchObject({
      output: {
        status: 'committed',
        draft: { committedRunId: 'run_1' },
        run
      }
    })
    expect(create).toHaveBeenCalledTimes(1)
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run_1',
      idempotencyKey: 'graph-plan-commit:turn_1',
      start: false,
      plan: expect.objectContaining({
        nodes: [expect.objectContaining({
          completion: expect.objectContaining({
            requiredResultFields: ['summary'],
            review: expect.objectContaining({
              deterministicChecks: ['git diff --check']
            })
          })
        })]
      })
    }))
    expect(start).toHaveBeenCalledWith('run_1', expect.objectContaining({
      idempotencyKey: 'graph-plan-start:turn_1'
    }))
    expect(start).toHaveBeenCalledTimes(2)
    expect(get).toHaveBeenCalledWith('run_1')
    expect((await drafts.require('draft_1')).status).toBe('committed')
  })

  it('restores task titles by key when a corrected transport payload drops them', async () => {
    const { create, drafts, get, start, tool } = await harness()
    create
      .mockRejectedValueOnce(new GraphPlanValidationError({
        version: 1,
        valid: false,
        issues: [{
          code: 'completion_node_not_terminal',
          path: ['completionNodeIds', 0],
          message: 'completion node implement has an outgoing scheduling edge',
          severity: 'error'
        }],
        normalizedNodeCount: 2,
        normalizedEdgeCount: 1
      }))
      .mockResolvedValueOnce({
        run: { id: 'run_1', status: 'ready' },
        validation: { valid: true, issues: [] }
      })
    start.mockResolvedValue({ id: 'run_1', status: 'running' })
    get.mockRejectedValue(new Error('run not found'))
    const task = (key: string, title: string, dependsOn: string[] = []) => ({
      key,
      kind: 'work' as const,
      title,
      objective: `Complete ${key}.`,
      dependsOn,
      dataFrom: [],
      acceptanceCriteria: [`${key} is complete.`],
      readScopes: ['.'],
      writeScopes: ['src']
    })
    const invalid = {
      plan: {
        title: 'Implement and validate TimeKV',
        tasks: [
          task('implement', 'Implement TimeKV class with tests and analysis'),
          task(
            'validate',
            'Stress-test TimeKV against brute force and measure performance',
            ['implement']
          )
        ],
        // A completion task cannot have an outgoing scheduling edge.
        completionTaskKeys: ['implement']
      }
    }

    await expect(tool.execute(invalid, context())).resolves.toMatchObject({
      isError: true,
      output: {
        code: 'graph_plan_invalid',
        retryable: true,
        draft: { status: 'repairing', repairCount: 1 }
      }
    })

    const corrected = {
      plan: {
        ...invalid.plan,
        tasks: invalid.plan.tasks.map(({ title: _transportDroppedTitle, ...entry }) => entry),
        completionTaskKeys: ['validate']
      }
    }
    await expect(tool.execute(corrected, context())).resolves.toMatchObject({
      output: {
        status: 'committed',
        draft: { status: 'committed', committedRunId: 'run_1' }
      }
    })

    expect(await drafts.readCandidate('draft_1')).toMatchObject({
      tasks: [
        { key: 'implement', title: 'Implement TimeKV class with tests and analysis' },
        {
          key: 'validate',
          title: 'Stress-test TimeKV against brute force and measure performance'
        }
      ],
      completionTaskKeys: ['validate']
    })
    expect(create).toHaveBeenCalledTimes(2)
  })

  it('recovers a durable ready run when create reports a post-commit failure', async () => {
    const { create, drafts, get, start, tool } = await harness()
    create.mockRejectedValue(new Error('runtime event outbox flush failed'))
    get.mockResolvedValue({ id: 'run_1', status: 'ready' })
    start.mockResolvedValue({ id: 'run_1', status: 'running' })

    await expect(tool.execute(validPlan(), context())).resolves.toMatchObject({
      output: {
        status: 'committed',
        draft: {
          status: 'committed',
          committedRunId: 'run_1'
        },
        run: { id: 'run_1', status: 'running' }
      }
    })
    expect((await drafts.require('draft_1')).status).toBe('committed')
    expect(start).toHaveBeenCalledOnce()
  })

  it('labels an unrecoverable committed-run creation failure as a host error', async () => {
    const { create, drafts, get, tool } = await harness()
    const failure = Object.assign(new Error('private create failure'), {
      code: 'invalid_plan'
    })
    create.mockRejectedValue(failure)
    get.mockRejectedValue(new Error('run not found'))

    const result = await tool.execute(validPlan(), context())

    expect(result).toMatchObject({
      isError: true,
      output: {
        code: 'graph_planning_host_error',
        retryable: false,
        error: 'Graph planning could not persist or commit the draft because the host encountered an error.',
        issues: [{ code: 'graph_planning_host_error', path: [] }],
        draft: {
          status: 'host_error',
          repairCount: 0,
          issues: [{ code: 'graph_planning_host_error', path: [] }]
        }
      }
    })
    expect(JSON.stringify(result)).not.toContain('private create failure')
    expect(JSON.stringify(result)).not.toContain('invalid_plan')
    expect((await drafts.require('draft_1')).status).toBe('host_error')
  })

  it('reports user cancellation when Stop wins a deferred committed start', async () => {
    const { create, get, start, tool } = await harness()
    let runStatus: 'ready' | 'cancelled' = 'ready'
    let releaseStart!: () => void
    const startReleased = new Promise<void>((resolve) => {
      releaseStart = resolve
    })
    create.mockResolvedValue({
      run: { id: 'run_1', status: 'ready' },
      validation: { valid: true, issues: [] }
    })
    get.mockImplementation(async () => ({ id: 'run_1', status: runStatus }))
    start.mockImplementation(async () => {
      await startReleased
      throw new Error('cannot start GraphRun run_1 from cancelled')
    })

    const execution = tool.execute(validPlan(), context())
    await vi.waitFor(() => {
      expect(start).toHaveBeenCalledOnce()
    })
    runStatus = 'cancelled'
    releaseStart()

    await expect(execution).resolves.toMatchObject({
      isError: true,
      output: {
        code: 'graph_planning_aborted',
        draft: { status: 'committed' }
      }
    })
  })

  it('cancels a delayed ready run when Stop wins the planning-draft CAS race', async () => {
    const {
      cancel,
      create,
      drafts,
      get,
      start,
      tool
    } = await harness()
    const controller = new AbortController()
    let releaseCreate!: () => void
    const createReleased = new Promise<void>((resolve) => {
      releaseCreate = resolve
    })
    let runStatus: 'ready' | 'cancelled' = 'ready'
    create.mockImplementation(async () => {
      await createReleased
      return {
        run: { id: 'run_1', status: runStatus },
        validation: { valid: true, issues: [] }
      }
    })
    get.mockImplementation(async () => ({ id: 'run_1', status: runStatus }))
    cancel.mockImplementation(async () => {
      runStatus = 'cancelled'
      return { id: 'run_1', status: runStatus }
    })
    const valid = {
      plan: {
        tasks: [{
          key: 'implement',
          kind: 'work',
          title: 'Implement',
          objective: 'Implement the requested change.',
          dependsOn: [],
          dataFrom: [],
          acceptanceCriteria: ['The requested behavior works.'],
          readScopes: ['.'],
          writeScopes: ['src']
        }]
      }
    }

    const execution = tool.execute(valid, {
      ...context(),
      abortSignal: controller.signal
    })
    await vi.waitFor(() => {
      expect(create).toHaveBeenCalledOnce()
    })

    const committing = await drafts.require('draft_1')
    expect(committing.status).toBe('committing')
    await drafts.update(committing.id, {
      expectedRevision: committing.revision,
      status: 'cancelled'
    })
    controller.abort()
    releaseCreate()

    await expect(execution).resolves.toMatchObject({
      isError: true,
      output: {
        code: 'graph_planning_aborted',
        draft: { status: 'cancelled' }
      }
    })
    expect(start).not.toHaveBeenCalled()
    expect(cancel).toHaveBeenCalledWith('run_1', expect.objectContaining({
      idempotencyKey: 'graph-plan-abort:turn_1:run_1'
    }))
    expect(runStatus).toBe('cancelled')
  })
})

function validPlan() {
  return {
    plan: {
      tasks: [{
        key: 'implement',
        kind: 'work',
        title: 'Implement',
        objective: 'Implement the requested change.',
        dependsOn: [],
        dataFrom: [],
        acceptanceCriteria: ['The requested behavior works.'],
        readScopes: ['.'],
        writeScopes: ['src']
      }]
    }
  }
}
