import type { ReactElement } from 'react'
import { Hammer, Share2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { PlanBuildOrchestration } from '../../plan/plan-build'

type Props = {
  disabled: boolean
  graphEnabled: boolean
  variant: 'panel' | 'card'
  onBuild: (orchestration: PlanBuildOrchestration) => void
}

export function PlanBuildActions({
  disabled,
  graphEnabled,
  variant,
  onBuild
}: Props): ReactElement {
  const { t } = useTranslation('common')
  const containerClass = variant === 'panel'
    ? `grid w-full ${graphEnabled ? 'grid-cols-2' : 'grid-cols-1'} gap-2`
    : 'ml-auto flex max-w-full flex-wrap items-center justify-end gap-2'
  const directClass = variant === 'panel'
    ? 'inline-flex h-9 w-full min-w-0 items-center justify-center gap-2 rounded-lg bg-accent px-3 text-[13px] font-semibold text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50'
    : 'inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full bg-accent px-3 text-[13px] font-semibold text-white shadow-[0_10px_24px_rgba(59,130,216,0.18)] transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50'
  const graphClass = variant === 'panel'
    ? 'inline-flex h-9 w-full min-w-0 items-center justify-center gap-2 rounded-lg bg-indigo-600 px-3 text-[13px] font-semibold text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-indigo-500 dark:hover:bg-indigo-400'
    : 'inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full bg-indigo-600 px-3 text-[13px] font-semibold text-white shadow-[0_10px_24px_rgba(79,70,229,0.2)] transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-indigo-500 dark:hover:bg-indigo-400'

  return (
    <div
      data-plan-build-actions
      data-plan-build-actions-variant={variant}
      className={containerClass}
    >
      <button
        type="button"
        data-plan-build-orchestration="direct"
        disabled={disabled}
        onClick={() => onBuild('direct')}
        className={directClass}
        aria-label={t('planBuildDirect')}
        title={t('planBuildDirectHint')}
      >
        <Hammer className="h-3.5 w-3.5 shrink-0" strokeWidth={1.9} />
        <span className="truncate">{t('planBuildDirect')}</span>
      </button>
      {graphEnabled ? (
        <button
          type="button"
          data-plan-build-orchestration="graph"
          disabled={disabled}
          onClick={() => onBuild('graph')}
          className={graphClass}
          aria-label={t('planBuildGraph')}
          title={t('planBuildGraphHint')}
        >
          <Share2 className="h-3.5 w-3.5 shrink-0" strokeWidth={1.9} />
          <span className="truncate">{t('planBuildGraph')}</span>
        </button>
      ) : null}
    </div>
  )
}
