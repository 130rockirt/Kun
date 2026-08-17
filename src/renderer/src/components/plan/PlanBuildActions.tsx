import { useEffect, useState, type ReactElement } from 'react'
import { GitBranch, Hammer, Share2, CalendarClock } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { rendererRuntimeClient } from '../../agent/runtime-client'
import { useChatStore } from '../../store/chat-store'
import { preparePlanBuild } from '../../plan/prepare-plan-build'
import { PlanScheduledBuildDialog } from './PlanScheduledBuildDialog'
import type { PlanBuildOrchestration } from '../../plan/plan-build'
import { useGuiPlanStore } from '../../plan/plan-store'
import { usePlanWorktreePreferenceStore } from '../../plan/plan-worktree-preference-store'

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
  const preference = usePlanWorktreePreferenceStore((state) =>
    resolvedPlanId ? state.plans[resolvedPlanId] : undefined)
  const setUsePromptWorktree = usePlanWorktreePreferenceStore(
    (state) => state.setUsePromptWorktree
  )
  const [selectedOrchestration, setSelectedOrchestration] =
    useState<PlanBuildOrchestration>('direct')
  const [scheduleOrchestration, setScheduleOrchestration] = useState<PlanBuildOrchestration | null>(null)
  const [scheduleSettings, setScheduleSettings] = useState<Awaited<ReturnType<typeof rendererRuntimeClient.getSettings>> | null>(null)
  const [scheduleError, setScheduleError] = useState('')
  const [scheduleSubmitting, setScheduleSubmitting] = useState(false)

  const openSchedule = async (orchestration: PlanBuildOrchestration): Promise<void> => {
    setScheduleError('')
    try {
      setScheduleSettings(await rendererRuntimeClient.getSettings())
      setScheduleOrchestration(orchestration)
    } catch (error) {
      useChatStore.getState().setError(error instanceof Error ? error.message : String(error))
    }
  }

  const submitSchedule = async (
    draft: Omit<Parameters<typeof window.kunGui.createScheduleTask>[0], 'title' | 'prompt' | 'workspaceRoot' | 'orchestration'>
  ): Promise<void> => {
    const orchestration = scheduleOrchestration
    const planState = useGuiPlanStore.getState()
    const plan = planState.activePlan
    if (!orchestration || !plan) return
    setScheduleSubmitting(true)
    setScheduleError('')
    try {
      const activeThreadId = useChatStore.getState().activeThreadId
      const selectedPreference = usePlanWorktreePreferenceStore.getState().plans[plan.id]
      const prepared = await preparePlanBuild({
        plan,
        content: planState.content,
        orchestration,
        graphEnabled,
        usePromptWorktree: orchestration === 'direct' && selectedPreference?.usePromptWorktree === true,
        branchPrefix: selectedPreference?.branchPrefix ?? 'codex/',
        activeThreadId,
        save: async (target, content) => {
          const result = await window.kunGui.writeWorkspaceFile({ workspaceRoot: target.workspaceRoot, path: target.relativePath, content })
          if (result.ok && useGuiPlanStore.getState().activePlan?.id === target.id) useGuiPlanStore.getState().markSaved(content)
          return result.ok
        },
        currentPlanId: () => useGuiPlanStore.getState().activePlan?.id,
        currentThreadId: () => useChatStore.getState().activeThreadId,
        getGitBranches: window.kunGui.getGitBranches
      })
      const result = await window.kunGui.createScheduleTask({
        ...draft,
        title: prepared.title,
        prompt: prepared.prompt,
        workspaceRoot: prepared.workspaceRoot,
        orchestration: prepared.orchestration
      })
      if (!result.ok) throw new Error(result.message)
      setScheduleOrchestration(null)
    } catch (error) {
      setScheduleError(error instanceof Error ? error.message : String(error))
    } finally {
      setScheduleSubmitting(false)
    }
  }

  const scheduleDialog = scheduleOrchestration && scheduleSettings ? (
    <PlanScheduledBuildDialog
      settings={scheduleSettings}
      orchestration={scheduleOrchestration}
      submitting={scheduleSubmitting}
      error={scheduleError}
      onClose={() => setScheduleOrchestration(null)}
      onSubmit={submitSchedule}
    />
  ) : null

  useEffect(() => {
    if (!graphEnabled) setSelectedOrchestration('direct')
  }, [graphEnabled])

  const settingsPending = Boolean(resolvedPlanId && !preference?.initialized)
  const buildDisabled = disabled || settingsPending
  const graphSelected = variant === 'card' && selectedOrchestration === 'graph'

  const worktreeControl = resolvedPlanId && preference?.initialized && preference.featureEnabled ? (
    <div
      data-plan-worktree-control
      className={variant === 'card'
        ? 'flex min-w-[220px] flex-1 items-center gap-2.5'
        : 'flex min-w-0 flex-wrap items-center gap-2 text-[11.5px] text-ds-muted'}
    >
      <button
        type="button"
        role="switch"
        aria-checked={preference.usePromptWorktree}
        aria-label={t('planWorktreeUsePrompt')}
        onClick={() => setUsePromptWorktree(resolvedPlanId, !preference.usePromptWorktree)}
        disabled={graphSelected}
        className={`relative h-5 w-9 shrink-0 rounded-full transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30 ${
          preference.usePromptWorktree ? 'bg-accent' : 'bg-ds-faint'
        } disabled:cursor-not-allowed disabled:opacity-45`}
      >
        <span className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${
          preference.usePromptWorktree ? 'translate-x-4' : 'translate-x-0'
        }`} />
      </button>
      {variant === 'panel' ? (
        <GitBranch className="h-3.5 w-3.5 shrink-0" strokeWidth={1.8} />
      ) : null}
      <div className="min-w-0">
        <div className="text-[12.5px] font-medium text-ds-ink">
          {t('planWorktreeUsePrompt')}
        </div>
        <div className={`mt-0.5 text-[11px] ${graphSelected ? 'text-amber-700 dark:text-amber-300' : 'text-ds-muted'}`}>
          {graphSelected
            ? t('planWorktreeGraphUnsupported')
            : preference.usePromptWorktree
              ? t('planWorktreePromptHint')
              : t('planWorktreeCurrentWorkspaceWarning')}
        </div>
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
        {scheduleDialog}
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
                disabled={disabled}
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
                  disabled={disabled}
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
            data-plan-build-schedule
            disabled={buildDisabled}
            onClick={() => void openSchedule(selectedOrchestration)}
            className="ml-auto inline-flex h-10 shrink-0 items-center justify-center gap-1.5 rounded-full border border-ds-border bg-ds-card px-4 text-[13px] font-medium text-ds-ink transition hover:bg-ds-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30 disabled:cursor-not-allowed disabled:opacity-45"
          >
            <CalendarClock className="h-3.5 w-3.5 shrink-0" strokeWidth={1.8} />
            {t('planScheduleBuild')}
          </button>
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
      </div>
    )
  }

  return (
    <div className="flex min-w-0 flex-col gap-2">
      {scheduleDialog}
      {worktreeControl}
      <div
        data-plan-build-actions
        data-plan-build-actions-variant={variant}
        className={`grid w-full ${graphEnabled ? 'grid-cols-2' : 'grid-cols-1'} gap-2`}
      >
        <button
          type="button"
          data-plan-build-schedule
          disabled={buildDisabled}
          onClick={() => void openSchedule('direct')}
          className="inline-flex h-9 w-full min-w-0 items-center justify-center gap-2 rounded-lg border border-ds-border bg-ds-card px-3 text-[13px] font-semibold text-ds-ink transition hover:bg-ds-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          <CalendarClock className="h-3.5 w-3.5 shrink-0" strokeWidth={1.9} />
          <span className="truncate">{t('planScheduleBuild')}</span>
        </button>
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
            disabled={disabled}
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
    </div>
  )
}
