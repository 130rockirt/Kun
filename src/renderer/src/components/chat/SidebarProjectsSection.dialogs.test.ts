import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { act, create as createRenderer, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import type { NormalizedThread } from '../../agent/types'
import type { SddDraftHistoryItem } from '../../sdd/sdd-draft-history'
import { SidebarConversationsSection } from './SidebarConversationsSection'
import {
  buildSidebarThreadMoveTargets,
  buildSidebarDraftWorkspacePaths,
  buildSidebarWorkspaceGroups,
  filterEmptySddAssistantThreadsFromSidebar,
  filterSddDraftHistoryItems,
  isSidebarThreadMoveBlocked,
  mergeSidebarWorkspaceGroupsWithDraftHistory,
  MoveThreadDialog,
  prioritizeSidebarThreadActivity,
  resolveThreadPreviewPosition,
  sddDraftHistorySavedRevision,
  sidebarThreadActivity,
  sidebarOverlayPortalHost,
  SidebarProjectsSection,
  sortSidebarThreads,
  SddDraftHistoryRows,
  SidebarActionDialog,
  ThreadRow,
  ThreadRenameDialog
} from './SidebarProjectsSection'
import { SIDEBAR_ORDER_STORAGE_KEY } from './sidebar-order'
import { SIDEBAR_FOLDERS_STORAGE_KEY } from './sidebar-folders'
import { SIDEBAR_COLLAPSE_STORAGE_KEY } from './sidebar-collapse'

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({
    i18n: { language: 'en-US' },
    t: (key: string, opts?: Record<string, unknown>) =>
      key === 'sidebarThreadWorktree' ? `Worktree ${String(opts?.branch)}` : key
  })
}))

function thread(overrides: Partial<NormalizedThread> & Pick<NormalizedThread, 'id' | 'workspace'>): NormalizedThread {
  return {
    id: overrides.id,
    title: overrides.title ?? overrides.id,
    updatedAt: overrides.updatedAt ?? '2026-06-01T00:00:00.000Z',
    model: overrides.model ?? 'reasonix',
    mode: overrides.mode ?? 'agent',
    workspace: overrides.workspace,
    ...(overrides.preview ? { preview: overrides.preview } : {}),
    ...(overrides.latestTurnId ? { latestTurnId: overrides.latestTurnId } : {}),
    ...(overrides.status ? { status: overrides.status } : {}),
    ...(overrides.pinned !== undefined ? { pinned: overrides.pinned } : {}),
    ...(overrides.archived !== undefined ? { archived: overrides.archived } : {})
  }
}

function draft(overrides: Partial<SddDraftHistoryItem> & Pick<SddDraftHistoryItem, 'id' | 'title'>): SddDraftHistoryItem {
  const folder = overrides.id.replace(/[^a-z0-9-]/gi, '').slice(0, 36).padEnd(36, '0')
  return {
    id: overrides.id,
    workspaceRoot: overrides.workspaceRoot ?? '/tmp/app',
    relativePath: overrides.relativePath ?? `.kunsdd/draft/${folder}/requirement.md`,
    createdAt: overrides.createdAt ?? '2026-01-01T00:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-01-02T00:00:00.000Z',
    title: overrides.title,
    source: overrides.source ?? 'remembered',
    ...(overrides.chatThreadIds ? { chatThreadIds: overrides.chatThreadIds } : {}),
    ...(overrides.searchText ? { searchText: overrides.searchText } : {})
  }
}

function createSidebarTestStorage(initial: Record<string, string> = {}): Storage {
  const items = new Map(Object.entries(initial))
  return {
    get length() {
      return items.size
    },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => items.delete(key),
    setItem: (key, value) => items.set(key, value)
  }
}

function sidebarProjectProps(overrides: Record<string, unknown> = {}) {
  return {
    threads: [],
    activeView: 'chat' as const,
    activeThreadId: null,
    runtimeReady: true,
    threadListStatus: 'ready' as const,
    threadListError: null,
    onRetryThreads: vi.fn(),
    onLoadMoreThreads: vi.fn(),
    threadListCursorByWorkspace: {},
    searchQuery: '',
    showArchived: false,
    workspaceRoot: '/Users/zxy/project-a',
    workspaceRoots: ['/Users/zxy/project-a'],
    conversationRoot: '/Users/zxy/Documents/Kun',
    busy: false,
    watchTurnCompletion: {},
    unreadThreadIds: {},
    locale: 'en-US',
    onPickWorkspace: vi.fn(),
    onRemoveWorkspace: vi.fn(async () => undefined),
    onCreateThreadInWorkspace: vi.fn(),
    onSelectThread: vi.fn(),
    onRenameThread: vi.fn(async () => undefined),
    onPinThread: vi.fn(async () => undefined),
    onArchiveThread: vi.fn(async () => undefined),
    onDeleteThread: vi.fn(async () => undefined),
    onRestoreThread: vi.fn(async () => undefined),
    onSearchQueryChange: vi.fn(),
    t: (key: string) => key,
    ...overrides
  }
}


