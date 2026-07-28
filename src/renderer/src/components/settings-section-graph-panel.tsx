import type { ReactElement } from 'react'
import type { KunGraphSettingsV1, KunGraphSettingsPatchV1 } from '@shared/app-settings'
import { InlineNoticeView, SettingsCard, SettingRow, Toggle } from './settings-controls'

type Translate = (key: string) => string

export function GraphModeSettingsPanel({
  t,
  value,
  selectControlClass,
  onChange
}: {
  t: Translate
  value: KunGraphSettingsV1
  selectControlClass: string
  onChange: (patch: KunGraphSettingsPatchV1) => void
}): ReactElement {
  const numberInputClass =
    'w-28 rounded-xl border border-ds-border bg-ds-card px-3 py-2 text-[13px] text-ds-ink shadow-sm focus:border-accent/40 focus:outline-none focus:ring-1 focus:ring-accent/30'
  return (
    <div className="mt-6">
      <SettingsCard title={t('graphSettingsTitle')}>
        <div className="space-y-3 px-3 py-4">
          <InlineNoticeView notice={{ tone: 'info', message: t('graphSettingsDescription') }} />
          <div className="rounded-lg border border-indigo-400/25 bg-indigo-500/8 px-3 py-2 text-[12px] leading-5 text-indigo-700 dark:text-indigo-200">
            {t('graphSettingsSafety')}
          </div>
        </div>
        <SettingRow
          title={t('graphSettingsEnable')}
          description={t('graphSettingsEnableDesc')}
          control={
            <Toggle
              checked={value.enabled}
              onChange={(enabled) => onChange({
                enabled,
                defaultStrategy: 'direct'
              })}
            />
          }
        />
        {value.enabled ? (
          <>
            <SettingRow
              title={t('graphSettingsRollout')}
              description={t('graphSettingsRolloutDesc')}
              control={
                <select
                  className={selectControlClass}
                  value={value.rolloutStage}
                  onChange={(event) => onChange({
                    rolloutStage: event.target.value as KunGraphSettingsV1['rolloutStage']
                  })}
                >
                  <option value="experimental">{t('graphSettingsRolloutExperimental')}</option>
                  <option value="alpha">{t('graphSettingsRolloutAlpha')}</option>
                  <option value="beta">{t('graphSettingsRolloutBeta')}</option>
                  <option value="learning-preview">{t('graphSettingsRolloutLearning')}</option>
                  <option value="stable">{t('graphSettingsRolloutStable')}</option>
                </select>
              }
            />
            <SettingRow
              title={t('graphSettingsGlobalConcurrency')}
              description={t('graphSettingsGlobalConcurrencyDesc')}
              control={
                <input
                  type="number"
                  min={1}
                  max={256}
                  className={numberInputClass}
                  value={value.scheduler.maxConcurrentNodes}
                  onChange={(event) => onChange({
                    scheduler: {
                      maxConcurrentNodes: Math.max(1, Math.min(256, Number(event.target.value)))
                    }
                  })}
                />
              }
            />
            <SettingRow
              title={t('graphSettingsConcurrency')}
              description={t('graphSettingsConcurrencyDesc')}
              control={
                <input
                  type="number"
                  min={1}
                  max={64}
                  className={numberInputClass}
                  value={value.scheduler.maxConcurrentNodesPerRun}
                  onChange={(event) => onChange({
                    scheduler: {
                      maxConcurrentNodesPerRun: Math.max(
                        1,
                        Math.min(value.scheduler.maxConcurrentNodes, Number(event.target.value))
                      )
                    }
                  })}
                />
              }
            />
            <SettingRow
              title={t('graphSettingsMaxNodes')}
              description={t('graphSettingsMaxNodesDesc')}
              control={
                <input
                  type="number"
                  min={1}
                  max={10000}
                  className={numberInputClass}
                  value={value.scheduler.maxNodes}
                  onChange={(event) => onChange({
                    scheduler: {
                      maxNodes: Math.max(1, Math.min(10000, Number(event.target.value)))
                    }
                  })}
                />
              }
            />
            <SettingRow
              title={t('graphSettingsAttempts')}
              description={t('graphSettingsAttemptsDesc')}
              control={
                <input
                  type="number"
                  min={1}
                  max={20}
                  className={numberInputClass}
                  value={value.scheduler.maxAttemptsPerNode}
                  onChange={(event) => onChange({
                    scheduler: {
                      maxAttemptsPerNode: Math.max(1, Math.min(20, Number(event.target.value)))
                    }
                  })}
                />
              }
            />
            <SettingRow
              title={t('graphSettingsLoops')}
              description={t('graphSettingsLoopsDesc')}
              control={
                <input
                  type="number"
                  min={0}
                  max={1000}
                  className={numberInputClass}
                  value={value.scheduler.maxLoopIterations}
                  onChange={(event) => onChange({
                    scheduler: {
                      maxLoopIterations: Math.max(0, Math.min(1000, Number(event.target.value)))
                    }
                  })}
                />
              }
            />
            <SettingRow
              title={t('graphSettingsRunHours')}
              description={t('graphSettingsRunHoursDesc')}
              control={
                <input
                  type="number"
                  min={1}
                  max={720}
                  className={numberInputClass}
                  value={Math.round(value.scheduler.maxRunWallTimeMs / 3_600_000)}
                  onChange={(event) => onChange({
                    scheduler: {
                      maxRunWallTimeMs: Math.max(
                        1,
                        Math.min(720, Number(event.target.value))
                      ) * 3_600_000
                    }
                  })}
                />
              }
            />
            <SettingRow
              title={t('graphSettingsWriteIsolation')}
              description={t('graphSettingsWriteIsolationDesc')}
              control={
                <select
                  className={selectControlClass}
                  value={value.writeIsolation.mode}
                  onChange={(event) => {
                    const mode = event.target.value as 'serialize' | 'lease' | 'worktree'
                    onChange({
                      writeIsolation: {
                        mode,
                        allowWorktrees: mode === 'worktree'
                      }
                    })
                  }}
                >
                  <option value="serialize">{t('graphSettingsWriteSerialize')}</option>
                  <option value="lease">{t('graphSettingsWriteLease')}</option>
                  <option value="worktree">{t('graphSettingsWriteWorktree')}</option>
                </select>
              }
            />
            <SettingRow
              title={t('graphSettingsSupervision')}
              description={t('graphSettingsSupervisionDesc')}
              control={
                <Toggle
                  checked={value.supervision.enabled}
                  onChange={(enabled) => onChange({ supervision: { enabled } })}
                />
              }
            />
            <SettingRow
              title={t('graphSettingsFinalReview')}
              description={t('graphSettingsFinalReviewDesc')}
              control={
                <Toggle
                  checked={value.supervision.requireFinalReview}
                  onChange={(requireFinalReview) => onChange({
                    supervision: { requireFinalReview }
                  })}
                />
              }
            />
            <SettingRow
              title={t('graphSettingsCriticalHuman')}
              description={t('graphSettingsCriticalHumanDesc')}
              control={
                <Toggle
                  checked={value.supervision.requireHumanForCriticalRisk}
                  onChange={(requireHumanForCriticalRisk) => onChange({
                    supervision: { requireHumanForCriticalRisk }
                  })}
                />
              }
            />
            <SettingRow
              title={t('graphSettingsLearning')}
              description={t('graphSettingsLearningDesc')}
              control={
                <select
                  className={selectControlClass}
                  value={value.learning.mode}
                  onChange={(event) => onChange({
                    learning: {
                      mode: event.target.value as 'off' | 'suggest' | 'auto_candidate'
                    }
                  })}
                >
                  <option value="off">{t('graphSettingsLearningOff')}</option>
                  <option value="suggest">{t('graphSettingsLearningSuggest')}</option>
                  <option value="auto_candidate">{t('graphSettingsLearningAuto')}</option>
                </select>
              }
            />
            {value.learning.mode !== 'off' ? (
              <>
                <SettingRow
                  title={t('graphSettingsLearningSessions')}
                  description={t('graphSettingsLearningSessionsDesc')}
                  control={
                    <input
                      type="number"
                      min={2}
                      max={100}
                      className={numberInputClass}
                      value={value.learning.minimumDistinctSessions}
                      onChange={(event) => onChange({
                        learning: {
                          minimumDistinctSessions: Math.max(2, Math.min(100, Number(event.target.value)))
                        }
                      })}
                    />
                  }
                />
                <SettingRow
                  title={t('graphSettingsVerifiedEpisodes')}
                  description={t('graphSettingsVerifiedEpisodesDesc')}
                  control={
                    <input
                      type="number"
                      min={2}
                      max={1000}
                      className={numberInputClass}
                      value={value.learning.minimumVerifiedEpisodes}
                      onChange={(event) => onChange({
                        learning: {
                          minimumVerifiedEpisodes: Math.max(
                            2,
                            Math.min(1000, Number(event.target.value))
                          )
                        }
                      })}
                    />
                  }
                />
                <SettingRow
                  title={t('graphSettingsProbationRuns')}
                  description={t('graphSettingsProbationRunsDesc')}
                  control={
                    <input
                      type="number"
                      min={1}
                      max={1000}
                      className={numberInputClass}
                      value={value.learning.probationMinimumRuns}
                      onChange={(event) => onChange({
                        learning: {
                          probationMinimumRuns: Math.max(
                            1,
                            Math.min(1000, Number(event.target.value))
                          )
                        }
                      })}
                    />
                  }
                />
                <SettingRow
                  title={t('graphSettingsReadOnlyExplore')}
                  description={t('graphSettingsReadOnlyExploreDesc')}
                  control={
                    <Toggle
                      checked={value.learning.allowReadOnlyExploration}
                      onChange={(allowReadOnlyExploration) => onChange({
                        learning: { allowReadOnlyExploration }
                      })}
                    />
                  }
                />
                <SettingRow
                  title={t('graphSettingsDormancy')}
                  description={t('graphSettingsDormancyDesc')}
                  control={
                    <input
                      type="number"
                      min={1}
                      max={10000}
                      className={numberInputClass}
                      value={value.routing.dormantMissedOpportunityThreshold}
                      onChange={(event) => onChange({
                        routing: {
                          dormantMissedOpportunityThreshold: Math.max(
                            1,
                            Math.min(10000, Number(event.target.value))
                          )
                        }
                      })}
                    />
                  }
                />
              </>
            ) : null}
            <SettingRow
              title={t('graphSettingsGraphRetention')}
              description={t('graphSettingsGraphRetentionDesc')}
              control={
                <input
                  type="number"
                  min={1}
                  max={3650}
                  className={numberInputClass}
                  value={value.retention.graphDays}
                  onChange={(event) => onChange({
                    retention: {
                      graphDays: Math.max(1, Math.min(3650, Number(event.target.value)))
                    }
                  })}
                />
              }
            />
            <SettingRow
              title={t('graphSettingsEpisodeRetention')}
              description={t('graphSettingsEpisodeRetentionDesc')}
              control={
                <input
                  type="number"
                  min={1}
                  max={3650}
                  className={numberInputClass}
                  value={value.retention.episodeDays}
                  onChange={(event) => onChange({
                    retention: {
                      episodeDays: Math.max(1, Math.min(3650, Number(event.target.value)))
                    }
                  })}
                />
              }
            />
          </>
        ) : null}
      </SettingsCard>
    </div>
  )
}
