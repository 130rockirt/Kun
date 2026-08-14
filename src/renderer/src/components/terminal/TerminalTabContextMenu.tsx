import type { ReactElement } from 'react'
import { PanelRightClose, PanelsTopLeft, PencilLine } from 'lucide-react'
import type { TerminalTabContextMenu as TerminalTabContextMenuState } from './terminal-panel-support'

export function TerminalTabContextMenu({
  state,
  tabCount,
  onRename,
  onCloseOthers,
  onCloseAll,
  t
}: {
  state: TerminalTabContextMenuState
  tabCount: number
  onRename: () => void
  onCloseOthers: () => void
  onCloseAll: () => void
  t: (key: string, options?: Record<string, unknown>) => string
}): ReactElement {
  const run = (action: () => void): void => {
    action()
  }

  return (
    <div
      role="menu"
      aria-label={t('terminalTabMenuTitle')}
      className="ds-no-drag fixed z-[1000] min-w-[196px] rounded-lg border border-ds-border bg-ds-card/98 p-1 text-[13px] text-ds-ink shadow-[0_18px_48px_rgba(2,6,16,0.28)] backdrop-blur-xl dark:bg-ds-card"
      style={{ left: state.x, top: state.y }}
      onPointerDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      <TerminalTabContextMenuItem
        icon={<PencilLine className="h-3.5 w-3.5" strokeWidth={1.9} />}
        label={t('terminalRenameTab')}
        onClick={() => run(onRename)}
      />
      <div className="my-1 h-px bg-ds-border-muted" />
      <TerminalTabContextMenuItem
        icon={<PanelRightClose className="h-3.5 w-3.5" strokeWidth={1.9} />}
        label={t('terminalCloseOtherTabs')}
        disabled={tabCount <= 1}
        onClick={() => run(onCloseOthers)}
      />
      <TerminalTabContextMenuItem
        icon={<PanelsTopLeft className="h-3.5 w-3.5" strokeWidth={1.9} />}
        label={t('terminalCloseAllTabs')}
        danger
        onClick={() => run(onCloseAll)}
      />
    </div>
  )
}

function TerminalTabContextMenuItem({
  icon,
  label,
  disabled = false,
  danger = false,
  onClick
}: {
  icon: ReactElement
  label: string
  disabled?: boolean
  danger?: boolean
  onClick: () => void
}): ReactElement {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className={`flex min-h-[30px] w-full items-center gap-2 rounded-md px-2 text-left transition disabled:cursor-not-allowed disabled:opacity-50 ${
        danger
          ? 'text-red-600 hover:bg-red-500/10 dark:text-red-300'
          : 'text-ds-ink hover:bg-[var(--ds-sidebar-row-hover)]'
      }`}
    >
      <span className="shrink-0 text-current">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  )
}
