import { describe, expect, it } from 'vitest'
import type { ToolHostContext } from '../../ports/tool-host.js'
import { GraphWorkerSessionRegistry } from '../../graph/graph-worker-sessions.js'
import { replayGraphEvents } from '../../graph/graph-reducer.js'
import {
  testGraphEnvelope,
  testGraphPlan
} from '../../graph/graph-test-fixtures.test-support.js'
import { buildGraphModeLocalTools } from './graph-mode-tool-provider.js'

function context(
  threadId: string,
  orchestration: 'direct' | 'graph' = 'direct',
  messageSource?: 'graph_runtime'
): ToolHostContext {
  return {
    threadId,
    turnId: 'turn_1',
    workspace: '/workspace',
    orchestration,
    ...(messageSource ? { messageSource } : {}),
    approvalPolicy: 'never',
    abortSignal: new AbortController().signal,
    awaitApproval: async () => 'deny'
  }
}

describe('Graph Mode tool visibility boundaries', () => {
  it('separates Lead, Worker, and ordinary direct-turn tools', () => {
    const workerSessions = new GraphWorkerSessionRegistry()
    workerSessions.bind('worker_thread', {
      runId: 'run_1',
      nodeId: 'node_1',
      attemptId: 'attempt_1'
    })
    const tools = buildGraphModeLocalTools({
      control: {} as never,
      store: {} as never,
      mailbox: {} as never,
      registry: {} as never,
      artifactStore: {} as never,
      workerSessions,
      enabled: () => true
    })
    const leadNames = new Set([
      'graph_create_run',
      'graph_control_run',
      'graph_patch_run',
      'graph_review_node'
    ])
    const workerNames = new Set(tools
      .map((tool) => tool.name)
      .filter((name) => name.startsWith('graph_worker_')))

    for (const tool of tools) {
      expect(tool.shouldAdvertise?.(context('direct_thread'))).toBe(false)
      expect(tool.shouldAdvertise?.(context('lead_thread', 'graph'))).toBe(
        leadNames.has(tool.name)
      )
      expect(tool.shouldAdvertise?.(context('runtime_thread', 'direct', 'graph_runtime'))).toBe(
        leadNames.has(tool.name) && tool.name !== 'graph_create_run'
      )
      expect(tool.shouldAdvertise?.(context('worker_thread', 'graph'))).toBe(
        workerNames.has(tool.name)
      )
    }
  })

  it('safe-disable hides every Graph tool without losing durable state', () => {
    const tools = buildGraphModeLocalTools({
      control: {} as never,
      store: {} as never,
      mailbox: {} as never,
      registry: {} as never,
      artifactStore: {} as never,
      workerSessions: new GraphWorkerSessionRegistry(),
      enabled: () => false
    })
    expect(tools.every((tool) =>
      tool.shouldAdvertise?.(context('lead_thread', 'graph')) === false)).toBe(true)
  })

  it('rejects Lead access from a thread that does not own the GraphRun', async () => {
    const run = replayGraphEvents([
      testGraphEnvelope(1, {
        type: 'run_created',
        payload: {
          plan: testGraphPlan(),
          projectId: 'project_1',
          sourceTurnId: 'turn_1'
        }
      })
    ])
    const tools = buildGraphModeLocalTools({
      control: {
        get: async () => run
      } as never,
      store: {
        get: async () => run
      } as never,
      mailbox: {} as never,
      registry: {
        identify: async () => ({
          projectId: 'project_1',
          canonicalWorkspaceRoot: '/workspace'
        })
      } as never,
      artifactStore: {} as never,
      workerSessions: new GraphWorkerSessionRegistry(),
      enabled: () => true
    })
    const inspect = tools.find((tool) => tool.name === 'graph_control_run')!
    const result = await inspect.execute(
      { action: 'inspect', runId: run.id },
      context('other_thread', 'graph')
    )
    expect(result).toMatchObject({
      isError: true,
      output: { error: expect.stringMatching(/does not own/) }
    })
  })
})
