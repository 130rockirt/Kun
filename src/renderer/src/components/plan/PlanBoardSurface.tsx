import { useMemo, useState, type ReactElement } from 'react'
import { LayoutList, Rows3 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useChatStore } from '../../store/chat-store'
import { buildPlanBoardCards } from '../../plan/plan-board-model'
import { useGuiPlanStore } from '../../plan/plan-store'
import { PlanBoard } from './PlanBoard'

export function PlanBoardSurface({ disabled }: { disabled: boolean }): ReactElement {
  const { t } = useTranslation('common')
  const activePlan = useGuiPlanStore((state) => state.activePlan)
  const content = useGuiPlanStore((state) => state.content)
  const markSaved = useGuiPlanStore((state) => state.markSaved)
  const setSaveStatus = useGuiPlanStore((state) => state.setSaveStatus)
  const surfaceMode = useGuiPlanStore((state) => state.surfaceMode)
  const setSurfaceMode = useGuiPlanStore((state) => state.setSurfaceMode)
  const todos = useChatStore((state) => state.activeThreadTodos)
  const setStatus = useChatStore((state) => state.setActiveThreadTodoStatus)
  const [pendingId, setPendingId] = useState<string | null>(null)
  const cards = useMemo(() => activePlan ? buildPlanBoardCards({
    markdown: content,
    planId: activePlan.id,
    relativePath: activePlan.relativePath,
    todos
  }) : [], [activePlan, content, todos])
  const completed = cards.filter((card) => card.status === 'completed').length

  const move = async (card: (typeof cards)[number], status: (typeof card)['status']): Promise<void> => {
    if (!card.todoId || !activePlan || pendingId) return
    const planId = activePlan.id
    setPendingId(card.id)
    const ok = await setStatus(card.todoId, status)
    if (!ok || useGuiPlanStore.getState().activePlan?.id !== planId) {
      setPendingId(null)
      return
    }
    try {
      const result = await window.kunGui.readWorkspaceFile({
        workspaceRoot: activePlan.workspaceRoot,
        path: activePlan.relativePath
      })
      if (result.ok && useGuiPlanStore.getState().activePlan?.id === planId) markSaved(result.content)
      else if (!result.ok) setSaveStatus('error', result.message)
    } catch (error) {
      setSaveStatus('error', error instanceof Error ? error.message : String(error))
    } finally {
      setPendingId(null)
    }
  }

  return (
    <div className={`flex min-h-0 flex-col ${surfaceMode === 'board' ? 'h-full' : 'shrink-0'}`}>
      <div className="flex shrink-0 items-center gap-2 border-b border-ds-border-muted px-3 py-2">
        <div className="inline-flex rounded-lg bg-ds-surface-subtle p-0.5" role="tablist" aria-label={t('planViewMode')}>
          <button type="button" role="tab" aria-selected={surfaceMode === 'board'}
            onClick={() => setSurfaceMode('board')}
            className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[11.5px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/35 ${surfaceMode === 'board' ? 'bg-ds-card text-ds-ink shadow-sm' : 'text-ds-muted'}`}>
            <Rows3 className="h-3.5 w-3.5" />{t('planBoardView')}
          </button>
          <button type="button" role="tab" aria-selected={surfaceMode === 'document'}
            onClick={() => setSurfaceMode('document')}
            className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[11.5px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/35 ${surfaceMode === 'document' ? 'bg-ds-card text-ds-ink shadow-sm' : 'text-ds-muted'}`}>
            <LayoutList className="h-3.5 w-3.5" />{t('planDocumentView')}
          </button>
        </div>
        {cards.length ? (
          <span className="ml-auto text-[11.5px] font-medium text-ds-muted">
            {t('planBoardProgress', { completed, total: cards.length })}
          </span>
        ) : null}
      </div>
      {surfaceMode === 'board' ? (
        cards.length ? (
          <PlanBoard cards={cards} disabled={disabled} pendingId={pendingId} onMove={(card, status) => void move(card, status)} />
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
            <Rows3 className="h-8 w-8 text-ds-faint" strokeWidth={1.5} />
            <div className="mt-3 text-[14px] font-semibold text-ds-ink">{t('planBoardNoTasks')}</div>
            <p className="mt-1 max-w-[24rem] text-[12px] leading-5 text-ds-muted">{t('planBoardNoTasksHint')}</p>
            <button type="button" onClick={() => setSurfaceMode('document')}
              className="mt-4 rounded-lg border border-ds-border-muted bg-ds-card px-3 py-1.5 text-[12px] font-semibold text-ds-ink hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/35">
              {t('planDocumentView')}
            </button>
          </div>
        )
      ) : null}
    </div>
  )
}
