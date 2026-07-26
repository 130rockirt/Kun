import { useState, type ReactElement } from 'react'
import { FileText, Loader2, RotateCcw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type {
  GraphArtifactPage,
  GraphNodeProjection,
  GraphRun
} from '../../graph/graph-types'
import {
  InspectorList,
  Metric,
  SmallAction,
  StatusPill
} from './graph-panel-shared'

export function GraphNodeInspector({
  run,
  node,
  onRetry,
  onReview,
  onRebind,
  onOpenChild,
  artifactPage,
  artifactContent,
  artifactLoading,
  onOpenArtifact,
  onNextArtifactPage,
  onCloseArtifact
}: {
  run: GraphRun
  node: GraphNodeProjection
  onRetry: () => void
  onReview: (outcome: 'pass' | 'fail') => void
  onRebind: (profileId: string) => void
  onOpenChild: (threadId: string) => void
  artifactPage: GraphArtifactPage | null
  artifactContent: string
  artifactLoading: boolean
  onOpenArtifact: (artifactId: string) => void
  onNextArtifactPage: () => void
  onCloseArtifact: () => void
}): ReactElement {
  const { t } = useTranslation('common')
  const [rebindProfileId, setRebindProfileId] = useState('')
  const attempt = node.attempts.at(-1)
  const plan = run.plans.at(-1)
  const dependencies = plan?.edges
    .filter((edge) => edge.to === node.node.id)
    .map((edge) =>
      `${edge.kind}: ${plan.nodes.find((item) => item.id === edge.from)?.title ?? edge.from}`) ?? []
  const messages = run.messages.filter((message) =>
    message.sender.nodeId === node.node.id ||
    message.recipients.some((recipient) => recipient.nodeId === node.node.id))
  const artifacts = run.artifacts.filter((artifact) => artifact.producerNodeId === node.node.id)
  const reviews = run.reviews.filter((review) => review.nodeId === node.node.id)
  const worktrees = run.cleanup.filter((item) =>
    item.resourceKind === 'worktree' &&
    (!item.attemptId || node.attempts.some((nodeAttempt) => nodeAttempt.id === item.attemptId)))
  const needsHuman = run.status === 'awaiting_human' ||
    node.node.completion?.review.kinds.includes('human')
  return (
    <div className="space-y-3 p-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-[12px] font-semibold text-ds-ink">{node.node.title}</div>
          <div className="mt-1 text-[10px] text-ds-faint">
            {node.node.kind} · {t('graphRiskLabel', {
              risk: t(`graphRisk_${node.node.riskClass}`, {
                defaultValue: node.node.riskClass
              })
            })}
          </div>
        </div>
        <StatusPill status={node.status} />
      </div>
      <p className="text-[11px] leading-5 text-ds-muted">{node.node.objective}</p>
      <div className="grid grid-cols-3 gap-2 text-[10px]">
        <Metric
          label={t('graphNodeTokenBudget')}
          value={node.node.tokenBudget?.toLocaleString() ?? t('graphInheritedValue')}
        />
        <Metric
          label={t('graphNodeTimeout')}
          value={node.node.timeoutMs
            ? `${Math.round(node.node.timeoutMs / 1_000)}s`
            : t('graphInheritedValue')}
        />
        <Metric
          label={t('graphNodeAttemptsLimit')}
          value={node.node.maxAttempts?.toLocaleString() ?? t('graphInheritedValue')}
        />
      </div>
      {attempt ? (
        <>
          <div className="grid grid-cols-2 gap-2 text-[10px]">
            <Metric label={t('graphMetricAgent')} value={attempt.assignment.name} />
            <Metric
              label={t('graphMetricProfile')}
              value={`${attempt.assignment.profileId}@${attempt.assignment.profileVersion}`}
            />
            <Metric label={t('graphMetricModel')} value={attempt.assignment.model} />
            <Metric label={t('graphMetricProvider')} value={attempt.assignment.providerId} />
            <Metric label={t('graphMetricAttempt')} value={`#${attempt.attemptNumber}`} />
            <Metric label={t('graphMetricTokens')} value={attempt.tokenUsage.toLocaleString()} />
            <Metric label={t('graphMetricElapsed')} value={`${Math.round(attempt.elapsedMs / 1000)}s`} />
            <Metric label={t('graphMetricSandbox')} value={attempt.assignment.sandboxMode} />
          </div>
          <InspectorList
            title={t('graphAssignmentPolicy')}
            values={[
              `${t('graphReasoningLabel')}: ${attempt.assignment.reasoningEffort}`,
              `${t('graphApprovalLabel')}: ${attempt.assignment.approvalPolicy}`,
              `${t('graphToolPolicyLabel')}: ${attempt.assignment.toolPolicy}`,
              `${t('graphNetworkLabel')}: ${attempt.assignment.networkAllowed
                ? t('graphEnabledValue')
                : t('graphDisabledValue')}`,
              `${t('graphWallTimeLabel')}: ${Math.round(attempt.assignment.maxWallTimeMs / 1000)}s`,
              `${t('graphTokenLimitLabel')}: ${attempt.assignment.maxTokens.toLocaleString()}`
            ]}
          />
          {attempt.assignment.allowedTools.length ? (
            <InspectorList title={t('graphAllowedTools')} values={attempt.assignment.allowedTools} />
          ) : null}
          {attempt.assignment.blockedTools.length ? (
            <InspectorList title={t('graphBlockedTools')} values={attempt.assignment.blockedTools} />
          ) : null}
          {attempt.assignment.allowedSkills.length ? (
            <InspectorList title={t('graphAllowedSkills')} values={attempt.assignment.allowedSkills} />
          ) : null}
          {attempt.assignment.blockedSkills.length ? (
            <InspectorList title={t('graphBlockedSkills')} values={attempt.assignment.blockedSkills} />
          ) : null}
          {attempt.assignment.allowedMcpServers.length ? (
            <InspectorList title={t('graphAllowedMcp')} values={attempt.assignment.allowedMcpServers} />
          ) : null}
          {attempt.assignment.blockedMcpServers.length ? (
            <InspectorList title={t('graphBlockedMcp')} values={attempt.assignment.blockedMcpServers} />
          ) : null}
          {attempt.assignment.readScopes.length ? (
            <InspectorList title={t('graphReadScopes')} values={attempt.assignment.readScopes} />
          ) : null}
          {attempt.assignment.writeScopes.length ? (
            <InspectorList title={t('graphWriteScopes')} values={attempt.assignment.writeScopes} />
          ) : null}
          <InspectorList
            title={t('graphFrozenContext')}
            values={[
              `${t('graphWorkspaceRoot')}: ${attempt.assignment.workspaceRoot}`,
              `${t('graphCapturedAt')}: ${attempt.assignment.capturedAt}`,
              `${t('graphSystemPrompt')}: ${attempt.assignment.systemPrompt}`
            ]}
          />
          {attempt.childThreadId ? (
            <SmallAction onClick={() => onOpenChild(attempt.childThreadId!)}>
              {t('graphOpenChildSession')}
            </SmallAction>
          ) : null}
        </>
      ) : null}
      {['pending', 'blocked', 'ready', 'failed', 'repair_required'].includes(node.status) ? (
        <div className="flex items-center gap-1.5">
          <input
            value={rebindProfileId}
            onChange={(event) => setRebindProfileId(event.target.value)}
            placeholder={t('graphRebindProfilePlaceholder')}
            aria-label={t('graphRebindProfilePlaceholder')}
            className="min-w-0 flex-1 rounded-lg border border-ds-border-muted bg-ds-card px-2 py-1.5 text-[10px] outline-none focus:border-indigo-400"
          />
          <SmallAction
            onClick={() => {
              if (!rebindProfileId.trim()) return
              onRebind(rebindProfileId.trim())
              setRebindProfileId('')
            }}
          >
            {t('graphActionRebind')}
          </SmallAction>
        </div>
      ) : null}
      {node.attempts.length > 1 ? (
        <details className="text-[10px] text-ds-muted">
          <summary className="cursor-pointer font-semibold">
            {t('graphAttemptHistory', { count: node.attempts.length })}
          </summary>
          <div className="mt-1.5 space-y-1">
            {node.attempts.map((item) => (
              <div key={item.id} className="rounded-md bg-ds-card px-2 py-1">
                #{item.attemptNumber} · {t(`graphStatus_${item.status}`, {
                  defaultValue: item.status
                })} · {t('graphTokenCount', { count: item.tokenUsage })}
                {item.normalizedFailure ? ` · ${item.normalizedFailure}` : ''}
              </div>
            ))}
          </div>
        </details>
      ) : null}
      {node.lastProgress ? (
        <div className="rounded-lg border border-ds-border-muted bg-ds-card px-2.5 py-2 text-[10px] leading-4 text-ds-muted">
          {node.lastProgress.summary}
        </div>
      ) : null}
      {attempt?.normalizedFailure ? (
        <div role="alert" className="rounded-lg border border-red-400/25 bg-red-500/7 px-2.5 py-2 text-[10px] leading-4 text-red-700 dark:text-red-200">
          {attempt.normalizedFailure}
        </div>
      ) : null}
      {attempt?.validation?.issues.length ? (
        <InspectorList
          title={t('graphValidationIssues')}
          values={attempt.validation.issues.map((issue) =>
            `${issue.severity}/${issue.code}: ${issue.message}`)}
        />
      ) : null}
      {attempt?.result?.summary ? (
        <div className="rounded-lg border border-emerald-400/25 bg-emerald-500/7 px-2.5 py-2 text-[10px] leading-4 text-ds-muted">
          {attempt.result.summary}
        </div>
      ) : null}
      {node.node.completion?.acceptanceCriteria.length ? (
        <InspectorList
          title={t('graphAcceptanceCriteria')}
          values={node.node.completion.acceptanceCriteria}
        />
      ) : null}
      {node.node.completion?.requiredResultFields.length ? (
        <InspectorList
          title={t('graphRequiredResultFields')}
          values={node.node.completion.requiredResultFields}
        />
      ) : null}
      {attempt?.result?.changedFiles.length ? (
        <InspectorList title={t('graphChangedFiles')} values={attempt.result.changedFiles} />
      ) : null}
      {attempt?.result?.checks.length ? (
        <InspectorList
          title={t('graphChecks')}
          values={attempt.result.checks.map((check) =>
            `${check.name}: ${check.status} — ${check.summary}`)}
        />
      ) : null}
      {attempt?.result?.evidence.length ? (
        <InspectorList title={t('graphEvidenceLabel')} values={attempt.result.evidence} />
      ) : null}
      {attempt?.result?.risks.length ? (
        <InspectorList title={t('graphRisksLabel')} values={attempt.result.risks} />
      ) : null}
      {dependencies.length ? <InspectorList title={t('graphDependencies')} values={dependencies} /> : null}
      {node.node.writeScopes.length ? (
        <InspectorList title={t('graphWriteScopes')} values={node.node.writeScopes} />
      ) : null}
      {worktrees.length ? (
        <InspectorList
          title={t('graphWorktrees')}
          values={worktrees.map((item) =>
            `${item.resourceId}: ${item.state}${item.lastError ? ` — ${item.lastError}` : ''}`)}
        />
      ) : null}
      {artifacts.length ? (
        <details className="text-[10px] text-ds-muted">
          <summary className="cursor-pointer font-semibold">
            {t('graphArtifacts')} ({artifacts.length})
          </summary>
          <div className="mt-1.5 space-y-1">
            {artifacts.map((artifact) => (
              <button
                key={artifact.artifactId}
                type="button"
                onClick={() => onOpenArtifact(artifact.artifactId)}
                className="flex w-full items-center gap-1.5 rounded-md bg-ds-card px-2 py-1.5 text-left hover:bg-ds-hover"
              >
                <FileText className="h-3 w-3 shrink-0" />
                <span className="min-w-0 flex-1 truncate">{artifact.summary}</span>
                <span className="shrink-0 text-ds-faint">
                  {artifact.byteLength.toLocaleString()} B
                </span>
              </button>
            ))}
          </div>
        </details>
      ) : null}
      {artifactPage ? (
        <ArtifactPreview
          page={artifactPage}
          content={artifactContent}
          loading={artifactLoading}
          onNext={onNextArtifactPage}
          onClose={onCloseArtifact}
        />
      ) : artifactLoading ? (
        <div role="status" className="flex items-center gap-2 text-[10px] text-ds-muted">
          <Loader2 className="h-3 w-3 animate-spin" />
          {t('graphArtifactLoading')}
        </div>
      ) : null}
      {messages.length ? (
        <InspectorList
          title={t('graphMailbox')}
          values={messages.slice(-5).map((message) => message.summary)}
        />
      ) : null}
      {reviews.length ? (
        <InspectorList
          title={t('graphReviews')}
          values={reviews.map((review) =>
            `${review.reviewerKind}: ${review.outcome} — ${review.summary}`)}
        />
      ) : null}
      {needsHuman && attempt ? (
        <div className="flex gap-1.5">
          <SmallAction onClick={() => onReview('pass')}>{t('graphApproveResult')}</SmallAction>
          <SmallAction onClick={() => onReview('fail')}>{t('graphRejectResult')}</SmallAction>
        </div>
      ) : null}
      {['failed', 'repair_required', 'cancelled'].includes(node.status) ? (
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-ds-border-muted bg-ds-card px-2.5 text-[11px] font-semibold text-ds-ink hover:bg-ds-hover"
        >
          <RotateCcw className="h-3.5 w-3.5" />
          {t('graphRetryNode')}
        </button>
      ) : null}
    </div>
  )
}

