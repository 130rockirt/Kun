import { AlertTriangle, BellRing, Clock3, RefreshCw } from 'lucide-react'
import { type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  GraphRun,
  GraphSupervisionItem,
  GraphSupervisionProjection
} from '../../graph/graph-types'

export function primaryGraphSupervisionAction(
  supervision: GraphSupervisionProjection | undefined
): GraphSupervisionItem | null {
  return supervision?.pendingActions[0] ?? null
}

export function GraphSupervisionBanner({
  run,
  supervision,
  wakingObligationId,
  onWakeLead
}: {
  run: GraphRun
  supervision?: GraphSupervisionProjection
  wakingObligationId: string | null
  onWakeLead: (obligationId?: string) => void
}): ReactElement | null {
  const { t, i18n } = useTranslation('common')
  const primary = primaryGraphSupervisionAction(supervision)
  if (!supervision || supervision.liveness === 'idle' || !primary) return null

  const wakeTarget = supervision.pendingActions.find((action) => action.canWake)
  const waking = wakingObligationId === '*' || wakingObligationId === wakeTarget?.obligationId
  const nodeTitles = primary.nodeIds
    .map((nodeId) => run.nodes[nodeId]?.node.title ?? nodeId)
    .slice(0, 3)
  const extraNodeCount = Math.max(0, primary.nodeIds.length - nodeTitles.length)
  const tone = supervision.liveness === 'needs_attention'
    ? 'border-red-400/30 bg-red-500/7 text-red-700 dark:text-red-200'
    : supervision.liveness === 'retry_scheduled'
      ? 'border-amber-400/30 bg-amber-500/7 text-amber-700 dark:text-amber-200'
      : supervision.liveness === 'active_review'
        ? 'border-indigo-400/25 bg-indigo-500/7 text-indigo-700 dark:text-indigo-200'
        : 'border-amber-400/25 bg-amber-500/5 text-amber-700 dark:text-amber-200'
  const Icon = supervision.liveness === 'needs_attention' ? AlertTriangle : BellRing

  return (
    <section
      role={supervision.liveness === 'needs_attention' ? 'alert' : 'status'}
      aria-live="polite"
      data-graph-supervision={supervision.liveness}
      className={`mt-2 rounded-xl border px-2.5 py-2 ${tone}`}
    >
      <div className="flex items-start gap-2">
        <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={1.9} />
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-semibold">
            {t(
              supervision.liveness === 'active_review' &&
              (supervision.peerReviewLeases?.length ?? 0) > 0
                ? 'graphSupervision_active_peer_review'
                : `graphSupervision_${supervision.liveness}`
            )}
          </div>
          <div className="mt-0.5 text-[9px] leading-4 text-ds-muted">
            {t(`graphSupervisionAction_${primary.pendingAction}`)}
            {nodeTitles.length ? ` · ${nodeTitles.join(', ')}` : ''}
            {extraNodeCount ? ` +${extraNodeCount}` : ''}
          </div>
          {primary.attentionReason ?? primary.lastError ? (
            <div className="mt-1 text-[9px] leading-4 text-ds-muted" data-graph-supervision-detail>
              {primary.attentionReason ?? primary.lastError}
            </div>
          ) : null}
        </div>
        {wakeTarget ? (
          <button
            type="button"
            disabled={waking}
            data-graph-supervision-wake
            title={t('graphSupervisionWakeHint')}
            onClick={() => onWakeLead(wakeTarget.obligationId)}
            className="inline-flex h-7 shrink-0 items-center gap-1 rounded-lg border border-current/20 bg-ds-card px-2 text-[9px] font-semibold transition hover:bg-ds-hover disabled:cursor-wait disabled:opacity-60"
          >
            <RefreshCw className={`h-3 w-3 ${waking ? 'animate-spin' : ''}`} />
            {t(waking ? 'graphSupervisionWaking' : 'graphSupervisionWakeLead')}
          </button>
        ) : null}
      </div>
      <dl className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 border-t border-current/10 pt-1.5 text-[8px] text-ds-faint">
        <div className="flex items-center gap-1">
          <dt>{t('graphSupervisionRetries')}</dt>
          <dd className="font-semibold tabular-nums text-ds-muted">{primary.retryCount}</dd>
        </div>
        {primary.noProgressCount > 0 ? (
          <div className="flex items-center gap-1">
            <dt>{t('graphSupervisionNoProgress')}</dt>
            <dd className="font-semibold tabular-nums text-ds-muted">{primary.noProgressCount}</dd>
          </div>
        ) : null}
        {primary.lastWakeAt ? (
          <div className="flex items-center gap-1">
            <Clock3 className="h-2.5 w-2.5" />
            <dt>{t('graphSupervisionLastWake')}</dt>
            <dd>
              <time dateTime={primary.lastWakeAt}>
                {formatTimestamp(primary.lastWakeAt, i18n.resolvedLanguage)}
              </time>
            </dd>
          </div>
        ) : null}
        {primary.nextWakeAt ? (
          <div className="flex items-center gap-1">
            <Clock3 className="h-2.5 w-2.5" />
            <dt>{t('graphSupervisionNextWake')}</dt>
            <dd>
              <time dateTime={primary.nextWakeAt}>
                {formatTimestamp(primary.nextWakeAt, i18n.resolvedLanguage)}
              </time>
            </dd>
          </div>
        ) : null}
      </dl>
    </section>
  )
}

function formatTimestamp(value: string, locale?: string): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return value
  return new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).format(date)
}
