import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type UIEvent
} from 'react'
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  ChevronDown,
  Hammer,
  LoaderCircle
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type {
  AgentPerspectiveEvent,
  AgentPerspectiveRound,
  AgentToolCallEvent
} from '../../agent/agent-perspective-events'
import type { ModelRequestTraceRecord } from '../../agent/model-request-traces'

type RoundEntry =
  | { kind: 'event'; event: AgentPerspectiveEvent }
  | { kind: 'tool_cluster'; events: AgentToolCallEvent[] }

export function AgentPerspectiveRoundList({
  rounds,
  activityEvents,
  selectedEventId,
  threadId,
  nextCursor,
  loadingOlder,
  onLoadOlder,
  onSelect
}: {
  rounds: readonly AgentPerspectiveRound[]
  activityEvents: readonly AgentPerspectiveEvent[]
  selectedEventId: string | null
  threadId: string | null
  nextCursor?: string
  loadingOlder: boolean
  onLoadOlder: () => void
  onSelect: (event: AgentPerspectiveEvent) => void
}): ReactElement {
  const { t } = useTranslation('common')
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const loadSentinelRef = useRef<HTMLDivElement | null>(null)
  const knownEventIdsRef = useRef(new Set<string>())
  const newestSequenceRef = useRef(0)
  const knownThreadRef = useRef<string | null>(null)
  const [expandedRoundId, setExpandedRoundId] = useState<string | null>(null)
  const [newStepCount, setNewStepCount] = useState(0)

  const latestRoundId = useMemo(
    () => rounds.find((round) => !round.system)?.id ?? null,
    [rounds]
  )
  const selectedRoundId = useMemo(
    () => rounds.find((round) => round.events.some((event) => event.id === selectedEventId))?.id,
    [rounds, selectedEventId]
  )

  useEffect(() => {
    setExpandedRoundId(null)
  }, [threadId])

  useEffect(() => {
    if (selectedRoundId) {
      setExpandedRoundId(selectedRoundId)
      return
    }
    setExpandedRoundId((current) => (
      current && rounds.some((round) => round.id === current)
        ? current
        : latestRoundId
    ))
  }, [latestRoundId, rounds, selectedRoundId])

  useEffect(() => {
    if (knownThreadRef.current !== threadId) {
      knownThreadRef.current = threadId
      knownEventIdsRef.current = new Set(activityEvents.map((event) => event.id))
      newestSequenceRef.current = Math.max(
        0,
        ...activityEvents.map((event) => event.record.sequence)
      )
      setNewStepCount(0)
      return
    }
    if (knownEventIdsRef.current.size === 0) {
      knownEventIdsRef.current = new Set(activityEvents.map((event) => event.id))
      newestSequenceRef.current = Math.max(
        0,
        ...activityEvents.map((event) => event.record.sequence)
      )
      return
    }

    const previousNewestSequence = newestSequenceRef.current
    const incoming = activityEvents.filter((event) => (
      !knownEventIdsRef.current.has(event.id) &&
      event.record.sequence >= previousNewestSequence
    ))
    for (const event of activityEvents) knownEventIdsRef.current.add(event.id)
    newestSequenceRef.current = Math.max(
      previousNewestSequence,
      ...activityEvents.map((event) => event.record.sequence)
    )
    if (incoming.length > 0 && (scrollRef.current?.scrollTop ?? 0) > 16) {
      setNewStepCount((count) => count + incoming.length)
    }
  }, [activityEvents, threadId])

  useEffect(() => {
    const root = scrollRef.current
    const sentinel = loadSentinelRef.current
    if (!root || !sentinel || !nextCursor || loadingOlder || typeof IntersectionObserver === 'undefined') {
      return
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) onLoadOlder()
    }, { root, rootMargin: '120px 0px' })
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [loadingOlder, nextCursor, onLoadOlder])

  const handleScroll = (event: UIEvent<HTMLDivElement>): void => {
    if (event.currentTarget.scrollTop <= 16 && newStepCount > 0) setNewStepCount(0)
  }

  const revealNewest = (): void => {
    scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
    setNewStepCount(0)
  }

  return (
    <aside className="relative flex min-h-0 flex-col border-r border-ds-border-muted bg-ds-surface-subtle/25">
      <div className="flex h-8 shrink-0 items-center border-b border-ds-border-muted px-2.5">
        <span className="text-[9px] font-medium text-ds-muted">
          {t('agentPerspectiveNewestFirst')} ↓
        </span>
        <span className="ml-auto text-[8px] tabular-nums text-ds-faint">
          {t('agentPerspectiveLoadedRounds', { count: rounds.length })}
        </span>
      </div>

      {newStepCount > 0 ? (
        <button
          type="button"
          onClick={revealNewest}
          className="absolute left-2 right-2 top-9 z-20 rounded-md border border-accent/20 bg-ds-card/95 px-2 py-1.5 text-[9px] font-medium text-accent shadow-sm backdrop-blur"
        >
          {t('agentPerspectiveNewSteps', { count: newStepCount })}
        </button>
      ) : null}

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="min-h-0 flex-1 overflow-y-auto"
        data-testid="agent-perspective-round-scroller"
      >
        {rounds.map((round) => (
          <RoundGroup
            key={round.id}
            round={round}
            current={round.id === latestRoundId}
            expanded={round.id === expandedRoundId}
            selectedEventId={selectedEventId}
            onToggle={() => {
              const opening = expandedRoundId !== round.id
              setExpandedRoundId(opening ? round.id : null)
              if (opening && round.events[0]) onSelect(round.events[0])
            }}
            onSelect={onSelect}
          />
        ))}

        {nextCursor ? (
          <div
            ref={loadSentinelRef}
            className="px-3 py-3"
            aria-label={t('agentPerspectiveLoadingOlderRounds')}
          >
            {loadingOlder ? (
              <div className="space-y-2">
                <div className="h-2.5 w-4/5 animate-pulse rounded bg-ds-border-muted/70" />
                <div className="h-2.5 w-3/5 animate-pulse rounded bg-ds-border-muted/55" />
                <div className="flex items-center justify-center gap-1.5 pt-1 text-[8px] text-ds-faint">
                  <LoaderCircle className="h-3 w-3 animate-spin" />
                  {t('agentPerspectiveLoadingOlderRounds')}
                </div>
              </div>
            ) : (
              <div className="h-1" />
            )}
          </div>
        ) : (
          <p className="px-3 py-3 text-center text-[8px] text-ds-faint">
            {t('agentPerspectiveLoadedRounds', { count: rounds.length })}
          </p>
        )}
      </div>
    </aside>
  )
}

