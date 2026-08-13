import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatBlock, NormalizedThread } from '../agent/types'
import { KunRuntimeProvider } from '../agent/kun-runtime'
import {
  armBusyWatchdog,
  buildThreadEventSink,
  clearWatchedCompletionNotification,
  clearWatchedCompletionNotifications,
  clearPendingClawFeishuMirrors,
  completionNotificationDedupeKeyForWatchedThread,
  isCodeSidebarThread,
  isCodeThread,
  MAX_PENDING_CLAW_FEISHU_MIRRORS,
  MAX_WATCHED_COMPLETION_NOTIFICATIONS,
  rememberPendingClawFeishuMirror,
  takePendingClawFeishuMirror,
  turnCompleteNotificationSource,
  watchTurnCompletionNotification
} from './chat-store-runtime'
import { clearBusyWatchdog, resetBusyRecoveryAttempts } from './chat-store-schedulers'
import type { ChatState, ChatStoreSet } from './chat-store-types'
import { emptyDesignThreadRegistry, markDesignThread } from '../design/design-thread-registry'
import {
  WRITE_ASSISTANT_THREAD_TITLE,
  emptyWriteThreadRegistry,
  markWriteThread
} from '../write/write-thread-registry'
import { useWriteWorkspaceStore } from '../write/write-workspace-store'
import {
  markSddAssistantThread,
  normalizeSddThreadRegistry
} from '../sdd/sdd-thread-registry'

function makeSinkHarness(overrides: Partial<ChatState> = {}): {
  getState: () => ChatState
  set: ChatStoreSet
  get: () => ChatState
} {
  let state = {
    activeThreadId: 'thread-current',
    blocks: [],
    liveReasoning: '',
    liveAssistant: '',
    lastSeq: 0,
    usageRefreshKey: 0,
    busy: true,
    error: null,
    currentTurnId: 'turn-current',
    currentTurnUserId: 'user-current',
    turnStartedAtByUserId: { 'user-current': 1000 },
    turnDurationByUserId: {},
    turnReasoningFirstAtByUserId: {},
    turnReasoningLastAtByUserId: {},
    watchTurnCompletion: {},
    unreadThreadIds: {},
    queuedMessages: [],
    threads: [],
    refreshThreads: vi.fn(async () => undefined),
    drainQueuedMessages: vi.fn(async () => undefined)
  } as unknown as ChatState
  state = { ...state, ...overrides }
  const get = (): ChatState => state
  const set: ChatStoreSet = (partial) => {
    const patch = typeof partial === 'function' ? partial(state) : partial
    state = { ...state, ...patch }
  }
  return {
    getState: () => state,
    set,
    get
  }
}

function makeThread(overrides: Partial<NormalizedThread> & Pick<NormalizedThread, 'id'>): NormalizedThread {
  return {
    id: overrides.id,
    title: overrides.title ?? overrides.id,
    updatedAt: overrides.updatedAt ?? '2026-06-01T00:00:00.000Z',
    model: overrides.model ?? 'deepseek-v4-pro',
    mode: overrides.mode ?? 'agent',
    workspace: overrides.workspace ?? '/workspace/deepseek-gui',
    ...(overrides.agentSurface ? { agentSurface: overrides.agentSurface } : {}),
    ...(overrides.archived !== undefined ? { archived: overrides.archived } : {}),
    ...(overrides.status ? { status: overrides.status } : {}),
    ...(overrides.relation ? { relation: overrides.relation } : {}),
    ...(overrides.parentThreadId ? { parentThreadId: overrides.parentThreadId } : {})
  }
}

describe('completion notification classification', () => {
  it.each([
    ['primary', 'main-agent'],
    ['fork', 'main-agent'],
    ['side', 'subagent'],
    [undefined, 'main-agent']
  ] as const)('classifies %s threads as %s', (relation, expected) => {
    const thread = makeThread({
      id: 'thread-classified',
      ...(relation ? { relation } : {})
    })

    expect(turnCompleteNotificationSource('thread-classified', { threads: [thread] }))
      .toBe(expected)
  })

  it('falls back to main-agent when the thread is not in the local list', () => {
    expect(turnCompleteNotificationSource('thread-missing', { threads: [] }))
      .toBe('main-agent')
  })

  it('recognizes an active side session even when sidebar filtering removed it', () => {
    expect(turnCompleteNotificationSource('thread-side', {
      threads: [],
      activeThreadId: 'thread-side',
      activeThreadRelation: 'side'
    })).toBe('subagent')
  })

  it('recognizes a tracked side conversation after navigation', () => {
    expect(turnCompleteNotificationSource('thread-side', {
      threads: [],
      sideConversations: {
        'thread-side': { threadId: 'thread-side' }
      } as unknown as ChatState['sideConversations']
    })).toBe('subagent')
  })
})

