import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { AlertTriangle, Columns3, RefreshCw, WifiOff } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useChatStore } from '../../store/chat-store'
import { normalizeWorkspaceRoot, workspaceRootIdentityKey } from '../../lib/workspace-path'
import { openWorkspaceFileWithSystemDefault } from '../../lib/open-workspace-path'
import { resolveProjectWorkspacePath } from '../../lib/worktree-project-path'
import { readThreadWorktreeRegistry } from '../../lib/thread-worktree-registry'
import { useProjectBoardStore } from '../../project-board/project-board-store'
import { selectVisibleProjectBoardCards } from '../../project-board/project-board-selectors'
import type { ProjectBoardCard, ProjectBoardStatus } from '../../project-board/project-board-types'
import { ProjectBoard } from './ProjectBoard'
import { ProjectBoardArchive } from './ProjectBoardArchive'
import { ProjectBoardCardDialog, type ProjectBoardCardDraft } from './ProjectBoardCardDialog'
import { ProjectBoardHeader } from './ProjectBoardHeader'
import { ProjectBoardOverview } from './ProjectBoardOverview'
import { ProjectBoardToolbar } from './ProjectBoardToolbar'

type Props = {
  leftSidebarCollapsed: boolean
  onToggleLeftSidebar: () => void
}