function ArtifactPreview({
  page,
  content,
  loading,
  onNext,
  onClose
}: {
  page: GraphArtifactPage
  content: string
  loading: boolean
  onNext: () => void
  onClose: () => void
}): ReactElement {
  const { t } = useTranslation('common')
  const range = page.range.startLine !== undefined
    ? `${page.range.startLine}–${page.range.endLine ?? page.range.startLine}`
    : `${page.range.offset ?? 0}–${(page.range.offset ?? 0) + (page.range.length ?? 0)} B`
  return (
    <section
      aria-label={t('graphArtifactPreview')}
      className="rounded-lg border border-ds-border-muted bg-ds-card p-2.5"
    >
      <div className="mb-2 flex items-center justify-between gap-2 text-[10px]">
        <span className="min-w-0 truncate font-semibold text-ds-ink">
          {page.reference.summary}
        </span>
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 text-ds-faint hover:text-ds-ink"
          aria-label={t('close')}
        >
          ×
        </button>
      </div>
      <div className="mb-1.5 text-[9px] text-ds-faint">
        {page.meta.mimeType} · {range} · {page.meta.byteSize.toLocaleString()} B
      </div>
      <pre className="max-h-44 overflow-auto whitespace-pre-wrap break-words rounded-md bg-ds-main p-2 text-[9px] leading-4 text-ds-muted">
        {content}
      </pre>
      {page.truncated ? (
        <button
          type="button"
          disabled={loading}
          onClick={onNext}
          className="mt-2 inline-flex h-7 items-center gap-1 rounded-md border border-ds-border-muted px-2 text-[10px] text-ds-ink disabled:opacity-50"
        >
          {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
          {t('graphArtifactNextPage')}
        </button>
      ) : null}
    </section>
  )
}
