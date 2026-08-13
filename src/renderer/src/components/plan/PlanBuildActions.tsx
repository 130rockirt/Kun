import { useEffect, useState, type ReactElement } from 'react'
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
  const [selectedOrchestration, setSelectedOrchestration] = useState<PlanBuildOrchestration>('direct')
  useEffect(() => {
    if (!graphEnabled) setSelectedOrchestration('direct')
  }, [graphEnabled])
  const featureEnabled = worktree?.featureEnabled === true
  const settingsPending = Boolean(resolvedPlanId && !worktree?.initialized)
  const isolatedBlocked = Boolean(
    featureEnabled && worktree?.useWorktree && (
      worktree.preflight.status !== 'ready' || !worktree.preflight.result.eligible
    )
  )
  const buildDisabled = disabled || settingsPending || Boolean(worktree?.building) || isolatedBlocked || Boolean(
    worktree?.run && !planWorktreeRunIsTerminal(worktree.run)
  )
  const orchestrationDisabled = disabled || Boolean(worktree?.building) || Boolean(
    worktree?.run && !planWorktreeRunIsTerminal(worktree.run)
  )

  const worktreeControl = resolvedPlanId && worktree?.initialized && featureEnabled ? (
    <div
      data-plan-worktree-control
      className={variant === 'card'
        ? 'flex min-w-[220px] flex-1 items-center gap-2.5'
        : 'flex min-w-0 flex-wrap items-center gap-2 text-[11.5px] text-ds-muted'}
    >
      <button
        type="button"
        role="switch"
        aria-checked={worktree.useWorktree}
        aria-label={t('planWorktreeUseIsolated')}
        onClick={() => setUseWorktree(resolvedPlanId, !worktree.useWorktree)}
        disabled={worktree.building}
        className={`relative h-5 w-9 shrink-0 rounded-full transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30 ${
          worktree.useWorktree ? 'bg-accent' : 'bg-ds-faint'
        } disabled:opacity-45`}
      >
        <span className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${
          worktree.useWorktree ? 'translate-x-4' : 'translate-x-0'
        }`} />
      </button>
      {variant === 'panel' ? (
        <GitBranch className="h-3.5 w-3.5 shrink-0" strokeWidth={1.8} />
      ) : null}
      <div className="min-w-0">
        <div className="text-[12.5px] font-medium text-ds-ink">
          {t('planWorktreeUseIsolated')}
        </div>
        {worktree.useWorktree ? (
          worktree.preflight.status === 'loading' ? (
            <div className="mt-0.5 inline-flex items-center gap-1 text-[11px] text-ds-muted">
              <Loader2 className="h-3 w-3 animate-spin" />
              {t('planWorktreeChecking')}
            </div>
          ) : worktree.preflight.status === 'ready' && worktree.preflight.result.eligible ? (
            <div
              className={`mt-0.5 truncate text-[11px] ${
                variant === 'card'
                  ? 'text-ds-muted'
                  : 'font-mono text-emerald-700 dark:text-emerald-300'
              }`}
              title={t('planWorktreeTargetBranch', {
                branch: worktree.preflight.result.targetBranch ?? '-'
              })}
            >
              {variant === 'card'
                ? t('planWorktreeSafeHint')
                : t('planWorktreeTargetBranch', {
                    branch: worktree.preflight.result.targetBranch ?? '-'
                  })}
              {variant === 'panel' && worktree.preflight.result.sourceIsLinkedWorktree
                ? ` · ${t('planWorktreeLinkedSource')}`
                : ''}
            </div>
          ) : (
            <div className="mt-0.5 inline-flex min-w-0 items-center gap-1 text-[11px] text-amber-700 dark:text-amber-300">
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
            </div>
          )
        ) : (
          <div className="mt-0.5 text-[11px] text-ds-muted">
            {t('planWorktreeCurrentWorkspaceWarning')}
          </div>
        )}
      </div>
    </div>
  ) : null

  if (variant === 'card') {
    const modeButtonClass = (orchestration: PlanBuildOrchestration): string =>
      `inline-flex h-9 min-w-0 items-center justify-center gap-1.5 rounded-full px-3 text-[12.5px] font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30 disabled:cursor-not-allowed disabled:opacity-45 ${
        selectedOrchestration === orchestration
          ? 'bg-accent-soft text-accent'
          : 'text-ds-muted hover:bg-ds-hover/70 hover:text-ds-ink'
      }`

    return (
      <div className="flex w-full min-w-0 flex-col gap-3">
        <div
          data-plan-build-actions
          data-plan-build-actions-variant={variant}
          className="flex w-full flex-wrap items-center gap-x-5 gap-y-3"
        >
          <div className="flex min-w-0 flex-wrap items-center gap-2.5">
            <span className="shrink-0 text-[12.5px] font-medium text-ds-ink">
              {t('planBuildMode')}
            </span>
            <div
              role="group"
              aria-label={t('planBuildMode')}
              className="flex min-w-0 rounded-full bg-ds-card-muted/70 p-1"
            >
              <button
                type="button"
                data-plan-build-orchestration="direct"
                aria-pressed={selectedOrchestration === 'direct'}
                disabled={orchestrationDisabled}
                onClick={() => setSelectedOrchestration('direct')}
                className={modeButtonClass('direct')}
                title={t('planBuildDirectHint')}
              >
                <Hammer className="h-3.5 w-3.5 shrink-0" strokeWidth={1.8} />
                <span className="truncate">{t('planBuildDirect')}</span>
              </button>
              {graphEnabled ? (
                <button
                  type="button"
                  data-plan-build-orchestration="graph"
                  aria-pressed={selectedOrchestration === 'graph'}
                  disabled={orchestrationDisabled}
                  onClick={() => setSelectedOrchestration('graph')}
                  className={modeButtonClass('graph')}
                  title={t('planBuildGraphHint')}
                >
                  <Share2 className="h-3.5 w-3.5 shrink-0" strokeWidth={1.8} />
                  <span className="truncate">{t('planBuildGraph')}</span>
                </button>
              ) : null}
            </div>
          </div>
          {worktreeControl}
          <button
            type="button"
            data-plan-build-start
            disabled={buildDisabled}
            onClick={() => onBuild(selectedOrchestration)}
            className="ml-auto inline-flex h-10 shrink-0 items-center justify-center gap-1.5 rounded-full bg-accent px-4 text-[13px] font-medium text-white transition hover:brightness-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30 disabled:cursor-not-allowed disabled:opacity-45"
          >
            <Hammer className="h-3.5 w-3.5 shrink-0" strokeWidth={1.8} />
            {t('planBuildStart')}
          </button>
        </div>
        {resolvedPlanId ? <PlanWorktreeLifecycle planId={resolvedPlanId} compact /> : null}
      </div>
    )
  }

  return (
    <div className="flex min-w-0 flex-col gap-2">
      {worktreeControl}
      <div
        data-plan-build-actions
        data-plan-build-actions-variant={variant}
        className={`grid w-full ${graphEnabled ? 'grid-cols-2' : 'grid-cols-1'} gap-2`}
      >
        <button
          type="button"
          data-plan-build-orchestration="direct"
          disabled={buildDisabled}
          onClick={() => onBuild('direct')}
          className="inline-flex h-9 w-full min-w-0 items-center justify-center gap-2 rounded-lg bg-accent px-3 text-[13px] font-semibold text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
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
            className="inline-flex h-9 w-full min-w-0 items-center justify-center gap-2 rounded-lg bg-indigo-600 px-3 text-[13px] font-semibold text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-indigo-500 dark:hover:bg-indigo-400"
            aria-label={t('planBuildGraph')}
            title={t('planBuildGraphHint')}
          >
            <Share2 className="h-3.5 w-3.5 shrink-0" strokeWidth={1.9} />
            <span className="truncate">{t('planBuildGraph')}</span>
          </button>
        ) : null}
      </div>
      {resolvedPlanId ? (
        <PlanWorktreeLifecycle planId={resolvedPlanId} compact={false} />
      ) : null}
    </div>
  )
}
