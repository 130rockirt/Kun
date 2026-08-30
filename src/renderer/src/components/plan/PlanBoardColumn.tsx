import type { DragEvent, ReactElement } from 'react'
import type { ThreadTodoStatus } from '../../agent/types'
import type { PlanBoardCard as CardModel } from '../../plan/plan-board-model'
import { PlanBoardCard } from './PlanBoardCard'

type Props = {
  title: string
  status: ThreadTodoStatus
  cards: CardModel[]
  disabled: boolean
  pendingId: string | null
  emptyLabel: string
  statusLabels: Record<ThreadTodoStatus, string>
  onMove: (card: CardModel, status: ThreadTodoStatus) => void
  onDropCard: (id: string, status: ThreadTodoStatus) => void
}

export function PlanBoardColumn({
  title, status, cards, disabled, pendingId, emptyLabel, statusLabels, onMove, onDropCard
}: Props): ReactElement {
  const handleDrop = (event: DragEvent<HTMLElement>): void => {
    event.preventDefault()
    const id = event.dataTransfer.getData('text/plain')
    if (id) onDropCard(id, status)
  }
  return (
    <section
      aria-label={title}
      onDragOver={(event) => { if (!disabled) event.preventDefault() }}
      onDrop={handleDrop}
      className="flex min-h-[12rem] w-[232px] min-w-[232px] flex-col rounded-2xl bg-ds-surface-subtle/70 p-2.5"
    >
      <header className="mb-2 flex items-center justify-between px-1">
        <h3 className="text-[12px] font-semibold text-ds-ink">{title}</h3>
        <span className="rounded-full bg-ds-card px-2 py-0.5 text-[10.5px] font-semibold text-ds-muted">{cards.length}</span>
      </header>
      <div className="flex flex-col gap-2">
        {cards.length ? cards.map((card) => (
          <PlanBoardCard
            key={card.id}
            card={card}
            disabled={disabled}
            pending={pendingId === card.id}
            statusLabels={statusLabels}
            onMove={onMove}
          />
        )) : (
          <div className="rounded-xl border border-dashed border-ds-border-muted px-3 py-6 text-center text-[11.5px] text-ds-faint">
            {emptyLabel}
          </div>
        )}
      </div>
    </section>
  )
}
