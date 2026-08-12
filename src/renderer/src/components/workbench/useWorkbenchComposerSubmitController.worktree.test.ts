import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PlanWorktreeRunRecord } from '@shared/plan-worktree'

vi.mock('react', async (importOriginal) => ({
  ...await importOriginal<typeof import('react')>(),
  useCallback: <T>(callback: T): T => callback
}))
vi.mock('react-i18next', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (key: string): string => key })
}))

import { resetPlanWorktreeStoreForTests, usePlanWorktreeStore } from '../../plan/plan-worktree-store'
import { useWorkbenchComposerSubmitController } from './useWorkbenchComposerSubmitController'

type Params = Parameters<typeof useWorkbenchComposerSubmitController>[0]

function readOnlyRun(): PlanWorktreeRunRecord {
  return {
    version: 1, runId: 'run-a', operationId: 'operation-a', planId: 'plan-a',
    planRelativePath: '.kunsdd/plan/demo.md', planTitle: 'Demo', goalObjective: 'Build Demo',
    sourceThreadId: 'source-thread', executionThreadId: 'execution-thread', executionTurnId: 'turn-a',
    orchestration: 'direct', sourceWorkspaceRoot: '/repo', sourceCheckoutRoot: '/repo',
    primaryRepositoryRoot: '/repo', repositoryIdentity: '/repo/.git',
    targetBranch: 'feature/source', baseCommit: 'a'.repeat(40), executionBranch: 'codex/demo',
    worktreePath: '/managed/run/repo', executionWorkspace: '/managed/run/repo',
    status: 'ready_to_integrate',
    cleanup: { threadRebound: false, worktreeRemoved: false, branchDeleted: false, metadataPruned: false },
    createdAt: '2026-08-12T00:00:00.000Z', updatedAt: '2026-08-12T00:00:00.000Z'
  }
}

function params(overrides: Partial<Params> = {}): Params {
  return {
    activeClawChannelId: '', activeSddDraft: false, activeThreadId: 'execution-thread',
    attachmentUploadEnabled: true, buildCodeCanvasOutboundPrompt: vi.fn(async () => ''),
    clearComposerAttachments: vi.fn(), removeComposerAttachments: vi.fn(),
    clearComposerFileReferences: vi.fn(), composerAttachments: [], composerFileReferences: [],
    composerMode: 'agent', composerModel: 'auto', composerProviderId: '', composerModelGroups: [],
    composerReasoningEffort: 'auto', composerFastMode: false, getAttachmentScope: () => 'chat',
    handleGuiPlanCommand: vi.fn(), input: 'continue', resetClawChannelSession: vi.fn(),
    rightPanelMode: null, route: 'chat', selectClawChannel: vi.fn(),
    sendMessage: vi.fn(async () => true), sendPlanTurn: vi.fn(async () => true),
    sendSddAssistantPrompt: vi.fn(), setAttachmentUploadError: vi.fn(),
    setClawChannelModel: vi.fn(), setError: vi.fn(), setInput: vi.fn(),
    threads: [{
      id: 'execution-thread', title: 'Execution', updatedAt: '', model: 'auto', mode: 'agent',
      workspace: '/managed/run/repo', planBuildRunId: 'run-a'
    }],
    workspaceRoot: '/managed/run/repo', appendLocalClawTurn: vi.fn(),
    ...overrides
  }
}

describe('worktree execution submit guard', () => {
  beforeEach(() => {
    resetPlanWorktreeStoreForTests()
    usePlanWorktreeStore.getState().upsertRun(readOnlyRun())
  })

  it('rejects a submit after execution enters integration even if UI state is stale', async () => {
    const sendMessage = vi.fn(async () => true)
    const setError = vi.fn()
    useWorkbenchComposerSubmitController(params({ sendMessage, setError })).handleSend()

    await Promise.resolve()
    expect(sendMessage).not.toHaveBeenCalled()
    expect(setError).toHaveBeenCalledWith(expect.stringContaining('read-only'))
  })

  it('rejects a submit before durable admission when the side-thread summary is missing', async () => {
    const { executionTurnId: _executionTurnId, ...pending } = readOnlyRun()
    usePlanWorktreeStore.getState().upsertRun({ ...pending, status: 'executing' })
    const sendMessage = vi.fn(async () => true)
    const setError = vi.fn()
    useWorkbenchComposerSubmitController(params({ threads: [], sendMessage, setError })).handleSend()

    await Promise.resolve()
    expect(sendMessage).not.toHaveBeenCalled()
    expect(setError).toHaveBeenCalledWith(expect.stringContaining('resume'))
  })

  it('allows continuation after durable admission when the side-thread summary is missing', async () => {
    usePlanWorktreeStore.getState().upsertRun({ ...readOnlyRun(), status: 'executing' })
    const sendMessage = vi.fn(async () => true)
    useWorkbenchComposerSubmitController(params({ threads: [], sendMessage })).handleSend()

    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledWith(
      'continue',
      'agent',
      expect.any(Object)
    ))
  })
})
