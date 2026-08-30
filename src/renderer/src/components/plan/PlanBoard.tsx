import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import type { ThreadTodoStatus } from '../../agent/types'
import type { PlanBoardCard as CardModel } from '../../plan/plan-board-model'
import { PlanBoardColumn } from './PlanBoardColumn'

type Props = {
  cards: CardModel[]
  disabled: boolean
  pendingId: string | null
  onMove: (card: CardModel, status: ThreadTodoStatus) => void
}

const STATUSES: ThreadTodoStatus[] = ['pending', 'in_progress', 'completed']

export function PlanBoard({ cards, disabled, pendingId, onMove }: Props): ReactElement {
  const { t } = useTranslation('common')
  const [optimistic, setOptimistic] = useState<Record<string, ThreadTodoStatus>>({})
  useEffect(() => {
    if (!pendingId) setOptimistic({})
  }, [pendingId, cards])
  const visibleCards = useMemo(() => cards.map((card) => ({
    ...card,
    status: optimistic[card.id] ?? card.status
  })), [cards, optimistic])
  const statusLabels: Record<ThreadTodoStatus, string> = {
    pending: t('planBoardPending'),
    in_progress: t('planBoardInProgress'),
    completed: t('planBoardCompleted')
  }
  const move = (card: CardModel, status: ThreadTodoStatus): void => {
    if (disabled || pendingId || card.status === status) return
    setOptimistic((current) => ({ ...current, [card.id]: status }))
    onMove(card, status)
  }
  const drop = (id: string, status: ThreadTodoStatus): void => {
    const card = visibleCards.find((candidate) => candidate.id === id)
    if (card) move(card, status)
  }
  return (
    <div className="h-full min-h-0 overflow-x-auto overflow-y-auto p-3">
      <div className="flex min-w-max items-start gap-3 pb-2">
        {STATUSES.map((status) => (
          <PlanBoardColumn
            key={status}
            title={statusLabels[status]}
            status={status}
            cards={visibleCards.filter((card) => card.status === status)}
            disabled={disabled}
            pendingId={pendingId}
            emptyLabel={t('planBoardEmptyColumn')}
            statusLabels={statusLabels}
            onMove={move}
            onDropCard={drop}
          />
        ))}
      </div>
    </div>
  )
}
