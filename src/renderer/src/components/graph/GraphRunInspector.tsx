import { useState, type ReactElement } from 'react'
import { CheckCircle2, MessageSquareText } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { GraphPatchOperation, GraphRun } from '../../graph/graph-types'
import {
  InspectorList,
  Metric,
  SmallAction,
  terminalRunStatuses
} from './graph-panel-shared'

export function GraphRunInspector({
  run,
  onPatch
}: {
  run: GraphRun
  onPatch: (operations: GraphPatchOperation[], reason: string) => Promise<void>
}): ReactElement {
  const { t } = useTranslation('common')
  return (
    <div className="space-y-3 p-3">
      <div>
        <div className="text-[12px] font-semibold text-ds-ink">{run.plans.at(-1)?.title}</div>
        <div className="mt-1 line-clamp-3 text-[11px] leading-5 text-ds-muted">{run.plans.at(-1)?.goal}</div>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <Metric label={t('graphAttempts')} value={String(run.budget.attempts)} />
        <Metric label={t('graphMessages')} value={String(run.messages.length)} />
        <Metric label={t('graphArtifacts')} value={String(run.artifacts.length)} />
      </div>
      {run.plans.length > 1 ? (
        <details className="text-[10px] text-ds-muted">
          <summary className="cursor-pointer font-semibold">
            {t('graphRevisionHistory', { count: run.plans.length })}
          </summary>
          <div className="mt-1.5 space-y-1">
            {run.plans.map((plan, index) => {
              const previous = run.plans[index - 1]
              const delta = previous ? plan.nodes.length - previous.nodes.length : 0
              return (
                <div key={plan.revision} className="rounded-md bg-ds-card px-2 py-1.5">
                  {t('graphRevisionSummary', {
                    revision: plan.revision,
                    nodes: plan.nodes.length,
                    edges: plan.edges.length
                  })}
                  {previous
                    ? ` · ${t('graphRevisionDelta', {
                      delta: `${delta >= 0 ? '+' : ''}${delta}`
                    })}`
                    : ` · ${t('graphOriginalPlan')}`}
                </div>
              )
            })}
          </div>
        </details>
      ) : null}
      {run.budget.loopIterations > 0 ? (
        <div className="rounded-lg border border-amber-400/25 bg-amber-500/7 px-2.5 py-2 text-[10px] text-ds-muted">
          {t('graphLoopExplanation', { count: run.budget.loopIterations })}
        </div>
      ) : null}
      {run.messages.length ? (
        <div>
          <div className="mb-1.5 flex items-center gap-1 text-[10px] font-semibold text-ds-muted">
            <MessageSquareText className="h-3 w-3" /> {t('graphLatestCommunication')}
          </div>
          {run.messages.slice(-3).reverse().map((item) => (
            <div key={item.id} className="mb-1 rounded-lg bg-ds-card px-2.5 py-2 text-[10px] leading-4 text-ds-muted">
              <span className="font-semibold text-ds-ink">{item.sender.nodeId ?? item.sender.kind}: </span>
              {item.summary}
            </div>
          ))}
        </div>
      ) : null}
      {run.summary ? (
        <div className="rounded-lg border border-emerald-400/25 bg-emerald-500/7 px-2.5 py-2 text-[10px] leading-4 text-ds-muted">
          <div className="mb-1 flex items-center gap-1 font-semibold text-emerald-700 dark:text-emerald-200">
            <CheckCircle2 className="h-3 w-3" /> {t('graphFinalSynthesis')}
          </div>
          {run.summary.finalAnswer}
        </div>
      ) : null}
      {run.cleanup?.length ? (
        <InspectorList
          title={t('graphCleanupDisposition')}
          values={run.cleanup.map((item) =>
            `${item.resourceKind}: ${item.state}${item.lastError ? ` — ${item.lastError}` : ''}`)}
        />
      ) : null}
      {!terminalRunStatuses.has(run.status) ? <GraphPatchEditor onApply={onPatch} /> : null}
    </div>
  )
}

function GraphPatchEditor({
  onApply
}: {
  onApply: (operations: GraphPatchOperation[], reason: string) => Promise<void>
}): ReactElement {
  const { t } = useTranslation('common')
  const [reason, setReason] = useState('')
  const [operationsText, setOperationsText] = useState('')
  const [error, setError] = useState('')
  const [applying, setApplying] = useState(false)

  const apply = async (): Promise<void> => {
    try {
      const parsed: unknown = JSON.parse(operationsText)
      const operations = Array.isArray(parsed) ? parsed : [parsed]
      if (
        !reason.trim() ||
        operations.length === 0 ||
        operations.some((operation) =>
          typeof operation !== 'object' ||
          operation === null ||
          Array.isArray(operation) ||
          typeof (operation as { op?: unknown }).op !== 'string')
      ) {
        throw new Error(t('graphPatchInvalid'))
      }
      setApplying(true)
      setError('')
      await onApply(operations as GraphPatchOperation[], reason.trim())
      setReason('')
      setOperationsText('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setApplying(false)
    }
  }

  return (
    <details className="rounded-lg border border-ds-border-muted bg-ds-card p-2.5 text-[10px] text-ds-muted">
      <summary className="cursor-pointer font-semibold text-ds-ink">
        {t('graphPatchEditor')}
      </summary>
      <div className="mt-2 space-y-2">
        <input
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder={t('graphPatchReason')}
          aria-label={t('graphPatchReason')}
          className="w-full rounded-lg border border-ds-border-muted bg-ds-main px-2 py-1.5 outline-none focus:border-indigo-400"
        />
        <textarea
          value={operationsText}
          onChange={(event) => setOperationsText(event.target.value)}
          rows={5}
          spellCheck={false}
          placeholder={t('graphPatchOperations')}
          aria-label={t('graphPatchOperations')}
          className="w-full resize-y rounded-lg border border-ds-border-muted bg-ds-main px-2 py-1.5 font-mono outline-none focus:border-indigo-400"
        />
        {error ? <div role="alert" className="text-red-600 dark:text-red-300">{error}</div> : null}
        <SmallAction onClick={() => void apply()} disabled={applying}>
          {applying ? t('graphPatchApplying') : t('graphApplyPatch')}
        </SmallAction>
      </div>
    </details>
  )
}
