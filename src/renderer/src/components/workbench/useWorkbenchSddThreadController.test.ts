import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NormalizedThread } from '../../agent/types'
import { useChatStore } from '../../store/chat-store'
import {
  markSddAssistantThread,
  normalizeSddThreadRegistry
} from '../../sdd/sdd-thread-registry'
import { useSddDraftStore } from '../../sdd/sdd-draft-store'
import {
  isRequirementSessionThread,
  useWorkbenchSddThreadController,
  type WorkbenchSddThreadController
} from './useWorkbenchSddThreadController'

const requirementThread: NormalizedThread = {
  id: 'thread-sdd-1',
  title: 'Requirement draft',
  updatedAt: '2026-01-01T00:00:00.000Z',
  model: 'deepseek-v4-pro',
  mode: 'agent',
  workspace: '/tmp/app'
}

describe('requirement sidebar thread classification', () => {
  it('classifies the session as a requirement session before Plan release and as plain Code afterward', () => {
    const requirementRegistry = markSddAssistantThread({
      id: 'draft-1',
      workspaceRoot: '/tmp/app',
      relativePath: '.kunsdd/requirements/draft-1/requirement.md'
    }, requirementThread.id, null)
    const visibleRequirementRegistry = normalizeSddThreadRegistry({
      ...requirementRegistry,
      drafts: Object.fromEntries(
        Object.entries(requirementRegistry.drafts).map(([draftId, record]) => [
          draftId,
          { ...record, visibleThreadIds: [requirementThread.id] }
        ])
      )
    })
    const releasedRegistry = normalizeSddThreadRegistry({
      ...visibleRequirementRegistry,
      drafts: Object.fromEntries(
        Object.entries(visibleRequirementRegistry.drafts).map(([draftId, record]) => [
          draftId,
          { ...record, publicThreadIds: [requirementThread.id] }
        ])
      )
    })

    expect(isRequirementSessionThread(
      requirementThread.id,
      requirementThread,
      visibleRequirementRegistry
    )).toBe(true)
    expect(isRequirementSessionThread(
      requirementThread.id,
      requirementThread,
      releasedRegistry
    )).toBe(false)
  })
})

let latestController: WorkbenchSddThreadController

function ControllerHarness(): null {
  latestController = useWorkbenchSddThreadController({
    activeThreadId: 'thread-current',
    codeThreads: [{ ...requirementThread, id: 'thread-current', workspace: '/workspace/current' }],
    conversationWorkspaceRoot: '/workspace/conversations',
    input: '',
    rightPanelMode: null,
    runtimeConnection: 'offline',
    workspaceRoot: '/workspace/fallback',
    selectThread: vi.fn(async () => undefined),
    setComposerMode: vi.fn(),
    setError: vi.fn(),
    setInput: vi.fn(),
    setRightPanelMode: vi.fn(),
    setRightSidebarWidth: vi.fn(),
    setRoute: vi.fn()
  })
  return null
}

describe('new requirement workspace', () => {
  let renderer: ReactTestRenderer
  const createWorkspaceFile = vi.fn(async (payload: { workspaceRoot: string; path: string }) => ({
    ok: true as const,
    path: `${payload.workspaceRoot}/${payload.path}`
  }))
  const pickWorkspaceDirectory = vi.fn()

  beforeEach(async () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const storage = {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn()
    }
    vi.stubGlobal('window', {
      kunGui: { createWorkspaceFile, pickWorkspaceDirectory },
      localStorage: storage
    })
    useChatStore.setState({ activeThreadId: null, threads: [] })
    useSddDraftStore.getState().clearActiveDraft()
    await act(async () => {
      renderer = create(createElement(ControllerHarness))
    })
  })

  afterEach(() => {
    renderer.unmount()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    useSddDraftStore.getState().clearActiveDraft()
  })

  it('creates in the current thread workspace without opening a directory picker', async () => {
    await act(async () => {
      await latestController.startNewSddRequirement()
    })

    expect(pickWorkspaceDirectory).not.toHaveBeenCalled()
    expect(createWorkspaceFile).toHaveBeenCalledWith(expect.objectContaining({
      workspaceRoot: '/workspace/current'
    }))
  })
})
