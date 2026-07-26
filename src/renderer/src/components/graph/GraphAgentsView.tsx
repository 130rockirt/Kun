import { useState, type ReactElement } from 'react'
import { Bot } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type {
  GraphAgentEvidence,
  GraphAgentProfile,
  GraphAgentScore,
  GraphGovernanceAudit
} from '../../graph/graph-types'
import {
  EmptyState,
  SmallAction,
  StatusPill
} from './graph-panel-shared'

export function GraphAgentsView({
  profiles,
  evidence,
  scores,
  audit,
  exportedProfile,
  onTransition,
  onExport,
  onImport,
  onMerge
}: {
  profiles: GraphAgentProfile[]
  evidence: GraphAgentEvidence[]
  scores: GraphAgentScore[]
  audit: GraphGovernanceAudit[]
  exportedProfile: string | null
  onTransition: (profileId: string, lifecycle: GraphAgentProfile['lifecycle']) => void
  onExport: (profileId: string) => void
  onImport: (value: string) => void
  onMerge: (sourceProfileIds: string[], targetProfileId: string, name: string) => void
}): ReactElement {
  const { t } = useTranslation('common')
  const [portableInput, setPortableInput] = useState('')
  const [selectedProfiles, setSelectedProfiles] = useState<string[]>([])
  const [mergeTarget, setMergeTarget] = useState('')
  const [mergeName, setMergeName] = useState('')
  const toggleMergeSource = (profileId: string): void => {
    setSelectedProfiles((current) => current.includes(profileId)
      ? current.filter((item) => item !== profileId)
      : [...current, profileId])
  }
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-3">
      <div className="mb-3 rounded-xl border border-ds-border-muted bg-ds-card px-3 py-2 text-[10px] leading-4 text-ds-muted">
        {t('graphRoutingExplanation')}
      </div>
      <details className="mb-3 rounded-xl border border-ds-border-muted bg-ds-card p-3 text-[10px] text-ds-muted">
        <summary className="cursor-pointer font-semibold text-ds-ink">
          {t('graphPortableProfiles')}
        </summary>
        <div className="mt-3 space-y-2">
          <textarea
            value={portableInput}
            onChange={(event) => setPortableInput(event.target.value)}
            rows={4}
            placeholder={t('graphPortablePaste')}
            className="w-full resize-y rounded-lg border border-ds-border-muted bg-ds-main px-2.5 py-2 font-mono text-[9px] outline-none focus:border-indigo-400"
          />
          <SmallAction onClick={() => onImport(portableInput)}>{t('graphImportCandidate')}</SmallAction>
          {exportedProfile ? (
            <textarea
              readOnly
              value={exportedProfile}
              rows={4}
              aria-label={t('graphPortableExportLabel')}
              className="w-full resize-y rounded-lg border border-ds-border-muted bg-ds-main px-2.5 py-2 font-mono text-[9px]"
            />
          ) : null}
          <div className="grid grid-cols-2 gap-2">
            <input
              value={mergeTarget}
              onChange={(event) => setMergeTarget(event.target.value)}
              placeholder="merged_profile_id"
              className="rounded-lg border border-ds-border-muted bg-ds-main px-2 py-1.5 outline-none"
            />
            <input
              value={mergeName}
              onChange={(event) => setMergeName(event.target.value)}
              placeholder={t('graphMergedProfileName')}
              className="rounded-lg border border-ds-border-muted bg-ds-main px-2 py-1.5 outline-none"
            />
          </div>
          <SmallAction
            onClick={() => onMerge(selectedProfiles, mergeTarget, mergeName)}
          >
            {t('graphMergeSelected', { count: selectedProfiles.length })}
          </SmallAction>
        </div>
      </details>
      {profiles.length === 0 ? (
        <EmptyState
          icon={<Bot />}
          title={t('graphNoAgentsTitle')}
          body={t('graphNoAgentsBody')}
        />
      ) : profiles.map((profile) => {
        const ownEvidence = evidence.filter((item) => item.profileId === profile.profileId)
        const score = scores.find((item) =>
          item.profileId === profile.profileId &&
          item.profileVersion === profile.profileVersion)
        const governance = audit.filter((item) =>
          item.targetKind === 'profile' &&
          item.targetId === profile.profileId).slice(0, 3)
        return (
          <article key={`${profile.profileId}:${profile.profileVersion}`} className="mb-2 rounded-xl border border-ds-border-muted bg-ds-card p-3">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <label className="flex min-w-0 items-center gap-2">
                  <input
                    type="checkbox"
                    checked={selectedProfiles.includes(profile.profileId)}
                    onChange={() => toggleMergeSource(profile.profileId)}
                    aria-label={t('graphSelectForMerge', { name: profile.name })}
                  />
                  <span className="truncate text-[12px] font-semibold text-ds-ink">
                    {profile.name}
                  </span>
                </label>
                <div className="mt-0.5 text-[9px] uppercase tracking-wide text-ds-faint">
                  {profile.origin} · v{profile.profileVersion} · {profile.model}
                </div>
              </div>
              <StatusPill status={profile.lifecycle} />
            </div>
            <p className="mt-2 text-[10px] leading-4 text-ds-muted">{profile.description}</p>
            {profile.aliasProfileIds?.length ? (
              <div className="mt-1 text-[9px] text-ds-faint">
                {t('graphAliasesLabel', { defaultValue: 'Aliases' })}: {
                  profile.aliasProfileIds.join(', ')
                }
              </div>
            ) : null}
            <div className="mt-2 flex items-center gap-2">
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-ds-hover">
                <div
                  className="h-full rounded-full bg-indigo-500"
                  style={{ width: `${(score?.aggregate ?? 0) * 100}%` }}
                />
              </div>
              <span className="text-[10px] font-semibold tabular-nums text-ds-ink">
                {score ? Math.round(score.aggregate * 100) : '—'}
              </span>
              <span className="text-[9px] text-ds-faint">
                {t('graphEvidenceCount', { count: ownEvidence.length })}
              </span>
            </div>
            {score ? (
              <div className="mt-2 grid grid-cols-4 gap-1">
                <ScoreMetric label={t('graphScoreFit')} value={score.taskFit} />
                <ScoreMetric label={t('graphScoreQuality')} value={score.quality} />
                <ScoreMetric label={t('graphScoreTrust')} value={score.trust} />
                <ScoreMetric label={t('graphScoreFreshness')} value={score.freshness} />
                <ScoreMetric label={t('graphScoreEfficiency')} value={score.efficiency} />
                <ScoreMetric label={t('graphScoreConfidence')} value={score.confidence} />
                <ScoreMetric label={t('graphScoreAvailability')} value={score.availability} />
                <ScoreMetric label={t('graphScoreLoad')} value={score.load} />
              </div>
            ) : null}
            <div className="mt-2 flex flex-wrap gap-1">
              {profile.capabilities.taskTypes.slice(0, 4).map((tag) => (
                <span key={tag} className="rounded-full bg-ds-hover px-2 py-0.5 text-[9px] text-ds-muted">{tag}</span>
              ))}
            </div>
            <details className="mt-2 text-[9px] text-ds-faint">
              <summary className="cursor-pointer">{t('graphProfilePolicy')}</summary>
              <div className="mt-1.5 space-y-1">
                <div>{t('graphToolPolicyLabel')}: {profile.capabilities.toolPolicy}</div>
                <div>{t('graphAllowedTools')}: {profile.capabilities.allowedTools.join(', ') || '—'}</div>
                <div>{t('graphAllowedSkills')}: {profile.capabilities.allowedSkills.join(', ') || '—'}</div>
                <div>{t('graphAllowedMcp')}: {profile.capabilities.allowedMcpServers.join(', ') || '—'}</div>
                <div>{t('graphReadScopes')}: {profile.capabilities.readScopes.join(', ') || '—'}</div>
                <div>{t('graphWriteScopes')}: {profile.capabilities.writeScopes.join(', ') || '—'}</div>
                <div>
                  {t('graphApprovalLabel')}: {profile.capabilities.approvalPolicy} ·{' '}
                  {t('graphMetricSandbox')}: {profile.capabilities.sandboxMode} ·{' '}
                  {t('graphNetworkLabel')}: {profile.capabilities.networkAllowed
                    ? t('graphEnabledValue')
                    : t('graphDisabledValue')}
                </div>
                <div>
                  {t('graphEpisodesLabel')}: {
                    profile.provenanceEpisodeIds.slice(0, 8).join(', ') || '—'
                  }
                  {profile.provenanceEpisodeIds.length > 8 ? '…' : ''}
                </div>
              </div>
            </details>
            <div className="mt-3 flex gap-1.5">
              <SmallAction onClick={() => onExport(profile.profileId)}>{t('graphActionExport')}</SmallAction>
              {profile.lifecycle === 'dormant' || profile.lifecycle === 'archived' ? (
                <SmallAction onClick={() => onTransition(profile.profileId, 'probation')}>{t('graphActionRestore')}</SmallAction>
              ) : (
                <SmallAction onClick={() => onTransition(profile.profileId, 'dormant')}>{t('graphActionDormant')}</SmallAction>
              )}
              {!['archived', 'deleted'].includes(profile.lifecycle) ? (
                <SmallAction onClick={() => onTransition(profile.profileId, 'archived')}>{t('graphActionArchive')}</SmallAction>
              ) : null}
              {['candidate', 'probation', 'dormant', 'archived'].includes(profile.lifecycle) ? (
                <SmallAction onClick={() => onTransition(profile.profileId, 'deleted')}>{t('graphActionDelete')}</SmallAction>
              ) : null}
            </div>
            {governance.length ? (
              <details className="mt-2 text-[9px] text-ds-faint">
                <summary className="cursor-pointer">{t('graphGovernanceHistory')}</summary>
                <div className="mt-1.5 space-y-1">
                  {governance.map((item) => (
                    <div key={item.auditId}>
                      <span className="font-semibold text-ds-muted">{item.action}</span>
                      {' · '}{item.reason}
                    </div>
                  ))}
                </div>
              </details>
            ) : null}
          </article>
        )
      })}
    </div>
  )
}

function ScoreMetric({ label, value }: { label: string; value: number }): ReactElement {
  return (
    <div className="rounded-md bg-ds-hover px-1.5 py-1 text-center">
      <div className="text-[8px] uppercase tracking-wide text-ds-faint">{label}</div>
      <div className="text-[9px] font-semibold tabular-nums text-ds-ink">
        {Math.round(value * 100)}
      </div>
    </div>
  )
}