export function ProjectBoardView(props: Props): ReactElement {
  const { t } = useTranslation('common')
  const runtimeReady = useChatStore((state) => state.runtimeConnection === 'ready')
  const workspaceRoot = useChatStore((state) => state.workspaceRoot)
  const workspaceRoots = useChatStore((state) => state.codeWorkspaceRoots)
  const activeThread = useChatStore((state) =>
    state.threads.find((thread) => thread.id === state.activeThreadId) ?? null)
  const activeTodosUpdatedAt = useChatStore((state) => state.activeThreadTodos?.updatedAt ?? '')
  const board = useProjectBoardStore()
  const selectBoardWorkspace = board.selectWorkspace
  const loadBoard = board.loadBoard
  const [dialog, setDialog] = useState<{ card?: ProjectBoardCard; status: ProjectBoardStatus } | null>(null)
  const selected = board.selectedWorkspaceRoot
  const snapshot = board.snapshotByWorkspace[selected]
  const activeThreadProjectWorkspace = useMemo(() => activeThread
    ? resolveProjectWorkspacePath(activeThread.workspace ?? '', {
        threadWorktrees: readThreadWorktreeRegistry().worktrees,
        candidateProjectPaths: [selected, workspaceRoot, ...workspaceRoots]
      })
    : '', [activeThread, selected, workspaceRoot, workspaceRoots])

  useEffect(() => {
    if (selected) return
    const fallback = normalizeWorkspaceRoot(workspaceRoot) || workspaceRoots[0]
    if (fallback) selectBoardWorkspace(fallback)
  }, [selectBoardWorkspace, selected, workspaceRoot, workspaceRoots])

  useEffect(() => {
    if (selected && runtimeReady) void loadBoard(selected)
  }, [loadBoard, runtimeReady, selected])

  useEffect(() => {
    if (!selected || !runtimeReady) return
    const refresh = (): void => {
      if (document.visibilityState === 'visible') void loadBoard(selected, { force: true })
    }
    const interval = window.setInterval(refresh, 15_000)
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      window.clearInterval(interval)
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [loadBoard, runtimeReady, selected])

  useEffect(() => {
    if (!activeTodosUpdatedAt || !runtimeReady ||
      workspaceRootIdentityKey(activeThreadProjectWorkspace) !== workspaceRootIdentityKey(selected)) return
    const timer = window.setTimeout(() => void loadBoard(selected, { force: true }), 250)
    return () => window.clearTimeout(timer)
  }, [activeThreadProjectWorkspace, activeTodosUpdatedAt, loadBoard, runtimeReady, selected])

  const visible = useMemo(() => selectVisibleProjectBoardCards({
    cards: snapshot?.cards ?? [],
    searchQuery: board.searchQuery,
    filters: board.filters,
    archived: board.activeTab === 'archive'
  }), [board.activeTab, board.filters, board.searchQuery, snapshot?.cards])
  const disabled = !runtimeReady || Boolean(board.mutatingCardId)

  const editOverlay = (card: ProjectBoardCard, patch: { archived?: boolean }): void => {
    if (card.kind === 'manual') void board.patchManualCard(card.id, patch)
    else void board.patchTodoOverlay(card, patch)
  }
  const openThread = (card: ProjectBoardCard): void => {
    if (card.source.threadId) void useChatStore.getState().selectThread(card.source.threadId)
  }
  const openPlan = (card: ProjectBoardCard): void => {
    if (card.source.planRelativePath) {
      void openWorkspaceFileWithSystemDefault(card.source.planRelativePath, card.workspaceRoot)
    }
  }
  const submitDialog = async (draft: ProjectBoardCardDraft): Promise<void> => {
    if (!dialog) return
    if (!dialog.card) {
      const id = await board.createManualCard({
        title: draft.title,
        description: draft.description,
        status: draft.status,
        category: draft.category ?? 'other',
        priority: draft.priority
      })
      if (!id) return
      setDialog(null)
      requestAnimationFrame(() => document.getElementById(`project-board-${cssId(id)}`)?.focus())
      return
    }
    if (dialog.card.kind === 'manual') {
      await board.patchManualCard(dialog.card.id, {
        title: draft.title,
        description: draft.description,
        status: draft.status,
        category: draft.category ?? 'other',
        priority: draft.priority
      })
    } else {
      await board.patchTodoOverlay(dialog.card, {
        description: draft.description,
        category: draft.category,
        priority: draft.priority
      })
    }
    if (!useProjectBoardStore.getState().error) setDialog(null)
  }

  if (!selected) {
    return <EmptyWorkspace leftSidebarCollapsed={props.leftSidebarCollapsed} onToggleLeftSidebar={props.onToggleLeftSidebar} />
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-ds-main text-ds-ink">
      <ProjectBoardHeader
        workspaceRoot={selected}
        activeTab={board.activeTab}
        leftSidebarCollapsed={props.leftSidebarCollapsed}
        onToggleLeftSidebar={props.onToggleLeftSidebar}
        onTab={board.setActiveTab}
        onNewTask={() => setDialog({ status: 'pending' })}
      />
      {!runtimeReady ? (
        <div className="ds-no-drag flex items-center gap-2 border-b border-amber-500/20 bg-amber-500/10 px-6 py-2 text-xs text-amber-800 dark:text-amber-200">
          <WifiOff className="h-3.5 w-3.5" /> {t('projectBoardOffline')}
        </div>
      ) : null}
      {board.error ? (
        <div className="ds-no-drag flex items-center gap-2 border-b border-red-500/20 bg-red-500/10 px-6 py-2 text-xs text-red-700 dark:text-red-300">
          <AlertTriangle className="h-3.5 w-3.5" />
          <span className="min-w-0 flex-1 truncate">{board.error}</span>
          <button type="button" onClick={() => void board.loadBoard(selected, { force: true })} className="flex items-center gap-1 hover:underline">
            <RefreshCw className="h-3 w-3" /> {t('projectBoardRetry')}
          </button>
        </div>
      ) : null}
      <div className="min-h-0 flex-1">
        {board.loading && !snapshot ? (
          <BoardSkeleton />
        ) : board.activeTab === 'overview' ? (
          <ProjectBoardOverview cards={snapshot?.cards ?? []} />
        ) : board.activeTab === 'archive' ? (
          <ProjectBoardArchive cards={visible} disabled={disabled} onRestore={(card) => editOverlay(card, { archived: false })} />
        ) : (
          <div className="flex h-full min-h-0 gap-4 overflow-x-auto overflow-y-hidden p-4 sm:p-5">
            <ProjectBoardToolbar
              query={board.searchQuery}
              filters={board.filters}
              resultCount={visible.length}
              onQuery={board.setSearchQuery}
              onFilters={board.setFilters}
            />
            <div className="min-h-0 flex-1">
              {visible.length === 0 && (snapshot?.counts.total ?? 0) === 0 ? (
                <BoardEmpty onNew={() => setDialog({ status: 'pending' })} />
              ) : (
                <ProjectBoard
                  cards={visible}
                  disabled={disabled}
                  mutatingCardId={board.mutatingCardId}
                  onAdd={(status) => setDialog({ status })}
                  onMove={(card, status) => void board.moveCard(card, status)}
                  onEdit={(card) => setDialog({ card, status: card.status })}
                  onArchive={(card, archived) => editOverlay(card, { archived })}
                  onDelete={(card) => {
                    if (window.confirm(t('projectBoardDeleteConfirm'))) void board.deleteManualCard(card.id)
                  }}
                  onOpenThread={openThread}
                  onOpenPlan={openPlan}
                />
              )}
              {snapshot?.truncated ? (
                <button type="button" onClick={() => void board.loadMore(selected)} className="mt-2 text-xs text-accent hover:underline">
                  {t('projectBoardLoadMore')}
                </button>
              ) : null}
            </div>
          </div>
        )}
      </div>
      {dialog ? (
        <ProjectBoardCardDialog
          card={dialog.card}
          initialStatus={dialog.status}
          busy={Boolean(board.mutatingCardId)}
          onClose={() => setDialog(null)}
          onSubmit={submitDialog}
        />
      ) : null}
    </div>
  )
}

function EmptyWorkspace(props: Props): ReactElement {
  const { t } = useTranslation('common')
  return <div className="flex h-full items-center justify-center bg-ds-main text-sm text-ds-faint">{t('projectBoardNoProjects')}</div>
}
function BoardEmpty({ onNew }: { onNew: () => void }): ReactElement {
  const { t } = useTranslation('common')
  return (
    <div className="flex h-full min-h-[460px] min-w-[700px] flex-col items-center justify-center rounded-2xl border border-dashed border-ds-border-muted text-center">
      <Columns3 className="h-9 w-9 text-ds-faint" strokeWidth={1.3} />
      <h2 className="mt-3 text-sm font-semibold text-ds-ink">{t('projectBoardNoTasks')}</h2>
      <p className="mt-1 max-w-sm text-xs leading-5 text-ds-muted">{t('projectBoardNoTasksHint')}</p>
      <button type="button" onClick={onNew} className="mt-4 rounded-xl bg-accent px-4 py-2 text-xs font-medium text-white">{t('projectBoardNewTask')}</button>
    </div>
  )
}
function BoardSkeleton(): ReactElement {
  return <div className="grid h-full min-w-[930px] grid-cols-3 gap-4 p-5">{[0, 1, 2].map((column) => <div key={column} className="animate-pulse rounded-2xl border border-ds-border-muted bg-ds-main/50 p-3"><div className="h-5 w-24 rounded bg-ds-card" /><div className="mt-5 h-28 rounded-xl bg-ds-card" /><div className="mt-3 h-28 rounded-xl bg-ds-card" /></div>)}</div>
}
function cssId(value: string): string { return value.replace(/[^A-Za-z0-9_-]/g, '-') }
