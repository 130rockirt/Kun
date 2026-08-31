import { useState, type DragEvent, type ReactElement } from 'react'
import { Plus } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ProjectBoardCard, ProjectBoardStatus } from '../../project-board/project-board-types'
import { ProjectBoardCard as CardView } from './ProjectBoardCard'

type Props = {
  status: ProjectBoardStatus
  cards: ProjectBoardCard[]
  disabled: boolean
  mutatingCardId: string | null
  onAdd: () => void
  onDropCard: (cardId: string) => void
  cardActions: (card: ProjectBoardCard) => Omit<React.ComponentProps<typeof CardView>, 'card' | 'disabled' | 'pending'>
}

export function ProjectBoardColumn(props: Props): ReactElement {
  const { t } = useTranslation('common')
  const [dragOver, setDragOver] = useState(false)
  const drop = (event: DragEvent): void => {
    event.preventDefault()
    setDragOver(false)
    const id = event.dataTransfer.getData('application/x-kun-project-board-card')
    if (id) props.onDropCard(id)
  }
  const label = props.status === 'pending' ? t('projectBoardPending') :
    props.status === 'in_progress' ? t('projectBoardInProgress') : t('projectBoardCompleted')
  return (
    <section
      onDragOver={(event) => { event.preventDefault(); setDragOver(true) }}
      onDragLeave={() => setDragOver(false)}
      onDrop={drop}
      className={`flex min-h-0 min-w-[286px] flex-1 flex-col rounded-2xl border transition motion-reduce:transition-none ${
        dragOver ? 'border-accent bg-accent/5' : 'border-ds-border-muted bg-ds-main/55'
      }`}
    >
      <header className="sticky top-0 z-10 flex h-12 shrink-0 items-center justify-between rounded-t-2xl border-b border-ds-border-muted bg-ds-main/95 px-4 backdrop-blur">
        <h2 className="text-[13px] font-semibold text-ds-ink">{label}</h2>
        <span className="text-xs tabular-nums text-ds-faint">{props.cards.length}</span>
      </header>
      <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto p-3">
        {props.cards.map((card) => (
          <CardView
            key={card.id}
            card={card}
            disabled={props.disabled}
            pending={props.mutatingCardId === card.id}
            {...props.cardActions(card)}
          />
        ))}
        {props.cards.length === 0 ? <p className="px-2 py-8 text-center text-xs text-ds-faint">{t('projectBoardEmptyColumn')}</p> : null}
      </div>
      <button
        type="button"
        disabled={props.disabled}
        onClick={props.onAdd}
        className="sticky bottom-0 flex h-11 shrink-0 items-center gap-2 rounded-b-2xl border-t border-ds-border-muted bg-ds-main/95 px-4 text-xs text-ds-muted hover:text-ds-ink disabled:opacity-40"
      >
        <Plus className="h-3.5 w-3.5" /> {t('projectBoardAddTask')}
      </button>
    </section>
  )
}
