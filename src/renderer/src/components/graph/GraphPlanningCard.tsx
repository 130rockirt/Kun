import type { ReactElement } from 'react'
import { AlertTriangle, CheckCircle2, GitBranch, LoaderCircle, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { GraphPlanningDraftView } from '../../graph/graph-types'

export function GraphPlanningCard({
  view,
  onResume,
  onCancel
}: {
  view: GraphPlanningDraftView
  onResume: () => void
  onCancel: () => void
}): ReactElement {
  const { t } = useTranslation('common')
  const { draft, tasks } = view
  const needsCorrection = draft.status === 'needs_correction' ||
    draft.status === 'repairing'
  const terminal = draft.status === 'committed' ||
    draft.status === 'cancelled' ||
    draft.status === 'host_error'
  const Icon = needsCorrection || draft.status === 'host_error'
    ? AlertTriangle
    : draft.status === 'committed'
      ? CheckCircle2
      : draft.status === 'planning' || draft.status === 'validating' ||
          draft.status === 'committing'
        ? LoaderCircle
        : GitBranch
  return (
    <div className="flex min-h-0 flex-1 items-start justify-center overflow-auto px-4 py-6">
      <section
        className="w-full max-w-xl rounded-2xl border border-ds-border-muted bg-ds-card p-4 shadow-sm"
        data-graph-planning-card
      >
        <div className="flex items-start gap-3">
          <div className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${
            needsCorrection || draft.status === 'host_error'
              ? 'bg-amber-500/12 text-amber-700 dark:text-amber-200'
              : 'bg-indigo-500/12 text-indigo-700 dark:text-indigo-200'
          }`}>
            <Icon className={`h-4 w-4 ${
              ['planning', 'validating', 'committing'].includes(draft.status)
                ? 'animate-spin'
                : ''
            }`} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-semibold text-ds-ink">
              {t(`graphPlanningStatus_${draft.status}`)}
            </div>
            <div className="mt-1 text-[11px] leading-5 text-ds-muted">
              {needsCorrection
                ? t('graphPlanningCorrectionBody')
                : t('graphPlanningWorkingBody')}
            </div>
          </div>
        </div>

        {draft.issues.length > 0 ? (
          <div className="mt-4 space-y-2">
            {draft.issues.map((issue, index) => (
              <div
                key={`${issue.code}:${issue.path.join('.')}:${index}`}
                className="rounded-xl border border-amber-400/25 bg-amber-500/6 px-3 py-2"
              >
                <div className="font-mono text-[10px] text-amber-800 dark:text-amber-200">
                  {issue.path.length ? issue.path.join('.') : issue.code}
                </div>
                <div className="mt-1 text-[11px] leading-5 text-ds-ink">
                  {issue.message}
                </div>
                <div className="mt-1 text-[10px] leading-4 text-ds-muted">
                  {issue.repairHint}
                </div>
              </div>
            ))}
          </div>
        ) : null}

        {tasks.length > 0 ? (
          <div className="mt-4">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-ds-faint">
              {t('graphPlanningTaskSummary')}
            </div>
            <div className="mt-2 space-y-1.5">
              {tasks.map((task) => (
                <div
                  key={task.key}
                  className="flex items-center gap-2 rounded-lg bg-ds-hover/60 px-2.5 py-2 text-[11px]"
                >
                  <span className="rounded-md bg-ds-card px-1.5 py-0.5 font-mono text-[9px] text-ds-faint">
                    {task.kind}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-ds-ink">{task.title}</span>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {!terminal || needsCorrection ? (
          <div className="mt-4 flex justify-end gap-2 border-t border-ds-border-muted pt-3">
            <button
              type="button"
              onClick={onCancel}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-[11px] font-semibold text-ds-muted transition hover:bg-ds-hover hover:text-ds-ink"
            >
              <X className="h-3.5 w-3.5" />
              {t('graphPlanningCancel')}
            </button>
            {needsCorrection ? (
              <button
                type="button"
                onClick={onResume}
                className="h-8 rounded-lg bg-indigo-600 px-3 text-[11px] font-semibold text-white transition hover:bg-indigo-500"
              >
                {t('graphPlanningContinue')}
              </button>
            ) : null}
          </div>
        ) : null}
      </section>
    </div>
  )
}
