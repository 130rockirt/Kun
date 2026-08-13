import type { ReactElement } from 'react'
import { GitBranch, Hammer, Loader2, RefreshCw, Share2, TriangleAlert } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { PlanBuildOrchestration } from '../../plan/plan-build'
import { useGuiPlanStore } from '../../plan/plan-store'
import {
  planWorktreeRunIsTerminal,
  usePlanWorktreeStore
} from '../../plan/plan-worktree-store'
import { PlanWorktreeLifecycle } from './PlanWorktreeLifecycle'

type Props = {
  disabled: boolean
  graphEnabled: boolean
  variant: 'panel' | 'card'
  planId?: string
  onBuild: (orchestration: PlanBuildOrchestration) => void
}

export function PlanBuildActions({
  disabled,
  graphEnabled,
  variant,
  planId,
  onBuild
}: Props): ReactElement {
  const { t } = useTranslation('common')
  const activePlanId = useGuiPlanStore((state) => state.activePlan?.id)
  const resolvedPlanId = planId || activePlanId || ''
  const worktree = usePlanWorktreeStore((state) =>
    resolvedPlanId ? state.plans[resolvedPlanId] : undefined)
  const setUseWorktree = usePlanWorktreeStore((state) => state.setUseWorktree)
  const retryPreflight = usePlanWorktreeStore((state) => state.retryPreflight)
  const isolatedBlocked = Boolean(
    resolvedPlanId && (!worktree?.initialized || (worktree.useWorktree && (
      worktree.preflight.status !== 'ready' || !worktree.preflight.result.eligible
    )))
  )
  const buildDisabled = disabled || Boolean(worktree?.building) || isolatedBlocked || Boolean(
    worktree?.run && !planWorktreeRunIsTerminal(worktree.run)
  )
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
    <div className="flex min-w-0 flex-col gap-2">
      {resolvedPlanId && worktree?.initialized ? (
        <div className="flex min-w-0 flex-wrap items-center gap-2 text-[11.5px] text-ds-muted">
          <button
            type="button"
            role="switch"
            aria-checked={worktree.useWorktree}
            aria-label={t('planWorktreeUseIsolated')}
            onClick={() => setUseWorktree(resolvedPlanId, !worktree.useWorktree)}
            disabled={worktree.building}
            className={`relative h-5 w-9 shrink-0 rounded-full transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30 ${
              worktree.useWorktree ? 'bg-[var(--ds-control)]' : 'bg-ds-faint'
            } disabled:opacity-45`}
          >
            <span className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${
              worktree.useWorktree ? 'translate-x-4' : 'translate-x-0'
            }`} />
          </button>
          <GitBranch className="h-3.5 w-3.5 shrink-0" strokeWidth={1.8} />
          <span className="font-medium text-ds-ink">{t('planWorktreeUseIsolated')}</span>
          {worktree.useWorktree ? (
            worktree.preflight.status === 'loading' ? (
              <span className="inline-flex items-center gap-1">
                <Loader2 className="h-3 w-3 animate-spin" />
                {t('planWorktreeChecking')}
              </span>
            ) : worktree.preflight.status === 'ready' && worktree.preflight.result.eligible ? (
              <span className="min-w-0 truncate font-mono text-[10.5px] text-emerald-700 dark:text-emerald-300">
                {t('planWorktreeTargetBranch', {
                  branch: worktree.preflight.result.targetBranch ?? '-'
                })}
                {worktree.preflight.result.sourceIsLinkedWorktree
                  ? ` · ${t('planWorktreeLinkedSource')}`
                  : ''}
              </span>
            ) : (
              <span className="inline-flex min-w-0 items-center gap-1 text-amber-700 dark:text-amber-300">
                <TriangleAlert className="h-3 w-3 shrink-0" />
                <span className="truncate">
                  {worktree.preflight.status === 'ready'
                    ? worktree.preflight.result.message || t('planWorktreeUnavailable')
                    : worktree.preflight.status === 'error'
                      ? worktree.preflight.message
                      : t('planWorktreeChecking')}
                </span>
                {worktree.preflight.status === 'error' || worktree.preflight.status === 'ready' ? (
                  <button
                    type="button"
                    onClick={() => retryPreflight(resolvedPlanId)}
                    className="rounded p-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30"
                    aria-label={t('planWorktreeRetryPreflight')}
                    title={t('planWorktreeRetryPreflight')}
                  >
                    <RefreshCw className="h-3 w-3" />
                  </button>
                ) : null}
              </span>
            )
          ) : (
            <span>{t('planWorktreeCurrentWorkspaceWarning')}</span>
          )}
        </div>
      ) : resolvedPlanId ? (
        <div className="inline-flex items-center gap-1.5 text-[11.5px] text-ds-muted">
          <Loader2 className="h-3 w-3 animate-spin" />
          {t('planWorktreeChecking')}
        </div>
      ) : null}
      <div
        data-plan-build-actions
        data-plan-build-actions-variant={variant}
        className={containerClass}
      >
        <button
          type="button"
          data-plan-build-orchestration="direct"
          disabled={buildDisabled}
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
            disabled={buildDisabled}
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
      {resolvedPlanId ? (
        <PlanWorktreeLifecycle planId={resolvedPlanId} compact={variant === 'card'} />
      ) : null}
    </div>
  )
}