describe('code thread classification', () => {
  it('keeps archived Code threads visible for the sidebar archive view', () => {
    const archived = makeThread({ id: 'thr_archived', archived: true })

    expect(isCodeSidebarThread(archived)).toBe(true)
    expect(isCodeThread(archived)).toBe(false)
  })

  it('keeps legacy registered Design threads out of the unified Code task list', () => {
    const designRegistry = markDesignThread(
      '/workspace/deepseek-gui',
      'login-screen',
      'thr_design',
      emptyDesignThreadRegistry()
    )
    const design = makeThread({ id: 'thr_design' })

    expect(isCodeSidebarThread(design, [], undefined, designRegistry)).toBe(false)
    expect(isCodeThread(design, [], undefined, designRegistry)).toBe(false)
  })

  it('keeps standalone Design threads out of the unified Code task list', () => {
    const designTask = makeThread({
      id: 'thr_design_durable',
      title: 'Renamed by the user',
      agentSurface: 'design'
    })

    expect(isCodeSidebarThread(
      designTask,
      [],
      emptyWriteThreadRegistry(),
      emptyDesignThreadRegistry()
    )).toBe(false)
    expect(isCodeThread(
      designTask,
      [],
      emptyWriteThreadRegistry(),
      emptyDesignThreadRegistry()
    )).toBe(false)
  })

  it('includes Code-owned tasks that have an accepted Design profile', () => {
    const designTask = makeThread({
      id: 'thr_code_design',
      agentSurface: 'code',
      designProfile: {
        version: 1,
        documentTarget: { documentId: 'doc_1', boardArtifactId: 'board_1' },
        outputMedium: 'html',
        target: 'web',
        preset: 'none',
        context: { tone: [] },
        lockedAtTurnId: 'turn_1'
      }
    })

    expect(isCodeSidebarThread(designTask)).toBe(true)
    expect(isCodeThread(designTask)).toBe(true)
  })

  it('excludes durably classified Work threads without renderer registry data', () => {
    const writeThread = makeThread({
      id: 'thr_write_durable',
      title: 'Renamed by the user',
      agentSurface: 'write'
    })

    expect(isCodeSidebarThread(
      writeThread,
      [],
      emptyWriteThreadRegistry(),
      emptyDesignThreadRegistry()
    )).toBe(false)
    expect(isCodeThread(
      writeThread,
      [],
      emptyWriteThreadRegistry(),
      emptyDesignThreadRegistry()
    )).toBe(false)
  })

  it('excludes leaked default write assistant threads even without registry data', () => {
    const writeAssistant = makeThread({
      id: 'thr_write_leaked',
      title: WRITE_ASSISTANT_THREAD_TITLE
    })

    expect(isCodeSidebarThread(writeAssistant, [], emptyWriteThreadRegistry())).toBe(false)
    expect(isCodeThread(writeAssistant, [], emptyWriteThreadRegistry())).toBe(false)
  })

  it('excludes registered write assistant threads after they are renamed', () => {
    const writeRegistry = markWriteThread(
      '/workspace/deepseek-gui',
      'thr_write_registered',
      emptyWriteThreadRegistry()
    )
    const renamedWriteAssistant = makeThread({
      id: 'thr_write_registered',
      title: 'Draft intro'
    })

    expect(isCodeSidebarThread(renamedWriteAssistant, [], writeRegistry)).toBe(false)
    expect(isCodeThread(renamedWriteAssistant, [], writeRegistry)).toBe(false)
  })

  it('excludes threads stored in the internal design workspace even without registry data', () => {
    const designWorkspaceThread = makeThread({
      id: 'thr_design_workspace',
      title: 'Design Assistant',
      workspace: '/Users/zxy/.kun/design-workspace'
    })

    expect(isCodeSidebarThread(designWorkspaceThread)).toBe(false)
    expect(isCodeThread(designWorkspaceThread)).toBe(false)
  })

  it('shows a requirement thread in the project sidebar immediately without classifying it as Code', () => {
    const requirement = makeThread({
      id: 'thr_requirement',
      title: 'Requirement draft'
    })
    const hiddenRegistry = markSddAssistantThread({
      id: 'draft-1',
      workspaceRoot: '/workspace/deepseek-gui',
      relativePath: '.kunsdd/requirements/draft-1/requirement.md'
    }, requirement.id, null)
    const visibleRegistry = normalizeSddThreadRegistry({
      ...hiddenRegistry,
      drafts: Object.fromEntries(
        Object.entries(hiddenRegistry.drafts).map(([draftId, record]) => [
          draftId,
          { ...record, visibleThreadIds: [requirement.id] }
        ])
      )
    })

    expect(isCodeSidebarThread(
      requirement,
      [],
      undefined,
      undefined,
      hiddenRegistry
    )).toBe(true)
    expect(isCodeSidebarThread(
      requirement,
      [],
      undefined,
      undefined,
      visibleRegistry
    )).toBe(true)
    expect(isCodeThread(
      requirement,
      [],
      undefined,
      undefined,
      visibleRegistry
    )).toBe(false)
  })
})
