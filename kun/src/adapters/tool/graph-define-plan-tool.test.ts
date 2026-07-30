import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ToolHostContext } from '../../ports/tool-host.js'
import {
  FileGraphPlanningDraftStore
} from '../../graph/graph-planning-draft-store.js'
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
  const record = vi.fn()
  const tool = buildGraphDefinePlanTool({
    control: {
      create,
      get
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
  return { create, drafts, get, record, tool }
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
    const { create, drafts, get, tool } = await harness()
    const run = { id: 'run_1', status: 'running' }
    create.mockResolvedValue({
      run,
      validation: { valid: true, issues: [] }
    })
    get.mockResolvedValue(run)
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
      start: true,
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
    expect(get).toHaveBeenCalledWith('run_1')
    expect((await drafts.require('draft_1')).status).toBe('committed')
  })
})
