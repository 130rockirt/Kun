import type { ReactElement } from 'react'
import { MoreHorizontal, PencilLine, Shapes, Trash2 } from 'lucide-react'
import type { WorkWhiteboard } from '../../write/write-workspace-store'
import { SidebarCommandRow, SidebarSectionHeader } from '../sidebar/SidebarPrimitives'

type Props = {
  whiteboards: WorkWhiteboard[]
  activeWhiteboardId: string | null
  openMenuId: string | null
  label: string
  moreActionsLabel: string
  renameLabel: string
  deleteLabel: string
  onOpen: (boardId: string) => void
  onToggleMenu: (boardId: string) => void
  onRename: (board: WorkWhiteboard) => void
  onDelete: (board: WorkWhiteboard) => void
}

export function WorkWhiteboardSidebarSection({
  whiteboards,
  activeWhiteboardId,
  openMenuId,
  label,
  moreActionsLabel,
  renameLabel,
  deleteLabel,
  onOpen,
  onToggleMenu,
  onRename,
  onDelete
}: Props): ReactElement | null {
  if (whiteboards.length === 0) return null
  return (
    <div className="px-1 pb-2">
      <SidebarSectionHeader label={label} />
      {[...whiteboards]
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .map((board) => (
          <div key={board.id} className="relative flex min-w-0 items-center">
            <div className="min-w-0 flex-1">
              <SidebarCommandRow
                icon={<Shapes className="h-3.5 w-3.5" strokeWidth={1.75} />}
                label={board.title}
                onClick={() => onOpen(board.id)}
                active={activeWhiteboardId === board.id}
                trailing={board.phase !== 'blank' ? (
                  <span className={`h-2 w-2 rounded-full ${
                    board.phase === 'complete' ? 'bg-emerald-500' : 'bg-amber-500'
                  }`} />
                ) : null}
              />
            </div>
            <button
              type="button"
              className="ml-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-ds-faint hover:bg-ds-hover hover:text-ds-ink"
              aria-label={moreActionsLabel}
              onClick={() => onToggleMenu(board.id)}
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </button>
            {openMenuId === board.id ? (
              <div className="absolute right-0 top-full z-50 mt-1 w-40 rounded-xl border border-ds-border bg-ds-card p-1.5 shadow-xl">
                <button
                  type="button"
                  className="write-tabbar-menu-item"
                  onClick={() => onRename(board)}
                >
                  <PencilLine className="h-3.5 w-3.5" />{renameLabel}
                </button>
                <button
                  type="button"
                  className="write-tabbar-menu-item text-red-600 dark:text-red-300"
                  onClick={() => onDelete(board)}
                >
                  <Trash2 className="h-3.5 w-3.5" />{deleteLabel}
                </button>
              </div>
            ) : null}
          </div>
        ))}
    </div>
  )
}
