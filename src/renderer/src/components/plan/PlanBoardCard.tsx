import { Check, Circle, LoaderCircle } from 'lucide-react'
import type { DragEvent, ReactElement } from 'react'
import type { ThreadTodoStatus } from '../../agent/types'
import type { PlanBoardCard as CardModel } from '../../plan/plan-board-model'

type Props = {
  card: CardModel
  disabled: boolean
  pending: boolean
  statusLabels: Record<ThreadTodoStatus, string>
  onMove: (card: CardModel, status: ThreadTodoStatus) => void
}

export function PlanBoardCard({ card, disabled, pending, statusLabels, onMove }: Props): ReactElement {
  const Icon = card.status === 'completed' ? Check : card.status === 'in_progress' ? LoaderCircle : Circle
  const handleDragStart = (event: DragEvent<HTMLElement>): void => {
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', card.id)
  }
  return (
    <article
      data-plan-card-id={card.id}
      draggable={!disabled && Boolean(card.todoId)}
      onDragStart={handleDragStart}
      className={`rounded-xl border bg-ds-card px-3 py-3 shadow-sm transition-colors motion-reduce:transition-none ${
        card.status === 'in_progress' ? 'border-accent/55 ring-1 ring-accent/15' : 'border-ds-border-muted'
      } ${disabled ? '' : 'cursor-grab active:cursor-grabbing'}`}
    >
      <div className="flex items-start gap-2.5">
        <Icon
          aria-hidden="true"
          className={`mt-0.5 h-4 w-4 shrink-0 ${
            card.status === 'completed' ? 'text-emerald-500' : card.status === 'in_progress' ? 'animate-spin text-accent motion-reduce:animate-none' : 'text-ds-faint'
          }`}
          strokeWidth={2}
        />
        <div className="min-w-0 flex-1">
          {card.sectionTitle ? (
            <div className="mb-1 truncate text-[10.5px] font-semibold uppercase tracking-[0.04em] text-ds-faint">
              {card.sectionTitle}
            </div>
          ) : null}
          <div className={`text-[13px] leading-5 ${card.status === 'completed' ? 'text-ds-muted line-through' : 'text-ds-ink'}`}>
            {card.title}
          </div>
        </div>
      </div>
      {card.todoId ? (
        <div className="mt-2.5 flex justify-end">
          <select
            aria-label={`${card.title}: ${statusLabels[card.status]}`}
            value={card.status}
            disabled={disabled || pending}
            onChange={(event) => onMove(card, event.target.value as ThreadTodoStatus)}
            className="max-w-full rounded-lg border border-ds-border-muted bg-ds-surface-subtle px-2 py-1 text-[11px] font-medium text-ds-muted outline-none focus-visible:ring-2 focus-visible:ring-accent/35 disabled:opacity-50"
          >
            {(['pending', 'in_progress', 'completed'] as const).map((status) => (
              <option key={status} value={status}>{statusLabels[status]}</option>
            ))}
          </select>
        </div>
      ) : null}
    </article>
  )
}
