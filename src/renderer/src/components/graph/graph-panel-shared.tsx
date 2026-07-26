import { useEffect, useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'

export const terminalRunStatuses = new Set(['completed', 'failed', 'cancelled'])

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = (): void => setReduced(query.matches)
    update()
    query.addEventListener?.('change', update)
    return () => query.removeEventListener?.('change', update)
  }, [])
  return reduced
}

export function statusTone(status: string): string {
  if (status === 'accepted' || status === 'completed' || status === 'trusted' || status === 'promoted') {
    return 'border-emerald-400/35 bg-emerald-500/10 text-emerald-700 dark:text-emerald-200'
  }
  if (status === 'running' || status === 'queued' || status === 'reviewing' || status === 'probation') {
    return 'border-sky-400/35 bg-sky-500/10 text-sky-700 dark:text-sky-200'
  }
  if (status === 'failed' || status === 'cancelled' || status === 'repair_required' || status === 'rejected') {
    return 'border-red-400/35 bg-red-500/10 text-red-700 dark:text-red-200'
  }
  if (status === 'awaiting_human' || status === 'paused' || status === 'dormant' || status === 'draft') {
    return 'border-amber-400/35 bg-amber-500/10 text-amber-700 dark:text-amber-200'
  }
  return 'border-ds-border-muted bg-ds-card text-ds-muted'
}

export function StatusPill({ status }: { status: string }): ReactElement {
  const { t } = useTranslation('common')
  return (
    <span className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold ${statusTone(status)}`}>
      {t(`graphStatus_${status}`, { defaultValue: status.replaceAll('_', ' ') })}
    </span>
  )
}

export function Metric({ label, value }: { label: string; value: string }): ReactElement {
  return (
    <div className="min-w-0 rounded-lg border border-ds-border-muted bg-ds-card px-2 py-1.5">
      <div className="text-[9px] uppercase tracking-wide text-ds-faint">{label}</div>
      <div className="truncate text-[10px] font-semibold text-ds-ink">{value}</div>
    </div>
  )
}

export function InspectorList({
  title,
  values
}: {
  title: string
  values: string[]
}): ReactElement {
  return (
    <details className="text-[10px] text-ds-muted">
      <summary className="cursor-pointer font-semibold">{title} ({values.length})</summary>
      <ul className="mt-1.5 list-disc space-y-1 pl-4">
        {values.map((value, index) => <li key={`${index}:${value}`}>{value}</li>)}
      </ul>
    </details>
  )
}

export function SmallAction({
  onClick,
  children,
  disabled = false
}: {
  onClick: () => void
  children: string
  disabled?: boolean
}): ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="h-7 rounded-lg border border-ds-border-muted bg-ds-card px-2 text-[10px] font-semibold text-ds-muted transition hover:bg-ds-hover hover:text-ds-ink disabled:opacity-50"
    >
      {children}
    </button>
  )
}

export function EmptyState({
  icon,
  title,
  body
}: {
  icon: ReactElement
  title: string
  body: string
}): ReactElement {
  return (
    <div className="flex flex-col items-center px-6 py-12 text-center">
      <div className="text-ds-faint [&_svg]:h-7 [&_svg]:w-7">{icon}</div>
      <div className="mt-3 text-[12px] font-semibold text-ds-ink">{title}</div>
      <div className="mt-1 text-[10px] leading-5 text-ds-muted">{body}</div>
    </div>
  )
}
