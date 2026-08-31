import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizeAppSettings } from '@shared/app-settings'
import { rendererRuntimeClient } from '../agent/runtime-client'
import { useChatStore } from '../store/chat-store'
import {
  createAutoPlanBuildIntent,
  listAutoPlanBuildIntents,
  saveAutoPlanBuildIntent
} from './auto-plan-build-intents'
import { autoPlanBuildControllerTestApi } from './use-auto-plan-build-controller'
import type { GuiPlanToolMeta } from './plan-tool'

const provider = vi.hoisted(() => ({
  sendUserMessage: vi.fn(),
  getThreadDetail: vi.fn()
}))

vi.mock('../agent/registry', () => ({ getProvider: () => provider }))

class MemoryStorage {
  private values = new Map<string, string>()
  getItem(key: string): string | null { return this.values.get(key) ?? null }
  setItem(key: string, value: string): void { this.values.set(key, value) }
  removeItem(key: string): void { this.values.delete(key) }
}

const meta: GuiPlanToolMeta = {
  planId: '/repo:.kunsdd/plan/automatic.md',
  workspaceRoot: '/repo',
  relativePath: '.kunsdd/plan/automatic.md',
  absolutePath: '/repo/.kunsdd/plan/automatic.md',
  operation: 'draft',
  sourceRequest: 'Build automatic mode',
  title: 'Automatic mode'
}

function planBlock(planMeta: GuiPlanToolMeta = meta) {
  return {
    kind: 'tool' as const,
    id: 'tool-plan',
    status: 'success' as const,
    summary: 'created',
    meta: {
      toolName: 'create_plan',
      plan: {
        plan_id: planMeta.planId,
        workspace_root: planMeta.workspaceRoot,
        relative_path: planMeta.relativePath,
        absolute_path: planMeta.absolutePath,
        operation: planMeta.operation,
        source_request: planMeta.sourceRequest,
        title: planMeta.title
      }
    }
  }
}

function directIntent(useWorktree = false) {
  return createAutoPlanBuildIntent({
    planId: meta.planId,
    relativePath: meta.relativePath,
    workspaceRoot: meta.workspaceRoot,
    threadId: 'thread-1',
    selection: { buildMode: 'direct', useWorktree }
  })
}

function installWindow(settings = normalizeAppSettings({} as never)): void {
  vi.stubGlobal('window', {
    localStorage: new MemoryStorage(),
    kunGui: {
      getSettings: vi.fn(async () => settings),
      readWorkspaceFile: vi.fn(async () => ({
        ok: true,
        path: meta.absolutePath,
        content: '# Automatic mode\n\n- [ ] Implement'
      })),
      writeWorkspaceFile: vi.fn(async () => ({ ok: true, path: meta.absolutePath })),
      getGitBranches: vi.fn(async () => ({
        ok: true,
        repositoryRoot: '/repo',
        primaryRepositoryRoot: '/repo',
        currentBranch: 'develop',
        dirtyCount: 0,
        branches: [{ name: 'develop', current: true }]
      })),
      createScheduleTask: vi.fn()
    }
  })
}

