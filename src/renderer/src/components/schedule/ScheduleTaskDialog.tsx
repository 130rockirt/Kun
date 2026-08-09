import type { ReactElement, ReactNode } from 'react'
import {
  Brain,
  CalendarClock,
  ChevronDown,
  Folder,
  FolderOpen,
  MoreHorizontal,
  Power,
  Timer,
  X
} from 'lucide-react'
import type { ClawImChannelV1, ScheduledTaskV1 } from '@shared/app-settings'
import {
  compactHomePathForSettingsDisplay,
  expandHomePathForSettingsUse
} from '../../lib/settings-home-paths'
import {
  SCHEDULE_KIND_OPTIONS,
  TIME_HOURS,
  TIME_MINUTES,
  clawChannelDisplayName,
  configuredScheduleImChannels,
  dateTimeLocalValueFromIso,
  isoFromDateTimeLocalValue,
  preferredScheduleImChannel,
  resolveScheduleModelSelection,
  resolveScheduleReasoningSelection,
  scheduleImChannelOptionLabel,
  scheduleImProviderLabel,
  scheduleModelProfileForSelection,
  scheduleReasoningLabel,
  scheduleReasoningOptionsForModel,
  type ScheduleClientMode,
  type ScheduleModelProviderOption,
  type TaskDialogState
} from './schedule-task-support'

