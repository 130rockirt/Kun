import { useMemo, useState, type ReactElement } from 'react'
import { CalendarClock, X } from 'lucide-react'
import type { AppSettingsV1, ScheduleReasoningEffort, ScheduleTaskCreateInput } from '@shared/app-settings'
import { formatInTimeZone, modelTimePricingState, relativeScheduleLabel, supportedTimeZones, systemTimeZone, timePricingBenefitLabel, zonedDateTimeToIso } from '@shared/app-settings'
import type { PlanBuildOrchestration } from '../../plan/plan-build'
import { useChatStore } from '../../store/chat-store'
import { resolveScheduleModelSelection, resolveScheduleReasoningSelection, scheduleModelProfileForSelection, scheduleModelProviderOptions, scheduleReasoningOptionsForModel } from '../schedule/schedule-task-support'

type Props = {
  settings: AppSettingsV1
  orchestration: PlanBuildOrchestration
  submitting: boolean
  error: string
  onClose: () => void
  onSubmit: (draft: Omit<ScheduleTaskCreateInput, 'title' | 'prompt' | 'workspaceRoot' | 'orchestration'>) => Promise<void>
}

function futureDraft(): { date: string; time: string } {
  const next = new Date(Date.now() + 60 * 60_000)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return { date: `${next.getFullYear()}-${pad(next.getMonth() + 1)}-${pad(next.getDate())}`, time: `${pad(next.getHours())}:${pad(next.getMinutes())}` }
}

export function PlanScheduledBuildDialog({ settings, orchestration, submitting, error, onClose, onSubmit }: Props): ReactElement {
  const initial = useMemo(futureDraft, [])
  const providers = useMemo(() => scheduleModelProviderOptions(settings), [settings])
  const chat = useChatStore.getState()
  const initialSelection = useMemo(
    () => resolveScheduleModelSelection(providers, chat.composerProviderId, chat.composerModel),
    [chat.composerModel, chat.composerProviderId, providers]
  )
  const [date, setDate] = useState(initial.date)
  const [time, setTime] = useState(initial.time)
  const [timeZone, setTimeZone] = useState(systemTimeZone())
  const [providerId, setProviderId] = useState(initialSelection.providerId)
  const [model, setModel] = useState(initialSelection.model)
  const selectedProvider = providers.find((provider) => provider.providerId === providerId)
  const selectedProfile = scheduleModelProfileForSelection(selectedProvider, model)
  const [reasoningEffort, setReasoningEffort] = useState<ScheduleReasoningEffort>(() =>
    resolveScheduleReasoningSelection(chat.composerReasoningEffort, selectedProfile))
  const reasoningOptions = scheduleReasoningOptionsForModel(selectedProfile)
  const instant = zonedDateTimeToIso(date, time, timeZone)
  const pricing = instant.ok ? modelTimePricingState(selectedProvider?.provider, model, instant.iso) : { state: 'unsupported' as const }
  const fieldClass = 'mt-1.5 h-10 w-full rounded-xl border border-ds-border bg-ds-card px-3 text-[13px] text-ds-ink outline-none focus:border-accent'

  const changeProvider = (nextId: string): void => {
    const next = providers.find((provider) => provider.providerId === nextId)
    const nextModel = next?.modelIds[0] ?? ''
    setProviderId(nextId)
    setModel(nextModel)
    setReasoningEffort(resolveScheduleReasoningSelection(undefined, scheduleModelProfileForSelection(next, nextModel)))
  }

  const changeModel = (nextModel: string): void => {
    setModel(nextModel)
    setReasoningEffort(resolveScheduleReasoningSelection(reasoningEffort, scheduleModelProfileForSelection(selectedProvider, nextModel)))
  }

  const submit = (): void => {
    if (!instant.ok || !selectedProvider || !model) return
    void onSubmit({
      providerId, model, reasoningEffort, mode: 'agent',
      schedule: { kind: 'at', atTime: instant.iso, timeZone }
    })
  }

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/25 p-4" role="presentation">
      <div role="dialog" aria-modal="true" aria-label="Schedule build" className="w-full max-w-[620px] rounded-[24px] border border-ds-border bg-ds-card p-6 shadow-2xl">
        <div className="flex items-start justify-between gap-4">
          <div><h2 className="text-[18px] font-semibold text-ds-ink">Schedule build</h2><p className="mt-1 text-[12px] text-ds-muted">Run this plan once with an explicit time and model.</p></div>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded-full p-2 text-ds-muted hover:bg-ds-hover"><X className="h-4 w-4" /></button>
        </div>
        <div className="mt-5 grid grid-cols-2 gap-4">
          <label className="text-[12px] text-ds-muted">Date<input className={fieldClass} type="date" value={date} onChange={(event) => setDate(event.target.value)} /></label>
          <label className="text-[12px] text-ds-muted">Time<input className={fieldClass} type="time" value={time} onChange={(event) => setTime(event.target.value)} /></label>
          <label className="col-span-2 text-[12px] text-ds-muted">Time zone<select className={fieldClass} value={timeZone} onChange={(event) => setTimeZone(event.target.value)}>{supportedTimeZones().map((zone) => <option key={zone}>{zone}</option>)}</select></label>
          <label className="text-[12px] text-ds-muted">Provider<select className={fieldClass} value={providerId} onChange={(event) => changeProvider(event.target.value)}>{providers.map((provider) => <option value={provider.providerId} key={provider.providerId}>{provider.label}</option>)}</select></label>
          <label className="text-[12px] text-ds-muted">Model<select className={fieldClass} value={model} onChange={(event) => changeModel(event.target.value)}>{selectedProvider?.modelIds.map((id) => <option key={id}>{id}</option>)}</select></label>
          <label className="col-span-2 text-[12px] text-ds-muted">Reasoning<select className={fieldClass} value={reasoningEffort} onChange={(event) => setReasoningEffort(event.target.value as ScheduleReasoningEffort)}>{reasoningOptions.map((effort) => <option key={effort}>{effort}</option>)}</select></label>
        </div>
        {instant.ok ? <p className="mt-3 text-[11.5px] text-ds-muted">{formatInTimeZone(instant.iso, timeZone)} · {relativeScheduleLabel(instant.iso)}</p> : <p className="mt-3 text-[12px] text-red-600">{instant.message}</p>}
        {pricing.rule ? <div className="mt-4 rounded-xl bg-accent-soft px-4 py-3 text-[12px] text-ds-ink"><strong>{timePricingBenefitLabel(pricing.rule.benefitKind)}</strong><div className="mt-1 text-ds-muted">{pricing.state === 'off-peak' ? 'The selected time is off-peak.' : 'The selected time is a standard period.'} Actual price or quota is determined by the provider bill.</div></div> : null}
        {error ? <p className="mt-4 text-[12px] text-red-600" role="alert">{error}</p> : null}
        <p className="mt-4 text-[11.5px] leading-5 text-ds-muted">Kun must remain running. Waiting tasks prevent automatic system sleep; fully quitting Kun stops execution. Overdue tasks are queued after restart.</p>
        <div className="mt-5 flex justify-end gap-2"><button type="button" onClick={onClose} className="h-10 rounded-full px-4 text-[13px] text-ds-muted hover:bg-ds-hover">Cancel</button><button type="button" disabled={submitting || !instant.ok || !selectedProvider} onClick={submit} className="inline-flex h-10 items-center gap-2 rounded-full bg-accent px-5 text-[13px] font-medium text-white disabled:opacity-45"><CalendarClock className="h-4 w-4" />{submitting ? 'Scheduling…' : 'Confirm schedule'}</button></div>
      </div>
    </div>
  )
}