function RoundGroup({
  round,
  current,
  expanded,
  selectedEventId,
  onToggle,
  onSelect
}: {
  round: AgentPerspectiveRound
  current: boolean
  expanded: boolean
  selectedEventId: string | null
  onToggle: () => void
  onSelect: (event: AgentPerspectiveEvent) => void
}): ReactElement {
  const { t } = useTranslation('common')
  const entries = useMemo(() => groupRoundEntries(round.events), [round.events])
  const requestCount = round.events.filter((event) => event.kind !== 'tool_call').length
  const toolCount = round.events.length - requestCount
  const failedRecordIds = new Set(
    round.events
      .filter((event) => requestFailed(event.record))
      .map((event) => event.record.id)
  )
  const pending = round.events.some((event) => event.record.status === 'pending')
  const duration = formatDuration(roundDurationMs(round))
  const title = round.system
    ? t('agentPerspectiveSystemTasks')
    : current
      ? t('agentPerspectiveCurrentRound')
      : t('agentPerspectiveRoundAt', { time: formatTime(round.startedAt) })

  return (
    <section
      className="border-b border-ds-border-muted"
      data-round-id={round.id}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className={`flex w-full items-start gap-1.5 px-2.5 py-2 text-left transition hover:bg-ds-hover ${
          current ? 'bg-accent/[0.035]' : ''
        }`}
      >
        <ChevronDown className={`mt-0.5 h-3 w-3 shrink-0 text-ds-faint transition ${expanded ? '' : '-rotate-90'}`} />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1">
            <span className="truncate text-[9px] font-semibold">{title}</span>
            {current && !round.system ? (
              <span className="text-[8px] font-medium text-accent">{t('agentPerspectiveCurrent')}</span>
            ) : null}
            <RoundStatus pending={pending} failedCount={failedRecordIds.size} />
          </span>
          <span className="mt-0.5 block truncate text-[8px] text-ds-faint">
            {t('agentPerspectiveRoundSummary', {
              steps: round.events.length,
              requests: requestCount,
              tools: toolCount,
              duration
            })}
          </span>
        </span>
      </button>

      {expanded ? (
        <div className="border-t border-ds-border-muted/70 bg-ds-card/20">
          {entries.map((entry) => entry.kind === 'event' ? (
            <EventRow
              key={entry.event.id}
              event={entry.event}
              selected={entry.event.id === selectedEventId}
              onSelect={() => onSelect(entry.event)}
            />
          ) : (
            <ToolClusterRow
              key={`cluster:${entry.events.map((event) => event.id).join(':')}`}
              events={entry.events}
              selected={entry.events.some((event) => event.id === selectedEventId)}
              onSelect={() => onSelect(
                entry.events.find((event) => event.id === selectedEventId) ?? entry.events[0]!
              )}
            />
          ))}
        </div>
      ) : null}
    </section>
  )
}