export function ScheduleTaskDialog({
  dialog,
  error,
  onClose,
  onDraftChange,
  onPickWorkspace,
  onSubmit,
  onOpenSettings,
  clawChannels,
  defaultClawWorkspaceRoot,
  modelProviders,
  tasks,
  t
}: {
  dialog: TaskDialogState
  error: string | null
  onClose: () => void
  onDraftChange: (draft: ScheduledTaskV1) => void
  onPickWorkspace: () => void
  onSubmit: () => void
  onOpenSettings: () => void
  clawChannels: ClawImChannelV1[]
  defaultClawWorkspaceRoot: string
  modelProviders: ScheduleModelProviderOption[]
  tasks: ScheduledTaskV1[]
  t: (key: string, values?: Record<string, unknown>) => string
}): ReactElement {
  const draft = dialog.draft
  const updateDraft = (patch: Partial<ScheduledTaskV1>): void => {
    onDraftChange({ ...draft, ...patch })
  }
  const updateSchedule = (patch: Partial<ScheduledTaskV1['schedule']>): void => {
    onDraftChange({ ...draft, schedule: { ...draft.schedule, ...patch } })
  }
  const imChannels = configuredScheduleImChannels(clawChannels)
  const preferredImChannel = preferredScheduleImChannel(clawChannels)
  const selectedImChannel = imChannels.find((item) => item.id === draft.clawChannelId) ?? null
  const selectedImDisplayChannel = selectedImChannel ?? preferredImChannel
  const clientMode: ScheduleClientMode = selectedImChannel ? 'im' : 'code'
  const modelSelection = resolveScheduleModelSelection(modelProviders, draft.providerId, draft.model)
  const selectedModelProvider =
    modelProviders.find((provider) => provider.providerId === modelSelection.providerId) ?? null
  const selectedModelIds = selectedModelProvider?.modelIds ?? [modelSelection.model].filter(Boolean)
  const selectedModelProfile = scheduleModelProfileForSelection(selectedModelProvider, modelSelection.model)
  const reasoningOptions = scheduleReasoningOptionsForModel(selectedModelProfile)
  const reasoningSelection = resolveScheduleReasoningSelection(draft.reasoningEffort, selectedModelProfile)
  const updateModelProvider = (providerId: string): void => {
    const selection = resolveScheduleModelSelection(modelProviders, providerId, '')
    const provider = modelProviders.find((item) => item.providerId === selection.providerId) ?? null
    const profile = scheduleModelProfileForSelection(provider, selection.model)
    updateDraft({
      providerId: selection.providerId,
      model: selection.model,
      reasoningEffort: resolveScheduleReasoningSelection(draft.reasoningEffort, profile)
    })
  }
  const updateModel = (model: string): void => {
    const selection = resolveScheduleModelSelection(modelProviders, modelSelection.providerId, model)
    const provider = modelProviders.find((item) => item.providerId === selection.providerId) ?? null
    const profile = scheduleModelProfileForSelection(provider, selection.model)
    updateDraft({
      providerId: selection.providerId,
      model: selection.model,
      reasoningEffort: resolveScheduleReasoningSelection(draft.reasoningEffort, profile)
    })
  }
  const updateClawChannel = (channelId: string): void => {
    const channel = imChannels.find((item) => item.id === channelId)
    const selection = resolveScheduleModelSelection(
      modelProviders,
      draft.providerId,
      channel?.model.trim() || draft.model
    )
    const provider = modelProviders.find((item) => item.providerId === selection.providerId) ?? null
    const profile = scheduleModelProfileForSelection(provider, selection.model)
    updateDraft({
      clawChannelId: channel?.id ?? '',
      providerId: selection.providerId,
      model: selection.model,
      reasoningEffort: resolveScheduleReasoningSelection(draft.reasoningEffort, profile),
      ...(channel
        ? {
            workspaceRoot: channel.workspaceRoot.trim() || defaultClawWorkspaceRoot || draft.workspaceRoot
          }
        : {})
    })
  }
  const updateClientMode = (mode: ScheduleClientMode): void => {
    if (mode === 'code') {
      updateDraft({ clawChannelId: '' })
      return
    }
    if (selectedImChannel) return
    if (preferredImChannel) updateClawChannel(preferredImChannel.id)
  }
  const promptCount = draft.prompt.length
  const title = dialog.mode === 'create' ? t('scheduleCreateTask') : t('scheduleEditTask')

  return (
    <div
      className="ds-no-drag fixed inset-0 z-[90] flex items-center justify-center bg-black/58 px-4 py-2"
      onMouseDown={onClose}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="schedule-task-dialog-title"
        onSubmit={(event) => {
          event.preventDefault()
          onSubmit()
        }}
        onMouseDown={(event) => event.stopPropagation()}
        className="flex max-h-[calc(100vh-1rem)] w-full max-w-[760px] flex-col overflow-hidden rounded-[22px] border border-white/55 bg-ds-card shadow-[0_30px_90px_rgba(20,47,95,0.28)] dark:border-white/10"
      >
        <div className="flex shrink-0 items-center justify-between gap-4 border-b border-ds-border-muted px-6 py-3">
          <div className="min-w-0">
            <h2 id="schedule-task-dialog-title" className="truncate text-[17px] font-semibold text-ds-ink">
              {title}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-ds-muted transition hover:bg-ds-hover hover:text-ds-ink"
            aria-label={t('close')}
            title={t('close')}
          >
            <X className="h-4 w-4" strokeWidth={1.7} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
          <div className="grid gap-4">
            <ScheduleDialogSection
              icon={<Timer className="h-4 w-4" strokeWidth={1.8} />}
              title={t('scheduleTaskSectionContent')}
            >
              <label className="grid gap-2">
                <FieldLabel required>{t('scheduleTaskName')}</FieldLabel>
                <div className="relative">
                  <input
                    value={draft.title}
                    maxLength={50}
                    onChange={(event) => updateDraft({ title: event.target.value })}
                    placeholder={t('scheduleTaskNamePlaceholder')}
                    className="h-10 w-full rounded-xl border border-ds-border bg-ds-main/55 px-3 pr-14 text-[14px] text-ds-ink outline-none transition placeholder:text-ds-faint focus:border-accent/45 focus:ring-2 focus:ring-accent/15"
                  />
                  <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[12px] text-ds-faint">
                    {draft.title.length}/50
                  </span>
                </div>
              </label>

              <label className="grid gap-2">
                <FieldLabel required>{t('scheduleTaskPrompt')}</FieldLabel>
                <div className="relative">
                  <textarea
                    value={draft.prompt}
                    maxLength={8_000}
                    onChange={(event) => updateDraft({ prompt: event.target.value })}
                    placeholder={t('scheduleTaskPromptPlaceholder')}
                    className="min-h-[108px] w-full resize-y rounded-xl border border-ds-border bg-ds-main/55 px-3 py-3 pb-8 text-[14px] leading-6 text-ds-ink outline-none transition placeholder:text-ds-faint focus:border-accent/45 focus:ring-2 focus:ring-accent/15"
                  />
                  <span className="pointer-events-none absolute bottom-3 right-3 text-[12px] text-ds-faint">
                    {promptCount}/8000
                  </span>
                </div>
              </label>
            </ScheduleDialogSection>

            <ScheduleDialogSection
              icon={<Brain className="h-4 w-4" strokeWidth={1.8} />}
              title={t('scheduleTaskSectionModel')}
            >
              <div className="grid gap-4">
                <div className="grid gap-2">
                  <FieldLabel>{t('scheduleClientMode')}</FieldLabel>
                  <div className="grid grid-cols-2 gap-2">
                    <SegmentButton
                      selected={clientMode === 'code'}
                      onClick={() => updateClientMode('code')}
                    >
                      {t('scheduleClientModeCode')}
                    </SegmentButton>
                    <SegmentButton
                      selected={clientMode === 'im'}
                      disabled={imChannels.length === 0}
                      onClick={() => updateClientMode('im')}
                    >
                      {t('scheduleClientModeIm')}
                    </SegmentButton>
                  </div>
                  {imChannels.length === 0 ? (
                    <p className="text-[12px] leading-5 text-ds-faint">{t('scheduleClientModeImUnavailable')}</p>
                  ) : null}
                </div>

                {clientMode === 'im' ? (
                  <label className="grid gap-2">
                    <FieldLabel>{t('scheduleImClient')}</FieldLabel>
                    <div className="relative">
                      <select
                        value={selectedImDisplayChannel?.id ?? ''}
                        onChange={(event) => updateClawChannel(event.target.value)}
                        aria-label={t('scheduleImClient')}
                        title={selectedImDisplayChannel ? scheduleImChannelOptionLabel(selectedImDisplayChannel, t) : undefined}
                        className="peer absolute inset-0 z-10 h-10 w-full cursor-pointer opacity-0"
                      >
                        {imChannels.map((channel) => (
                          <option key={channel.id} value={channel.id}>
                            {scheduleImChannelOptionLabel(channel, t)}
                          </option>
                        ))}
                      </select>
                      <div className="pointer-events-none flex h-10 w-full items-center gap-3 rounded-xl border border-ds-border bg-ds-main/55 px-3 pr-10 text-[14px] text-ds-ink outline-none transition peer-focus:border-accent/45 peer-focus:ring-2 peer-focus:ring-accent/15">
                        <span className="min-w-0 flex-1 truncate">
                          {selectedImDisplayChannel ? clawChannelDisplayName(selectedImDisplayChannel) : ''}
                        </span>
                        {selectedImDisplayChannel ? (
                          <span className="shrink-0 rounded-lg border border-ds-border-muted bg-ds-subtle px-2 py-0.5 text-[12px] font-semibold text-ds-muted">
                            {scheduleImProviderLabel(selectedImDisplayChannel, t)}
                          </span>
                        ) : null}
                      </div>
                      <ChevronDown
                        className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ds-faint"
                        strokeWidth={1.8}
                        aria-hidden="true"
                      />
                    </div>
                  </label>
                ) : null}

                <div className="grid gap-4 md:grid-cols-[minmax(0,0.9fr)_minmax(0,1fr)_minmax(0,2fr)]">
                  <label className="grid gap-2">
                    <FieldLabel required>{t('scheduleProvider')}</FieldLabel>
                    <select
                      value={modelSelection.providerId}
                      onChange={(event) => updateModelProvider(event.target.value)}
                      className="h-10 w-full rounded-xl border border-ds-border bg-ds-main/55 px-3 text-[14px] text-ds-ink outline-none transition focus:border-accent/45 focus:ring-2 focus:ring-accent/15"
                    >
                      {modelProviders.map((provider) => (
                        <option key={provider.providerId} value={provider.providerId}>
                          {provider.label}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="grid gap-2">
                    <FieldLabel required>{t('scheduleModel')}</FieldLabel>
                    <select
                      value={modelSelection.model}
                      onChange={(event) => updateModel(event.target.value)}
                      className="h-10 w-full rounded-xl border border-ds-border bg-ds-main/55 px-3 text-[14px] text-ds-ink outline-none transition focus:border-accent/45 focus:ring-2 focus:ring-accent/15"
                    >
                      {selectedModelIds.map((model) => (
                        <option key={model} value={model}>{model}</option>
                      ))}
                    </select>
                  </label>

                  <div className="grid gap-2">
                    <FieldLabel>{t('scheduleReasoning')}</FieldLabel>
                    <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
                      {reasoningOptions.map((effort) => (
                        <SegmentButton
                          key={effort}
                          selected={reasoningSelection === effort}
                          onClick={() => updateDraft({ reasoningEffort: effort })}
                        >
                          {scheduleReasoningLabel(effort, t)}
                        </SegmentButton>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </ScheduleDialogSection>

            <ScheduleDialogSection
              icon={<CalendarClock className="h-4 w-4" strokeWidth={1.8} />}
              title={t('scheduleTaskSectionTiming')}
            >
              <div className="grid gap-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
                <div className="grid gap-2">
                  <FieldLabel required>{t('scheduleRunAt')}</FieldLabel>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    {SCHEDULE_KIND_OPTIONS.map((kind) => (
                      <SegmentButton
                        key={kind}
                        selected={draft.schedule.kind === kind}
                        onClick={() => updateSchedule({ kind })}
                      >
                        {t(`scheduleKind_${kind}`)}
                      </SegmentButton>
                    ))}
                  </div>
                </div>

                {draft.schedule.kind === 'daily' ? (
                  <div className="grid gap-2">
                    <FieldLabel>{t('scheduleDailyTime')}</FieldLabel>
                    <ScheduleTimePicker
                      value={draft.schedule.timeOfDay}
                      onChange={(timeOfDay) => updateSchedule({ timeOfDay })}
                      t={t}
                    />
                  </div>
                ) : draft.schedule.kind === 'at' ? (
                  <label className="grid gap-2">
                    <FieldLabel>{t('scheduleAtTime')}</FieldLabel>
                    <input
                      type="datetime-local"
                      value={dateTimeLocalValueFromIso(draft.schedule.atTime)}
                      onChange={(event) => updateSchedule({ atTime: isoFromDateTimeLocalValue(event.target.value) })}
                      className="h-10 w-full rounded-xl border border-ds-border bg-ds-main/55 px-3 text-[14px] text-ds-ink outline-none transition focus:border-accent/45 focus:ring-2 focus:ring-accent/15"
                    />
                  </label>
                ) : draft.schedule.kind === 'interval' ? (
                  <label className="grid gap-2">
                    <FieldLabel>{t('scheduleEveryMinutes')}</FieldLabel>
                    <input
                      type="number"
                      min={1}
                      max={10080}
                      value={draft.schedule.everyMinutes}
                      onChange={(event) => updateSchedule({ everyMinutes: Number(event.target.value) })}
                      className="h-10 w-full rounded-xl border border-ds-border bg-ds-main/55 px-3 text-[14px] text-ds-ink outline-none transition focus:border-accent/45 focus:ring-2 focus:ring-accent/15"
                    />
                  </label>
                ) : (
                  <div className="flex min-h-10 items-center rounded-xl bg-ds-subtle px-3 text-[13px] text-ds-muted">
                    {t('scheduleManualHint')}
                  </div>
                )}
              </div>
            </ScheduleDialogSection>

            <ScheduleDialogSection
              icon={<Folder className="h-4 w-4" strokeWidth={1.8} />}
              title={t('scheduleTaskSectionEnvironment')}
            >
              <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_180px]">
                <label className="grid gap-2">
                  <FieldLabel>{t('scheduleWorkspace')}</FieldLabel>
                  <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_138px]">
                    <input
                      value={compactHomePathForSettingsDisplay(draft.workspaceRoot)}
                      onChange={(event) =>
                        updateDraft({ workspaceRoot: expandHomePathForSettingsUse(event.target.value) })}
                      placeholder={t('scheduleWorkspacePlaceholder')}
                      className="h-10 w-full rounded-xl border border-ds-border bg-ds-main/55 px-3 text-[14px] text-ds-ink outline-none transition placeholder:text-ds-faint focus:border-accent/45 focus:ring-2 focus:ring-accent/15"
                    />
                    <button
                      type="button"
                      onClick={onPickWorkspace}
                      className="inline-flex h-10 items-center justify-center gap-2 rounded-xl border border-ds-border bg-ds-card px-3 text-[13px] font-medium text-ds-muted transition hover:bg-ds-hover hover:text-ds-ink"
                    >
                      <FolderOpen className="h-4 w-4" strokeWidth={1.75} />
                      {draft.workspaceRoot.trim() ? t('changeWorkspace') : t('selectWorkspace')}
                    </button>
                  </div>
                </label>

                <div className="grid gap-2">
                  <FieldLabel>{t('scheduleTaskEnabled')}</FieldLabel>
                  <button
                    type="button"
                    onClick={() => updateDraft({ enabled: !draft.enabled })}
                    className="flex h-10 items-center justify-between gap-3 rounded-xl border border-ds-border bg-ds-main/55 px-3 text-[13px] font-medium text-ds-muted transition hover:bg-ds-hover hover:text-ds-ink"
                    aria-pressed={draft.enabled}
                  >
                    <span className="inline-flex min-w-0 items-center gap-2">
                      <Power className="h-4 w-4 shrink-0" strokeWidth={1.8} />
                      <span className="truncate">{t('scheduleTaskEnabled')}</span>
                    </span>
                    <span className={`relative h-5 w-9 shrink-0 rounded-full transition ${draft.enabled ? 'bg-ds-ink' : 'bg-ds-border-strong'}`}>
                      <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition ${draft.enabled ? 'left-[18px]' : 'left-0.5'}`} />
                    </span>
                  </button>
                </div>
              </div>
              <div className="grid gap-4 md:grid-cols-[160px_minmax(0,1fr)]">
                <label className="grid gap-2">
                  <FieldLabel>{t('scheduleTaskPriority')}</FieldLabel>
                  <input
                    type="number"
                    min={0}
                    max={100}
                    value={draft.priority ?? 0}
                    onChange={(event) => updateDraft({ priority: Number(event.target.value) })}
                    className="h-10 w-full rounded-xl border border-ds-border bg-ds-main/55 px-3 text-[14px] text-ds-ink outline-none transition focus:border-accent/45 focus:ring-2 focus:ring-accent/15"
                  />
                </label>
                <div className="grid gap-2">
                  <FieldLabel>{t('scheduleTaskIsolation')}</FieldLabel>
                  <button
                    type="button"
                    onClick={() => updateDraft({ useWorktree: !draft.useWorktree })}
                    className="flex h-10 items-center justify-between gap-3 rounded-xl border border-ds-border bg-ds-main/55 px-3 text-[13px] font-medium text-ds-muted transition hover:bg-ds-hover hover:text-ds-ink"
                    aria-pressed={Boolean(draft.useWorktree)}
                  >
                    <span>{t('scheduleTaskUseWorktree')}</span>
                    <span className={`relative h-5 w-9 shrink-0 rounded-full transition ${draft.useWorktree ? 'bg-ds-ink' : 'bg-ds-border-strong'}`}>
                      <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition ${draft.useWorktree ? 'left-[18px]' : 'left-0.5'}`} />
                    </span>
                  </button>
                </div>
              </div>
              {tasks.some((task) => task.id !== draft.id) ? (
                <div className="grid gap-2">
                  <FieldLabel>{t('scheduleTaskDependencies')}</FieldLabel>
                  <div className="grid max-h-32 gap-2 overflow-y-auto rounded-xl border border-ds-border bg-ds-main/35 p-3 sm:grid-cols-2">
                    {tasks.filter((task) => task.id !== draft.id).map((task) => {
                      const selected = (draft.dependsOn ?? []).includes(task.id)
                      return (
                        <label key={task.id} className="flex min-w-0 items-center gap-2 text-[13px] text-ds-muted">
                          <input
                            type="checkbox"
                            checked={selected}
                            onChange={() => updateDraft({
                              dependsOn: selected
                                ? (draft.dependsOn ?? []).filter((id) => id !== task.id)
                                : [...(draft.dependsOn ?? []), task.id]
                            })}
                          />
                          <span className="truncate">{task.title || t('scheduleUntitled')}</span>
                        </label>
                      )
                    })}
                  </div>
                </div>
              ) : null}
            </ScheduleDialogSection>
          </div>

          {error ? (
            <div className="mt-5 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200">
              {error}
            </div>
          ) : null}
        </div>

        <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-ds-border-muted bg-ds-card px-6 py-3">
          <button
            type="button"
            onClick={onOpenSettings}
            className="inline-flex h-8 items-center gap-2 rounded-xl px-3 text-[13px] font-medium text-ds-muted transition hover:bg-ds-hover hover:text-ds-ink"
          >
            <MoreHorizontal className="h-4 w-4" strokeWidth={1.8} />
            {t('scheduleAdvancedSettings')}
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="h-8 rounded-xl border border-ds-border bg-ds-card px-4 text-[13px] font-medium text-ds-muted transition hover:bg-ds-hover hover:text-ds-ink"
            >
              {t('cancel')}
            </button>
            <button
              type="submit"
              className="h-8 rounded-xl bg-ds-userbubble px-5 text-[13px] font-semibold text-ds-userbubbleFg transition hover:opacity-90"
            >
              {t('confirm')}
            </button>
          </div>
        </div>
      </form>
    </div>
  )
}

function ScheduleDialogSection({
  icon,
  title,
  children
}: {
  icon: ReactElement
  title: string
  children: ReactNode
}): ReactElement {
  return (
    <section className="grid gap-3 border-t border-ds-border-muted pt-4 first:border-t-0 first:pt-0">
      <div className="flex items-center gap-2 text-[13px] font-semibold text-ds-ink">
        <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-ds-subtle text-ds-muted">
          {icon}
        </span>
        <span>{title}</span>
      </div>
      {children}
    </section>
  )
}

function FieldLabel({
  children,
  required = false
}: {
  children: ReactNode
  required?: boolean
}): ReactElement {
  return (
    <span className="flex min-h-5 items-center gap-1 text-[13px] font-medium text-ds-ink">
      <span className="min-w-0 truncate">{children}</span>
      {required ? <span className="text-red-500">*</span> : null}
    </span>
  )
}

function SegmentButton({
  selected,
  disabled = false,
  onClick,
  children
}: {
  selected: boolean
  disabled?: boolean
  onClick: () => void
  children: ReactNode
}): ReactElement {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`h-9 min-w-0 rounded-xl border px-2.5 text-[12.5px] font-semibold transition ${
        selected
          ? 'border-accent/45 bg-accent/10 text-ds-ink shadow-sm'
          : disabled
            ? 'cursor-not-allowed border-ds-border bg-ds-subtle text-ds-faint opacity-60'
            : 'border-ds-border bg-ds-main/55 text-ds-muted hover:bg-ds-hover hover:text-ds-ink'
      }`}
    >
      <span className="block truncate">{children}</span>
    </button>
  )
}

function ScheduleTimePicker({
  value,
  onChange,
  t
}: {
  value: string
  onChange: (value: string) => void
  t: (key: string, values?: Record<string, unknown>) => string
}): ReactElement {
  const [hour, minute] = splitTimeOfDay(value)
  const selectClass = 'h-10 w-full rounded-xl border border-ds-border bg-ds-main/55 px-3 text-[14px] text-ds-ink outline-none transition focus:border-accent/45 focus:ring-2 focus:ring-accent/15'

  return (
    <div className="grid grid-cols-2 gap-2">
      <select
        value={hour}
        onChange={(event) => onChange(`${event.target.value}:${minute}`)}
        className={selectClass}
        aria-label={t('scheduleTimeHour')}
      >
        {TIME_HOURS.map((item) => (
          <option key={item} value={item}>{item}</option>
        ))}
      </select>
      <select
        value={minute}
        onChange={(event) => onChange(`${hour}:${event.target.value}`)}
        className={selectClass}
        aria-label={t('scheduleTimeMinute')}
      >
        {TIME_MINUTES.map((item) => (
          <option key={item} value={item}>{item}</option>
        ))}
      </select>
    </div>
  )
}

function splitTimeOfDay(value: string): [string, string] {
  const match = /^(?<hour>[01]\d|2[0-3]):(?<minute>[0-5]\d)$/u.exec(value)
  return [match?.groups?.hour ?? '09', match?.groups?.minute ?? '00']
}
