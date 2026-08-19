import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { CalendarClock, GitBranch, Hammer, Share2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { systemTimeZone, type AppSettingsV1, type ScheduleReasoningEffort, type ScheduledTaskV1 } from '@shared/app-settings'
import { rendererRuntimeClient } from '../../agent/runtime-client'
import { useChatStore } from '../../store/chat-store'
import { preparePlanBuild } from '../../plan/prepare-plan-build'
import {
  activePlanScheduledTask,
  formatPlanScheduleNextRun,
  planScheduleCountdown,
  scheduledTaskTime
} from '../../plan/plan-scheduled-task'
import { PlanScheduledBuildDialog } from './PlanScheduledBuildDialog'
import type { PlanBuildOrchestration } from '../../plan/plan-build'
import { useGuiPlanStore } from '../../plan/plan-store'
import { usePlanWorktreePreferenceStore } from '../../plan/plan-worktree-preference-store'

type PlanBuildMode = 'direct' | 'scheduled' | 'graph'
type ScheduleDraft = {
  providerId: string
  model: string
  reasoningEffort: ScheduleReasoningEffort
  mode: 'agent'
  schedule: { kind: 'at'; atTime: string; timeZone: string }
}

type Props = {
  disabled: boolean
  graphEnabled: boolean
  variant: 'panel' | 'card'
  planId?: string
  onBuild: (orchestration: PlanBuildOrchestration) => void
  onScheduleStateChange?: (hasActiveSchedule: boolean) => void
}

export function PlanBuildActions({
  disabled,
  graphEnabled,
  variant,
  planId,
  onBuild,
  onScheduleStateChange
}: Props): ReactElement {
  const { t, i18n } = useTranslation('common')
  const activePlanId = useGuiPlanStore((state) => state.activePlan?.id)
  const resolvedPlanId = planId || activePlanId || ''
  const preference = usePlanWorktreePreferenceStore((state) =>
    resolvedPlanId ? state.plans[resolvedPlanId] : undefined)
  const setUsePromptWorktree = usePlanWorktreePreferenceStore((state) => state.setUsePromptWorktree)
  const [selectedMode, setSelectedMode] = useState<PlanBuildMode>('direct')
  const [settings, setSettings] = useState<AppSettingsV1 | null>(null)
  const [scheduledTask, setScheduledTask] = useState<ScheduledTaskV1 | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [scheduleError, setScheduleError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [nowMs, setNowMs] = useState(Date.now())
  const resolvedPlanIdRef = useRef(resolvedPlanId)
  resolvedPlanIdRef.current = resolvedPlanId

  const refreshSchedule = useCallback(async (): Promise<void> => {
    if (!resolvedPlanId) {
      setScheduledTask(null)
      return
    }
    try {
      const next = await rendererRuntimeClient.getSettings()
      if (resolvedPlanIdRef.current !== resolvedPlanId) return
      const task = activePlanScheduledTask(next.schedule.tasks, resolvedPlanId)
      setSettings(next)
      setScheduledTask(task)
      if (task && variant === 'card') setSelectedMode('scheduled')
    } catch (error) {
      useChatStore.getState().setError(error instanceof Error ? error.message : String(error))
    }
  }, [resolvedPlanId, variant])

  useEffect(() => {
    void refreshSchedule()
  }, [refreshSchedule])

  useEffect(() => {
    const onFocus = (): void => { void refreshSchedule() }
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') void refreshSchedule()
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [refreshSchedule])

  useEffect(() => {
    if (!scheduledTask) return
    const timer = window.setInterval(() => setNowMs(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [scheduledTask])

  const taskTime = scheduledTask ? scheduledTaskTime(scheduledTask) : ''
  const hasActiveSchedule = Boolean(taskTime && Date.parse(taskTime) > nowMs)

  useEffect(() => {
    onScheduleStateChange?.(hasActiveSchedule)
  }, [hasActiveSchedule, onScheduleStateChange])

  useEffect(() => {
    if (scheduledTask && !hasActiveSchedule) void refreshSchedule()
  }, [hasActiveSchedule, refreshSchedule, scheduledTask])

  useEffect(() => {
    if (!graphEnabled && selectedMode === 'graph') setSelectedMode('direct')
  }, [graphEnabled, selectedMode])

  const openSchedule = async (task: ScheduledTaskV1 | null): Promise<void> => {
    setScheduleError('')
    try {
      setSettings(await rendererRuntimeClient.getSettings())
      setScheduledTask(task)
      setDialogOpen(true)
    } catch (error) {
      useChatStore.getState().setError(error instanceof Error ? error.message : String(error))
    }
  }

  const submitSchedule = async (draft: ScheduleDraft): Promise<void> => {
    const planState = useGuiPlanStore.getState()
    const plan = planState.activePlan
    if (!plan || plan.id !== resolvedPlanId) return
    setSubmitting(true)
    setScheduleError('')
    try {
      if (scheduledTask) {
        const result = await window.kunGui.updateScheduleTask({
          taskId: scheduledTask.id,
          providerId: draft.providerId,
          model: draft.model,
          reasoningEffort: draft.reasoningEffort,
          schedule: draft.schedule
        })
        if (!result.ok) throw new Error(result.message)
        setScheduledTask(result.task)
      } else {
        const activeThreadId = useChatStore.getState().activeThreadId
        const selectedPreference = usePlanWorktreePreferenceStore.getState().plans[plan.id]
        const prepared = await preparePlanBuild({
          plan,
          content: planState.content,
          orchestration: 'direct',
          graphEnabled,
          usePromptWorktree: selectedPreference?.usePromptWorktree === true,
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
          ...(activeThreadId ? { sourceThreadId: activeThreadId } : {}),
          sourcePlanId: prepared.planId,
          title: prepared.title,
          prompt: prepared.prompt,
          workspaceRoot: prepared.workspaceRoot,
          orchestration: 'direct'
        })
        if (!result.ok) throw new Error(result.message)
        setScheduledTask(result.task)
      }
      setDialogOpen(false)
      await refreshSchedule()
    } catch (error) {
      setScheduleError(error instanceof Error ? error.message : String(error))
    } finally {
      setSubmitting(false)
    }
  }

  const settingsPending = Boolean(resolvedPlanId && !preference?.initialized)
  const buildDisabled = disabled || settingsPending || submitting
  const graphSelected = selectedMode === 'graph'
  const worktreeControl = resolvedPlanId && preference?.initialized ? (
    <div data-plan-worktree-control className={variant === 'card'
      ? 'flex min-w-[260px] flex-1 items-center gap-2.5'
      : 'flex min-w-0 flex-wrap items-center gap-2 text-[11.5px] text-ds-muted'}>
      <button type="button" role="switch" aria-checked={preference.usePromptWorktree}
        aria-label={t('planWorktreeUsePrompt')}
        onClick={() => setUsePromptWorktree(resolvedPlanId, !preference.usePromptWorktree)}
        disabled={graphSelected}
        className={`relative h-5 w-9 shrink-0 rounded-full transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30 ${preference.usePromptWorktree ? 'bg-accent' : 'bg-ds-faint'} disabled:cursor-not-allowed disabled:opacity-45`}>
        <span className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${preference.usePromptWorktree ? 'translate-x-4' : 'translate-x-0'}`} />
      </button>
      {variant === 'panel' ? <GitBranch className="h-3.5 w-3.5 shrink-0" strokeWidth={1.8} /> : null}
      <div className="min-w-0">
        <div className="text-[12.5px] font-medium text-ds-ink">{t('planWorktreeUsePrompt')}</div>
        <div className={`mt-0.5 text-[11px] ${graphSelected ? 'text-amber-700 dark:text-amber-300' : 'text-ds-muted'}`}>
          {graphSelected ? t('planWorktreeGraphUnsupported') : preference.usePromptWorktree ? t('planWorktreePromptHint') : t('planWorktreeCurrentWorkspaceWarning')}
        </div>
      </div>
    </div>
  ) : null

  const dialog = dialogOpen && settings ? (
    <PlanScheduledBuildDialog settings={settings} orchestration="direct" initialTask={scheduledTask}
      submitting={submitting} error={scheduleError} onClose={() => setDialogOpen(false)} onSubmit={submitSchedule} />
  ) : null

  if (variant === 'panel') {
    return (
      <div className="flex min-w-0 flex-col gap-2">
        {dialog}
        {worktreeControl}
        <div data-plan-build-actions data-plan-build-actions-variant={variant} className={`grid w-full ${graphEnabled ? 'grid-cols-2' : 'grid-cols-1'} gap-2`}>
          <button type="button" data-plan-build-schedule disabled={buildDisabled}
            onClick={() => void openSchedule(scheduledTask)}
            className="inline-flex h-9 w-full items-center justify-center gap-2 rounded-lg border border-ds-border bg-ds-card px-3 text-[13px] font-semibold text-ds-ink hover:bg-ds-hover disabled:opacity-50">
            <CalendarClock className="h-3.5 w-3.5" />
            <span className="truncate">{t(scheduledTask ? 'planScheduleBuildModify' : 'planScheduleBuild')}</span>
          </button>
          <button type="button" disabled={buildDisabled} onClick={() => onBuild('direct')}
            className="inline-flex h-9 w-full items-center justify-center gap-2 rounded-lg bg-accent px-3 text-[13px] font-semibold text-white disabled:opacity-50">
            <Hammer className="h-3.5 w-3.5" />{t('planBuildDirect')}
          </button>
          {graphEnabled ? <button type="button" disabled={disabled} onClick={() => onBuild('graph')}
            className="inline-flex h-9 w-full items-center justify-center gap-2 rounded-lg bg-indigo-600 px-3 text-[13px] font-semibold text-white disabled:opacity-50">
            <Share2 className="h-3.5 w-3.5" />{t('planBuildGraph')}
          </button> : null}
        </div>
      </div>
    )
  }

  const selectMode = (mode: PlanBuildMode): void => {
    setSelectedMode(mode)
    if (mode === 'scheduled' && !scheduledTask) void openSchedule(null)
  }
  const locale = i18n.resolvedLanguage ?? i18n.language
  const taskTimeZone = scheduledTask?.schedule.timeZone || systemTimeZone()
  const formattedTaskTime = taskTime
    ? formatPlanScheduleNextRun(taskTime, taskTimeZone, locale, nowMs)
    : ''
  const countdown = taskTime ? planScheduleCountdown(taskTime, nowMs) : { kind: 'due' as const }
  const countdownText = countdown.kind === 'remaining'
    ? [
        countdown.days > 0 ? t('planScheduleBuildCountdownDay', { count: countdown.days }) : '',
        countdown.hours > 0 ? t('planScheduleBuildCountdownHour', { count: countdown.hours }) : '',
        t('planScheduleBuildCountdownMinute', { count: countdown.minutes })
      ].filter(Boolean).join(' ')
    : t('planScheduleBuildDueSoon')

  return (
    <div className="flex w-full min-w-0 flex-col gap-3">
      {dialog}
      <div data-plan-build-actions data-plan-build-actions-variant={variant} className="flex w-full flex-wrap items-center gap-x-5 gap-y-3">
        <label className="flex min-w-0 items-center gap-2.5 text-[12.5px] font-medium text-ds-ink">
          <span className="shrink-0">{t('planBuildMode')}</span>
          <select data-plan-build-mode value={selectedMode} disabled={disabled}
            onChange={(event) => selectMode(event.target.value as PlanBuildMode)}
            className="h-10 min-w-[160px] rounded-xl border border-ds-border bg-ds-card px-3 text-[12.5px] text-ds-ink outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20">
            <option value="direct">{t('planBuildDirect')}</option>
            <option value="scheduled">{t('planScheduleBuild')}</option>
            {graphEnabled ? <option value="graph">{t('planBuildGraph')}</option> : null}
          </select>
        </label>
        {worktreeControl}
        {selectedMode === 'scheduled' && scheduledTask && taskTime && hasActiveSchedule ? (
          <div data-plan-schedule-status className="ml-auto flex min-w-[330px] max-w-full items-center gap-3">
            <CalendarClock className="h-8 w-8 shrink-0 text-accent" strokeWidth={1.7} />
            <div className="min-w-0 flex-1">
              <div className="text-[11.5px] font-medium text-ds-muted">
                {t('planScheduleBuildScheduled')}
              </div>
              <div className="mt-0.5 flex flex-wrap items-baseline gap-1 text-[14px] font-medium text-ds-ink">
                <span>{t('planScheduleBuildRemainingPrefix')}</span>
                <span className="font-semibold text-accent">{countdownText}</span>
                <span>{t('planScheduleBuildRemainingSuffix')}</span>
              </div>
              <div className="mt-0.5 truncate text-[11.5px] text-ds-muted">
                {t('planScheduleBuildNextRun', { time: formattedTaskTime })}
              </div>
            </div>
            <button type="button" data-plan-build-schedule disabled={buildDisabled}
              onClick={() => void openSchedule(scheduledTask)}
              className="inline-flex h-9 shrink-0 items-center rounded-full border border-accent bg-transparent px-3.5 text-[12.5px] font-medium text-accent transition hover:bg-accent-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/25 disabled:opacity-45">
              {t('planScheduleBuildModify')}
            </button>
          </div>
        ) : selectedMode === 'scheduled' ? (
          <button type="button" data-plan-build-schedule disabled={buildDisabled}
            onClick={() => void openSchedule(scheduledTask)}
            className="ml-auto inline-flex h-10 items-center gap-1.5 rounded-full bg-accent px-4 text-[13px] font-medium text-white transition hover:brightness-110 disabled:opacity-45">
            <CalendarClock className="h-3.5 w-3.5" />
            {t('planScheduleBuildSet')}
          </button>
        ) : (
          <button type="button" data-plan-build-start disabled={buildDisabled}
            onClick={() => onBuild(selectedMode === 'graph' ? 'graph' : 'direct')}
            className="ml-auto inline-flex h-10 items-center gap-1.5 rounded-full bg-accent px-4 text-[13px] font-medium text-white disabled:opacity-45">
            {selectedMode === 'graph' ? <Share2 className="h-3.5 w-3.5" /> : <Hammer className="h-3.5 w-3.5" />}
            {t(selectedMode === 'graph' ? 'planBuildGraphStart' : 'planBuildStart')}
          </button>
        )}
      </div>
    </div>
  )
}
