import type { ReactElement } from 'react'
import type { ProjectBoardCard, ProjectBoardStatus } from '../../project-board/project-board-types'
import { groupProjectBoardCards } from '../../project-board/project-board-selectors'
import { ProjectBoardColumn } from './ProjectBoardColumn'

type Props = {
  cards: ProjectBoardCard[]
  disabled: boolean
  mutatingCardId: string | null
  onAdd: (status: ProjectBoardStatus) => void
  onMove: (card: ProjectBoardCard, status: ProjectBoardStatus) => void
  onEdit: (card: ProjectBoardCard) => void
  onArchive: (card: ProjectBoardCard, archived: boolean) => void
  onDelete: (card: ProjectBoardCard) => void
  onOpenThread: (card: ProjectBoardCard) => void
  onOpenPlan: (card: ProjectBoardCard) => void
}

const STATUSES: ProjectBoardStatus[] = ['pending', 'in_progress', 'completed']

export function ProjectBoard(props: Props): ReactElement {
  const grouped = groupProjectBoardCards(props.cards)
  return (
    <div className="grid h-full min-h-[460px] min-w-[930px] grid-cols-3 gap-4">
      {STATUSES.map((status) => (
        <ProjectBoardColumn
          key={status}
          status={status}
          cards={grouped[status]}
          disabled={props.disabled}
          mutatingCardId={props.mutatingCardId}
          onAdd={() => props.onAdd(status)}
          onDropCard={(cardId) => {
            const card = props.cards.find((candidate) => candidate.id === cardId)
            if (card) props.onMove(card, status)
          }}
          cardActions={(card) => ({
            onMove: (next) => props.onMove(card, next),
            onEdit: () => props.onEdit(card),
            onArchive: (archived) => props.onArchive(card, archived),
            onDelete: () => props.onDelete(card),
            onOpenThread: () => props.onOpenThread(card),
            onOpenPlan: () => props.onOpenPlan(card)
          })}
        />
      ))}
    </div>
  )
}