describe('ThreadRenameDialog', () => {
  it('renders an in-app rename form with the current thread title prefilled', () => {
    const html = renderToStaticMarkup(
      createElement(ThreadRenameDialog, {
        state: {
          thread: thread({
            id: 'thr_rename',
            title: 'Build rename dialog',
            workspace: '/Users/zxy/project-a'
          }),
          value: 'Build rename dialog',
          submitting: false
        },
        onClose: vi.fn(),
        onValueChange: vi.fn(),
        onSubmit: vi.fn(),
        t: (key: string) => key
      })
    )

    expect(html).toContain('role="dialog"')
    expect(html).toContain('sidebarThreadRename')
    expect(html).toContain('value="Build rename dialog"')
    expect(html).toContain('type="submit" disabled=""')
  })
})

describe('SidebarActionDialog', () => {
  it('mounts sidebar overlays on the document body so the sidebar cannot clip them', () => {
    const body = {} as HTMLElement
    const currentDocument = { body } as Document

    expect(sidebarOverlayPortalHost(currentDocument)).toBe(body)
    expect(sidebarOverlayPortalHost(undefined)).toBeNull()
  })

  it('uses an opaque card and stronger backdrop so sidebar controls cannot bleed through', () => {
    const html = renderToStaticMarkup(
      createElement(SidebarActionDialog, {
        state: {
          title: 'Remove AI training?',
          description: 'This removes the project from Kun.',
          detail: 'Files on disk will not be deleted.',
          confirmLabel: 'Remove',
          danger: true,
          submitting: false,
          onConfirm: async () => undefined
        },
        onClose: vi.fn(),
        onConfirm: vi.fn(),
        t: (key: string) => key
      })
    )

    expect(html).toContain('bg-slate-950/28')
    expect(html).toContain('dark:bg-black/45')
    expect(html).toContain('bg-[var(--surface-3)]')
    expect(html).not.toContain('bg-ds-elevated')
    expect(html).not.toContain('bg-ds-card/96')
  })
})

describe('MoveThreadDialog', () => {
  it('renders the target project picker', () => {
    const html = renderToStaticMarkup(
      createElement(MoveThreadDialog, {
        state: {
          thread: thread({
            id: 'thr_move',
            title: 'Move me',
            workspace: '/Users/zxy/project-a'
          }),
          targets: ['/Users/zxy/project-b'],
          targetWorkspace: null,
          submitting: false
        },
        onClose: vi.fn(),
        onPickTarget: vi.fn(),
        onConfirm: vi.fn(async () => undefined),
        t: (key: string) => key
      })
    )

    expect(html).toContain('sidebarThreadMovePickerTitle')
    expect(html).toContain('/Users/zxy/project-b')
    expect(html).toContain('project-b')
  })

  it('renders the empty state when no targets are available', () => {
    const html = renderToStaticMarkup(
      createElement(MoveThreadDialog, {
        state: {
          thread: thread({
            id: 'thr_move_empty',
            title: 'Move me',
            workspace: '/Users/zxy/project-a'
          }),
          targets: [],
          targetWorkspace: null,
          submitting: false
        },
        onClose: vi.fn(),
        onPickTarget: vi.fn(),
        onConfirm: vi.fn(async () => undefined),
        t: (key: string) => key
      })
    )

    expect(html).toContain('sidebarThreadMoveNoTargets')
  })

  it('shows the metadata-only scope before confirming a move', () => {
    const html = renderToStaticMarkup(
      createElement(MoveThreadDialog, {
        state: {
          thread: thread({
            id: 'thr_move_confirm',
            title: 'Move me',
            workspace: '/Users/zxy/project-a'
          }),
          targets: ['/Users/zxy/project-b'],
          targetWorkspace: '/Users/zxy/project-b',
          submitting: false
        },
        onClose: vi.fn(),
        onPickTarget: vi.fn(),
        onConfirm: vi.fn(async () => undefined),
        t: (key: string) => key
      })
    )

    expect(html).toContain('sidebarThreadMoveDialogDetail')
    expect(html).toContain('sidebarThreadMoveMetadataOnlyDetail')
    expect(html).toContain('sidebarThreadMoveConfirmButton')
  })
})

