import type { ReactElement } from 'react'
import { Code2, Palette, PencilLine } from 'lucide-react'
import { useTranslation } from 'react-i18next'

type Props = {
  activeView: 'chat' | 'write' | 'design' | 'claw' | 'schedule' | 'workflow' | 'subagents'
  onCodeOpen: () => void
  onWriteOpen: () => void
  onDesignOpen: () => void
  disabled?: boolean
  disabledReason?: string
}

export function WorkspaceModeTabs({
  activeView,
  onCodeOpen,
  onWriteOpen,
  onDesignOpen,
  disabled = false,
  disabledReason
}: Props): ReactElement {
  const { t } = useTranslation('common')

  const tabClass = (active: boolean): string =>
    `workspace-mode-tab group inline-flex min-h-8 flex-1 min-w-0 items-center justify-center gap-1.5 rounded-full border px-2 py-0.5 text-[13px] outline-none transition-[background-color,border-color,color] duration-150 focus-visible:ring-2 focus-visible:ring-accent/30 disabled:cursor-not-allowed disabled:opacity-55 ${
      active
        ? 'border-ds-border bg-ds-card font-medium text-ds-ink'
        : 'border-transparent font-normal text-ds-muted hover:bg-ds-hover hover:text-ds-ink'
    }`

  const iconClass = (active: boolean): string =>
    `h-[15px] w-[15px] shrink-0 transition-colors ${
      active
        ? 'text-ds-ink'
        : 'text-ds-faint group-hover:text-ds-ink'
    }`

  return (
    <div
      role="tablist"
      aria-label={`${t('code')} / ${t('write')} / ${t('design')}`}
      className="workspace-mode-tabs mb-1.5 flex flex-row gap-1 rounded-full border border-[var(--ds-sidebar-row-ring)] bg-[var(--ds-sidebar-field-bg)] p-0.5"
    >
      <button
        type="button"
        data-workspace-mode="chat"
        data-cursor-spotlight-target
        role="tab"
        aria-selected={activeView === 'chat'}
        disabled={disabled}
        onClick={onCodeOpen}
        className={tabClass(activeView === 'chat')}
        title={disabled ? disabledReason : t('code')}
      >
        <Code2 className={iconClass(activeView === 'chat')} strokeWidth={1.9} />
        <span className="workspace-mode-tab-label whitespace-nowrap">{t('code')}</span>
      </button>
      <button
        type="button"
        data-workspace-mode="write"
        data-cursor-spotlight-target
        role="tab"
        aria-selected={activeView === 'write'}
        disabled={disabled}
        onClick={onWriteOpen}
        className={tabClass(activeView === 'write')}
        title={disabled ? disabledReason : t('write')}
      >
        <PencilLine className={iconClass(activeView === 'write')} strokeWidth={1.9} />
        <span className="workspace-mode-tab-label whitespace-nowrap">{t('write')}</span>
      </button>
      <button
        type="button"
        data-workspace-mode="design"
        data-cursor-spotlight-target
        role="tab"
        aria-selected={activeView === 'design'}
        disabled={disabled}
        onClick={onDesignOpen}
        className={tabClass(activeView === 'design')}
        title={disabled ? disabledReason : t('design')}
      >
        <Palette className={iconClass(activeView === 'design')} strokeWidth={1.9} />
        <span className="workspace-mode-tab-label whitespace-nowrap">{t('design')}</span>
      </button>
    </div>
  )
}