describe('Automatic plan-build orchestration', () => {
  beforeEach(() => {
    provider.sendUserMessage.mockReset().mockResolvedValue({ threadId: 'thread-1', turnId: 'build-turn' })
    provider.getThreadDetail.mockReset()
    rendererRuntimeClient.invalidateSettings()
  })

  afterEach(() => {
    rendererRuntimeClient.invalidateSettings()
    vi.unstubAllGlobals()
  })

  it('matches only the exact successful plan identity', () => {
    installWindow()
    const intent = directIntent()
    expect(autoPlanBuildControllerTestApi.matchingSuccessfulPlan([planBlock()], intent)).toEqual(meta)
    expect(autoPlanBuildControllerTestApi.matchingSuccessfulPlan([
      planBlock({ ...meta, relativePath: '.kunsdd/plan/old.md' })
    ], intent)).toBeNull()
  })

  it('dispatches one target-thread Direct build with a stable request id', async () => {
    installWindow()
    const intent = directIntent(true)
    saveAutoPlanBuildIntent(intent)
    await autoPlanBuildControllerTestApi.dispatchIntent(intent, meta)

    expect(provider.sendUserMessage).toHaveBeenCalledOnce()
    expect(provider.sendUserMessage).toHaveBeenCalledWith(
      'thread-1',
      expect.stringContaining('<prompt_managed_worktree_protocol>'),
      expect.objectContaining({
        clientRequestId: intent.buildClientRequestId,
        mode: 'agent',
        orchestration: 'direct',
        agentSurface: 'code'
      })
    )
    expect(listAutoPlanBuildIntents()).toEqual([])
  })

  it('creates a one-shot scheduled build and does not send an immediate turn', async () => {
    const createScheduleTask = vi.fn(async (input) => ({
      ok: true,
      task: { id: 'scheduled-1', ...input }
    }))
    const settings = normalizeAppSettings({} as never)
    installWindow(settings)
    window.kunGui.createScheduleTask = createScheduleTask as never
    const intent = createAutoPlanBuildIntent({
      planId: meta.planId,
      relativePath: meta.relativePath,
      workspaceRoot: meta.workspaceRoot,
      threadId: 'thread-1',
      selection: {
        buildMode: 'scheduled',
        useWorktree: false,
        scheduled: {
          providerId: 'deepseek',
          model: 'deepseek-chat',
          reasoningEffort: 'high',
          schedule: {
            kind: 'at',
            atTime: new Date(Date.now() + 3_600_000).toISOString(),
            timeZone: 'Asia/Shanghai'
          }
        }
      }
    })
    saveAutoPlanBuildIntent(intent)
    await autoPlanBuildControllerTestApi.dispatchIntent(intent, meta)

    expect(createScheduleTask).toHaveBeenCalledWith(expect.objectContaining({
      sourcePlanId: intent.planId,
      sourceThreadId: 'thread-1',
      orchestration: 'direct',
      schedule: intent.scheduled?.schedule
    }))
    expect(provider.sendUserMessage).not.toHaveBeenCalled()
    expect(listAutoPlanBuildIntents()).toEqual([])
  })

  it('marks an expired scheduled intent as needs attention without dispatching', async () => {
    installWindow()
    const intent = createAutoPlanBuildIntent({
      planId: meta.planId,
      relativePath: meta.relativePath,
      workspaceRoot: meta.workspaceRoot,
      threadId: 'thread-1',
      selection: {
        buildMode: 'scheduled',
        useWorktree: false,
        scheduled: {
          providerId: 'deepseek',
          model: 'deepseek-chat',
          reasoningEffort: 'high',
          schedule: {
            kind: 'at',
            atTime: new Date(Date.now() - 60_000).toISOString(),
            timeZone: 'Asia/Shanghai'
          }
        }
      }
    })
    saveAutoPlanBuildIntent(intent)
    await autoPlanBuildControllerTestApi.dispatchIntent(intent, meta)
    expect(provider.sendUserMessage).not.toHaveBeenCalled()
    expect(window.kunGui.createScheduleTask).not.toHaveBeenCalled()
    expect(listAutoPlanBuildIntents()[0]).toMatchObject({
      status: 'needs_attention',
      error: expect.stringContaining('passed')
    })
  })

  it('keeps clarification pending instead of dispatching', async () => {
    installWindow()
    const intent = directIntent()
    saveAutoPlanBuildIntent(intent)
    provider.getThreadDetail.mockResolvedValue({
      blocks: [{
        kind: 'user_input', id: 'input-1', requestId: 'request-1', questions: [], status: 'pending'
      }],
      latestSeq: 1,
      threadStatus: 'running',
      latestTurnStatus: 'running'
    })
    await autoPlanBuildControllerTestApi.reconcileIntent(intent)
    expect(provider.sendUserMessage).not.toHaveBeenCalled()
    expect(listAutoPlanBuildIntents()[0]?.status).toBe('planning')
  })

  it('waits for the plan turn to finish even after create_plan succeeds', async () => {
    installWindow()
    const intent = directIntent()
    saveAutoPlanBuildIntent(intent)
    provider.getThreadDetail.mockResolvedValue({
      blocks: [planBlock()],
      latestSeq: 2,
      threadStatus: 'running',
      latestTurnStatus: 'running'
    })
    await autoPlanBuildControllerTestApi.reconcileIntent(intent)
    expect(provider.sendUserMessage).not.toHaveBeenCalled()
    expect(listAutoPlanBuildIntents()[0]?.status).toBe('planning')
  })

  it('fails closed when a terminal plan turn has no matching plan result', async () => {
    installWindow()
    const intent = directIntent()
    saveAutoPlanBuildIntent(intent)
    useChatStore.setState({ activeThreadId: 'thread-1', error: null })
    provider.getThreadDetail.mockResolvedValue({
      blocks: [],
      latestSeq: 2,
      threadStatus: 'idle',
      latestTurnStatus: 'failed'
    })
    await autoPlanBuildControllerTestApi.reconcileIntent(intent)
    expect(provider.sendUserMessage).not.toHaveBeenCalled()
    expect(listAutoPlanBuildIntents()[0]?.status).toBe('needs_attention')
    expect(useChatStore.getState().error).toContain('matching successful plan')
  })
})