function EventRow({
  event,
  selected,
  onSelect
}: {
  event: AgentPerspectiveEvent
  selected: boolean
  onSelect: () => void
}): ReactElement {
  const { t } = useTranslation('common')
  const failed = requestFailed(event.record)
  const pending = event.record.status === 'pending' ||
    (event.kind === 'tool_call' && !event.result)
  const Icon = event.kind === 'tool_call' ? Hammer : Bot
  const label = event.kind === 'tool_call'
    ? event.toolName
    : event.kind === 'title_generation'
      ? t('agentPerspectiveFilterTitles')
      : 'LLM'
  const summary = eventRowSummary(event, t)

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      data-event-id={event.id}
      className={`relative grid min-h-11 w-full grid-cols-[18px_34px_minmax(0,1fr)_36px_14px] items-center gap-1 border-b border-ds-border-muted/55 px-2 py-1.5 text-left transition last:border-b-0 hover:bg-ds-hover ${
        selected
          ? failed
            ? 'bg-red-500/[0.055] before:absolute before:bottom-0 before:left-0 before:top-0 before:w-0.5 before:bg-red-500'
            : 'bg-accent/[0.055] before:absolute before:bottom-0 before:left-0 before:top-0 before:w-0.5 before:bg-accent'
          : ''
      }`}
    >
      <Icon className={`h-3 w-3 ${event.kind === 'tool_call' ? 'text-cyan-600 dark:text-cyan-300' : 'text-accent'}`} />
      <span className="text-[8px] tabular-nums text-ds-faint">#{event.record.sequence}</span>
      <span className="min-w-0">
        <span className={`block truncate text-[9px] font-medium ${failed ? 'text-red-600 dark:text-red-300' : ''}`}>
          {label}
        </span>
        <span className="block truncate text-[8px] text-ds-muted" title={summary}>{summary}</span>
      </span>
      <span className="text-right text-[8px] tabular-nums text-ds-faint">
        {formatTime(event.startedAt)}
      </span>
      <EventStatus pending={pending} failed={failed} />
    </button>
  )
}

function ToolClusterRow({
  events,
  selected,
  onSelect
}: {
  events: AgentToolCallEvent[]
  selected: boolean
  onSelect: () => void
}): ReactElement {
  const { t } = useTranslation('common')
  const names = toolNameCounts(events)
  const label = names.length === 1
    ? `${names[0]!.name} ×${names[0]!.count}`
    : t('agentPerspectiveToolCluster', { count: events.length })
  const summary = names.map(({ name, count }) => `${name} ×${count}`).join(' · ')
  const failed = events.some((event) => requestFailed(event.record))
  const pending = events.some((event) => event.record.status === 'pending' || !event.result)
  const sequences = events.map((event) => event.record.sequence)
  const minSequence = Math.min(...sequences)
  const maxSequence = Math.max(...sequences)

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`relative grid min-h-11 w-full grid-cols-[18px_34px_minmax(0,1fr)_36px_14px] items-center gap-1 border-b border-ds-border-muted/55 px-2 py-1.5 text-left transition last:border-b-0 hover:bg-ds-hover ${
        selected ? 'bg-accent/[0.055] before:absolute before:bottom-0 before:left-0 before:top-0 before:w-0.5 before:bg-accent' : ''
      }`}
    >
      <Hammer className="h-3 w-3 text-cyan-600 dark:text-cyan-300" />
      <span className="text-[8px] tabular-nums text-ds-faint">
        #{minSequence === maxSequence ? minSequence : `${minSequence}–${maxSequence}`}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-[9px] font-medium">{label}</span>
        <span className="block truncate text-[8px] text-ds-muted" title={summary}>{summary}</span>
      </span>
      <span className="text-right text-[8px] tabular-nums text-ds-faint">
        {formatTime(events[0]?.startedAt ?? '')}
      </span>
      <EventStatus pending={pending} failed={failed} />
    </button>
  )
}

