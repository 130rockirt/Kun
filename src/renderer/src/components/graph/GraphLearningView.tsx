import type { ReactElement } from 'react'
import { BrainCircuit, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useGraphStore } from '../../graph/graph-store'
import {
  EmptyState,
  SmallAction,
  StatusPill
} from './graph-panel-shared'

export function GraphLearningView({
  candidates,
  jobs,
  onConsolidate,
  onAction
}: {
  candidates: ReturnType<typeof useGraphStore.getState>['candidates']
  jobs: ReturnType<typeof useGraphStore.getState>['jobs']
  onConsolidate: () => void
  onAction: (
    candidateId: string,
    action: 'approve' | 'reject' | 'start_probation' | 'promote' | 'rollback' | 'delete'
  ) => void
}): ReactElement {
  const { t } = useTranslation('common')
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-3">
      <div className="mb-3 flex items-center justify-between rounded-xl border border-ds-border-muted bg-ds-card p-3">
        <div>
          <div className="text-[12px] font-semibold text-ds-ink">
            {t('graphAsyncConsolidation')}
          </div>
          <div className="mt-1 text-[10px] text-ds-muted">
            {t('graphAsyncConsolidationBody')}
          </div>
        </div>
        <button
          type="button"
          onClick={onConsolidate}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-indigo-600 px-2.5 text-[10px] font-semibold text-white"
        >
          <BrainCircuit className="h-3.5 w-3.5" /> {t('graphScanNow')}
        </button>
      </div>
      {jobs.slice(0, 3).map((job) => (
        <div key={job.jobId} className="mb-2 flex items-center justify-between rounded-lg border border-ds-border-muted px-2.5 py-2 text-[10px]">
          <span className="text-ds-muted">
            {job.trigger} · {t('graphEpisodeCount', { count: job.inputEpisodeIds.length })}
          </span>
          <span className="inline-flex items-center gap-1 text-ds-faint">
            {job.status === 'running' || job.status === 'queued' ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
            {job.status}
          </span>
        </div>
      ))}
      {candidates.length === 0 ? (
        <EmptyState
          icon={<BrainCircuit />}
          title={t('graphNoCandidatesTitle')}
          body={t('graphNoCandidatesBody')}
        />
      ) : candidates.map((candidate) => (
        <article key={candidate.candidateId} className="mb-2 rounded-xl border border-ds-border-muted bg-ds-card p-3">
          <div className="flex items-start justify-between gap-2">
            <div>
              <div className="text-[12px] font-semibold text-ds-ink">{candidate.name}</div>
              <div className="mt-0.5 text-[9px] uppercase tracking-wide text-ds-faint">
                {candidate.kind.replaceAll('_', ' ')} ·{' '}
                {t('graphEpisodeCount', { count: candidate.provenanceEpisodeIds.length })}
              </div>
            </div>
            <StatusPill status={candidate.status} />
          </div>
          <p className="mt-2 text-[10px] leading-4 text-ds-muted">{candidate.summary}</p>
          <details className="mt-2 text-[9px] text-ds-faint">
            <summary className="cursor-pointer">{t('graphProvenanceDraft')}</summary>
            <div className="mt-1.5 space-y-1.5">
              <div>
                {t('graphEpisodesLabel')}: {candidate.provenanceEpisodeIds.slice(0, 8).join(', ')}
                {candidate.provenanceEpisodeIds.length > 8 ? '…' : ''}
              </div>
              {candidate.requestedCapabilities ? (
                <div>
                  {t('graphRequestedCapabilities', {
                    policy: candidate.requestedCapabilities.toolPolicy,
                    tools: candidate.requestedCapabilities.allowedTools.length,
                    skills: candidate.requestedCapabilities.allowedSkills.length,
                    mcp: candidate.requestedCapabilities.allowedMcpServers.length,
                    scopes: candidate.requestedCapabilities.writeScopes.length,
                    network: candidate.requestedCapabilities.networkAllowed
                      ? t('graphYes')
                      : t('graphNo')
                  })}
                </div>
              ) : null}
              <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded-md bg-ds-main p-2">
                {JSON.stringify(candidate.draft, null, 2)}
              </pre>
              <ul className="list-disc space-y-0.5 pl-4">
                {candidate.evaluationPlan.map((step) => <li key={step}>{step}</li>)}
              </ul>
              <div>{t('graphRollbackLabel')}: {candidate.rollback.instructions}</div>
            </div>
          </details>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {candidate.status === 'draft' ? (
              <>
                <SmallAction onClick={() => onAction(candidate.candidateId, 'approve')}>{t('graphActionApprove')}</SmallAction>
                <SmallAction onClick={() => onAction(candidate.candidateId, 'reject')}>{t('graphActionReject')}</SmallAction>
              </>
            ) : null}
            {candidate.status === 'approved' ? (
              <SmallAction onClick={() => onAction(candidate.candidateId, 'start_probation')}>{t('graphActionStartProbation')}</SmallAction>
            ) : null}
            {candidate.status === 'probation' ? (
              <SmallAction onClick={() => onAction(candidate.candidateId, 'promote')}>{t('graphActionPromote')}</SmallAction>
            ) : null}
            {candidate.status === 'promoted' ? (
              <SmallAction onClick={() => onAction(candidate.candidateId, 'rollback')}>{t('graphActionRollback')}</SmallAction>
            ) : null}
            {candidate.status !== 'deleted' ? (
              <SmallAction onClick={() => onAction(candidate.candidateId, 'delete')}>{t('graphActionDelete')}</SmallAction>
            ) : null}
          </div>
        </article>
      ))}
    </div>
  )
}
