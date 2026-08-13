import type { ReactElement } from 'react'
import { Focus } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { SidebarMascot } from '../chat/AnimatedWorkLogo'

type Props = {
  enabled: boolean
  onChange: (enabled: boolean) => void
}

export function SidebarFocusModeControl({ enabled, onChange }: Props): ReactElement {
  const { t } = useTranslation('common')

  return (
    <div className="ds-sidebar-focus-row flex min-h-[42px] items-center justify-center gap-2.5 pb-1">
      {!enabled ? (
        <span className="ds-sidebar-mascot-slot flex h-[46px] w-[56px] shrink-0 items-center justify-center">
          <SidebarMascot />
        </span>
      ) : null}
      <button
        type="button"
        data-cursor-spotlight-target
        role="switch"
        aria-checked={enabled}
        aria-label={t('focusModeToggleLabel')}
        title={`${t('focusModeToggleTitle')} · ${enabled ? t('switchOn') : t('switchOff')}`}
        onClick={() => onChange(!enabled)}
        className={`ds-focus-mode-toggle group inline-flex h-8 w-[112px] shrink-0 items-center justify-between overflow-hidden rounded-[10px] border px-2.5 text-[12px] font-medium outline-none transition focus-visible:ring-2 focus-visible:ring-accent/25 ${
          enabled
            ? 'border-accent/35 bg-[var(--ds-sidebar-row-active)] text-[#1f1f1f] shadow-[0_1px_3px_rgba(20,47,95,0.07),inset_0_0_0_1px_var(--ds-sidebar-row-ring),inset_0_1px_0_rgba(255,255,255,0.72)] dark:text-white'
            : 'border-[var(--ds-sidebar-divider)] bg-[var(--ds-sidebar-field-bg)] text-[#5c6675] shadow-[inset_0_1px_0_rgba(255,255,255,0.46)] hover:bg-[var(--ds-sidebar-row-hover)] hover:text-[#1f2733] dark:text-white/62 dark:shadow-none dark:hover:text-white'
        }`}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <Focus className="h-3.5 w-3.5 shrink-0" strokeWidth={1.8} aria-hidden="true" />
          <span className="min-w-0 truncate">{t('focusMode')}</span>
        </span>
        <span
          className={`ds-focus-mode-toggle-track relative h-4 w-7 shrink-0 rounded-full transition ${
            enabled
              ? 'bg-accent/80 shadow-[inset_0_0_0_1px_rgba(0,0,0,0.08)]'
              : 'bg-slate-300/75 shadow-[inset_0_0_0_1px_rgba(100,116,139,0.16)] dark:bg-white/[0.14] dark:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]'
          }`}
          aria-hidden="true"
        >
          <span
            className={`ds-focus-mode-toggle-thumb absolute left-0.5 top-0.5 h-3 w-3 rounded-full bg-white shadow-[0_1px_3px_rgba(20,47,95,0.24)] transition-transform ${
              enabled ? 'translate-x-3' : 'translate-x-0'
            }`}
          />
        </span>
      </button>
    </div>
  )
}