function RoundStatus({
  pending,
  failedCount
}: {
  pending: boolean
  failedCount: number
}): ReactElement {
  const { t } = useTranslation('common')
  if (pending) {
    return (
      <span className="ml-auto flex shrink-0 items-center gap-1 text-[8px] text-accent">
        {t('agentPerspectivePending')}
        <LoaderCircle className="h-3 w-3 animate-spin" />
      </span>
    )
  }
  if (failedCount > 0) {
    return (
      <span className="ml-auto flex shrink-0 items-center gap-1 text-[8px] text-red-600 dark:text-red-300">
        {t('agentPerspectiveRoundErrors', { count: failedCount })}
        <AlertTriangle className="h-3 w-3" />
      </span>
    )
  }
  return <CheckCircle2 className="ml-auto h-3 w-3 shrink-0 text-emerald-500" aria-label={t('agentPerspectiveCompleted')} />
}

function EventStatus({ pending, failed }: { pending: boolean; failed: boolean }): ReactElement {
  if (pending) return <LoaderCircle className="h-3 w-3 animate-spin text-accent" />
  if (failed) return <AlertTriangle className="h-3 w-3 text-red-500" />
  return <CheckCircle2 className="h-3 w-3 text-emerald-500" />
}

function groupRoundEntries(events: readonly AgentPerspectiveEvent[]): RoundEntry[] {
  const entries: RoundEntry[] = []
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!
    if (event.kind !== 'tool_call') {
      entries.push({ kind: 'event', event })
      continue
    }
    const cluster = [event]
    while (
      index + 1 < events.length &&
      events[index + 1]?.kind === 'tool_call' &&
      events[index + 1]?.record.id === event.record.id
    ) {
      cluster.push(events[index + 1] as AgentToolCallEvent)
      index += 1
    }
    entries.push(cluster.length > 1
      ? { kind: 'tool_cluster', events: cluster }
      : { kind: 'event', event })
  }
  return entries
}

function toolNameCounts(events: readonly AgentToolCallEvent[]): Array<{ name: string; count: number }> {
  const counts = new Map<string, number>()
  for (const event of events) counts.set(event.toolName, (counts.get(event.toolName) ?? 0) + 1)
  return [...counts].map(([name, count]) => ({ name, count }))
}

function eventRowSummary(
  event: AgentPerspectiveEvent,
  t: (key: string, options?: Record<string, unknown>) => string
): string {
  if (event.kind === 'tool_call') return t('agentPerspectiveToolCall')
  if (event.kind === 'title_generation') return event.title || event.record.model
  if (requestFailed(event.record)) {
    return event.record.decoded?.error || event.record.error || t('agentPerspectiveTransportError')
  }
  if (event.record.attemptReason !== 'initial' || event.record.attempt > 1) {
    return `${t('agentPerspectiveRetrying')} · ${event.record.model}`
  }
  return event.record.model
}

function roundDurationMs(round: AgentPerspectiveRound): number {
  const start = Date.parse(round.startedAt)
  let end = start
  for (const event of round.events) {
    const record = event.record
    const finished = record.finishedAt
      ? Date.parse(record.finishedAt)
      : Date.parse(record.startedAt) + (record.durationMs ?? 0)
    if (Number.isFinite(finished)) end = Math.max(end, finished)
  }
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : 0
}

function requestFailed(record: ModelRequestTraceRecord): boolean {
  const status = record.response?.status
  return record.status === 'transport_error' ||
    record.status === 'capture_error' ||
    Boolean(record.decoded?.error) ||
    (status !== undefined && status >= 400)
}

function formatTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit'
  }).format(date)
}

function formatDuration(value: number): string {
  if (value < 1_000) return `${Math.round(value)}ms`
  if (value < 60_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}s`
  const minutes = Math.floor(value / 60_000)
  const seconds = Math.round((value % 60_000) / 1_000)
  return `${minutes}m ${seconds}s`
}