describe('ThreadRow', () => {
  it('retains active styling for the thread identified by the conversation title bar', () => {
    const html = renderToStaticMarkup(
      createElement(ThreadRow, {
        thread: thread({
          id: 'thr_active',
          title: 'Active conversation',
          workspace: '/Users/zxy/project-a'
        }),
        active: true,
        deleting: false,
        locale: 'en-US',
        showRunning: false,
        showUnread: false,
        onSelect: vi.fn(),
        onContextMenu: vi.fn(),
        onPreviewOpen: vi.fn(),
        onPreviewClose: vi.fn(),
        onPin: vi.fn(),
        onRename: vi.fn(),
        onArchive: vi.fn(),
        onDelete: vi.fn(),
        onRestore: vi.fn()
      })
    )

    expect(html).toContain('data-active="true"')
    expect(html).toContain('bg-[var(--ds-sidebar-row-active)]')
    expect(html).toContain('Active conversation')
  })

  it('anchors the preview beside the row instead of following the pointer', () => {
    expect(
      resolveThreadPreviewPosition(
        { left: 20, right: 300, top: 80, height: 34 } as DOMRect,
        { width: 900, height: 600 }
      )
    ).toEqual({ x: 310, y: 69 })
  })

  it('flips the preview left when the row is close to the right edge', () => {
    expect(
      resolveThreadPreviewPosition(
        { left: 700, right: 780, top: 80, height: 34 } as DOMRect,
        { width: 900, height: 600 }
      )
    ).toEqual({ x: 370, y: 69 })
  })

  it('renders the worktree badge before the truncated title and outside the action buttons', () => {
    const html = renderToStaticMarkup(
      createElement(ThreadRow, {
        thread: thread({
          id: 'thr_worktree',
          title: 'Very long archived worktree thread title',
          workspace: '/Users/zxy/project-a',
          archived: true
        }),
        worktreeRecord: {
          projectPath: '/Users/zxy/project-a',
          worktreePath: '/Users/zxy/.kun/worktrees/abcd/project-a',
          branch: 'feature/layout-fix'
        },
        active: false,
        deleting: false,
        locale: 'zh-CN',
        showRunning: false,
        showUnread: false,
        onSelect: vi.fn(),
        onContextMenu: vi.fn(),
        onPreviewOpen: vi.fn(),
        onPreviewClose: vi.fn(),
        onPin: vi.fn(),
        onRename: vi.fn(),
        onArchive: vi.fn(),
        onDelete: vi.fn(),
        onRestore: vi.fn()
      })
    )

    const rowButtonStart = html.indexOf('<button')
    const rowButtonEnd = html.indexOf('</button>', rowButtonStart)
    const rowButtonHtml = html.slice(rowButtonStart, rowButtonEnd)
    const actionsHtml = html.slice(rowButtonEnd)

    expect(rowButtonHtml.indexOf('aria-label="Worktree feature/layout-fix"')).toBeGreaterThan(-1)
    expect(rowButtonHtml.lastIndexOf('Very long archived worktree thread title')).toBeGreaterThan(-1)
    expect(rowButtonHtml.indexOf('aria-label="Worktree feature/layout-fix"')).toBeLessThan(
      rowButtonHtml.lastIndexOf('Very long archived worktree thread title')
    )
    expect(rowButtonHtml).toContain('min-w-[3.75rem]')
    expect(actionsHtml).toContain('sidebarThreadRestore')
    expect(actionsHtml).toContain('sidebarThreadDelete')
    expect(actionsHtml).not.toContain('Worktree feature/layout-fix')
  })

  it('renders pinned state and an unpin action for pinned threads', () => {
    const html = renderToStaticMarkup(
      createElement(ThreadRow, {
        thread: thread({
          id: 'thr_pinned',
          title: 'Pinned thread',
          workspace: '/Users/zxy/project-a',
          pinned: true
        }),
        active: false,
        deleting: false,
        locale: 'en-US',
        showRunning: false,
        showUnread: false,
        onSelect: vi.fn(),
        onContextMenu: vi.fn(),
        onPreviewOpen: vi.fn(),
        onPreviewClose: vi.fn(),
        onPin: vi.fn(),
        onRename: vi.fn(),
        onArchive: vi.fn(),
        onDelete: vi.fn(),
        onRestore: vi.fn()
      })
    )

    expect(html).toContain('sidebarThreadPinned')
    expect(html).toContain('sidebarThreadUnpin')
    expect(html).toContain('border-[var(--ds-sidebar-row-ring)]')
    expect(html).toContain('bg-[var(--ds-sidebar-row-active)]')
  })

  it('renders draggable and before-target feedback states', () => {
    const html = renderToStaticMarkup(
      createElement(ThreadRow, {
        thread: thread({ id: 'thr_drag', workspace: '/Users/zxy/project-a' }),
        active: false,
        deleting: false,
        locale: 'en-US',
        showRunning: false,
        showUnread: false,
        draggable: true,
        dragging: true,
        dropPosition: 'before',
        onSelect: vi.fn(),
        onContextMenu: vi.fn(),
        onPreviewOpen: vi.fn(),
        onPreviewClose: vi.fn(),
        onPin: vi.fn(),
        onRename: vi.fn(),
        onArchive: vi.fn(),
        onDelete: vi.fn(),
        onRestore: vi.fn()
      })
    )

    expect(html).toContain('draggable="true"')
    expect(html).toContain('opacity-55')
    expect(html).toContain('before:bg-accent')
  })
})
