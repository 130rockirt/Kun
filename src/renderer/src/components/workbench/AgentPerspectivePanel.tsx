import { useEffect, useMemo, useState, type ReactElement, type ReactNode } from 'react'
import {
  AlertTriangle,
  Bot,
  Braces,
  Check,
  CheckCircle2,
  ChevronDown,
  Clipboard,
  FileText,
  Hammer,
  LoaderCircle,
  MessageSquareText,
  RefreshCw,
  ScanSearch,
  Search,
  Sparkles,
  Puzzle
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import {
  groupAgentPerspectiveEvents,
  projectAgentPerspectiveEvents,
  usageNumber,
  type AgentPerspectiveEvent,
  type AgentPerspectiveEventKind,
  type SemanticRequest,
  type SemanticToolDefinition
} from '../../agent/agent-perspective-events'
import {
  groupToolsByProvenance,
  type ToolProvenance,
  type ToolProvenanceCategory,
  type ToolProvenanceGroup,
  type ToolProvenanceManagement,
  type ToolProvenanceSource,
  type ToolProvenanceSubgroup
} from '../../agent/agent-tool-provenance'
import type {
  ModelRequestTraceBody,
  ModelRequestTraceDelegated,
  ModelRequestTraceHeaders,
  ModelRequestTraceRecord
} from '../../agent/model-request-traces'
import { AgentPerspectiveRoundList } from './AgentPerspectiveRoundList'
import { useModelRequestTraces } from './useModelRequestTraces'

type DetailSection = 'summary' | 'input' | 'output' | 'technical'
type EventFilter = 'rounds' | 'errors'
type BodyMode = 'pretty' | 'raw'

const SECTION_KEYS: ReadonlyArray<{ id: DetailSection; label: string }> = [
  { id: 'summary', label: 'agentPerspectiveSummary' },
  { id: 'input', label: 'agentPerspectiveInput' },
  { id: 'output', label: 'agentPerspectiveOutput' },
  { id: 'technical', label: 'agentPerspectiveTechnicalDetails' }
]

const FILTER_KEYS: ReadonlyArray<{ id: EventFilter; label: string }> = [
  { id: 'rounds', label: 'agentPerspectiveFilterRounds' },
  { id: 'errors', label: 'agentPerspectiveFilterErrors' }
]

export function AgentPerspectivePanel({
  threadId,
  active,
  threadRunning
}: {
  threadId: string | null
  active: boolean
  threadRunning: boolean
}): ReactElement {
  const { t } = useTranslation('common')
  const traces = useModelRequestTraces({ threadId, visible: active, threadRunning })
  const events = useMemo(() => projectAgentPerspectiveEvents(traces.records), [traces.records])
  const rounds = useMemo(() => groupAgentPerspectiveEvents(events), [events])
  const [section, setSection] = useState<DetailSection>('summary')
  const [filter, setFilter] = useState<EventFilter>('rounds')
  const [query, setQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null)

  const visibleRounds = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    return rounds.flatMap((round) => {
      const matchingEvents = round.events.filter((event) => {
        if (filter === 'errors' && !requestFailed(event.record)) return false
        return !needle || eventSearchText(event).toLocaleLowerCase().includes(needle)
      })
      return matchingEvents.length ? [{ ...round, events: matchingEvents }] : []
    })
  }, [filter, query, rounds])

  const visibleEvents = visibleRounds.flatMap((round) => round.events)
  const selected = visibleEvents.find((event) => event.id === selectedEventId) ?? visibleEvents[0] ?? null
  const requestCount = events.filter((event) => event.kind !== 'tool_call').length

  useEffect(() => {
    setSelectedEventId(null)
    setSection('summary')
    setFilter('rounds')
    setQuery('')
    setSearchOpen(false)
  }, [threadId])

  useEffect(() => {
    if (selectedEventId && !events.some((event) => event.id === selectedEventId)) {
      setSelectedEventId(null)
    }
  }, [events, selectedEventId])

  useEffect(() => setSection('summary'), [selected?.id])

  return (
    <div className="ds-no-drag flex h-full min-h-0 flex-col bg-ds-sidebar text-ds-ink">
      <header className="shrink-0 border-b border-ds-border-muted px-3 pb-2 pt-2.5">
        <div className="flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent/10 text-accent">
            <ScanSearch className="h-4 w-4" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-[12px] font-semibold">{t('agentPerspectiveTitle')}</h2>
            <p className="truncate text-[10px] text-ds-muted">
              {t('agentPerspectiveEventSubtitle', { events: events.length, requests: requestCount })}
            </p>
          </div>
          {traces.activeCount > 0 ? (
            <span className="h-2 w-2 animate-pulse rounded-full bg-amber-500" aria-label={t('agentPerspectivePending')} />
          ) : null}
          <button
            type="button"
            onClick={() => setSearchOpen((open) => !open)}
            className={`rounded-md p-1.5 transition ${searchOpen ? 'bg-ds-hover text-ds-ink' : 'text-ds-muted hover:bg-ds-hover hover:text-ds-ink'}`}
            aria-label={t('agentPerspectiveSearch')}
            aria-pressed={searchOpen}
          >
            <Search className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={traces.refresh}
            disabled={!threadId || traces.loading}
            className="rounded-md p-1.5 text-ds-muted transition hover:bg-ds-hover hover:text-ds-ink disabled:opacity-40"
            aria-label={t('agentPerspectiveRefresh')}
            data-tooltip={t('agentPerspectiveRefresh')}
          >
            <RefreshCw className={`h-3.5 w-3.5 ${traces.loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
        <div className="mt-2 flex min-w-0 items-center gap-1 overflow-x-auto">
          {FILTER_KEYS.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setFilter(item.id)}
              aria-pressed={filter === item.id}
              className={`shrink-0 rounded-md px-2 py-1 text-[9px] font-medium transition ${
                filter === item.id
                  ? 'bg-accent/12 text-accent'
                  : 'text-ds-muted hover:bg-ds-hover hover:text-ds-ink'
              }`}
            >
              {t(item.label)}
            </button>
          ))}
        </div>
        {searchOpen ? (
          <label className="mt-2 flex items-center gap-1.5 rounded-md border border-ds-border-muted bg-ds-card px-2 py-1.5">
            <Search className="h-3 w-3 shrink-0 text-ds-faint" />
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('agentPerspectiveSearchPlaceholder')}
              className="min-w-0 flex-1 bg-transparent text-[10px] outline-none placeholder:text-ds-faint"
            />
          </label>
        ) : null}
      </header>

      {!threadId ? (
        <EmptyState text={t('agentPerspectiveUnsupported')} />
      ) : traces.loading && traces.records.length === 0 ? (
        <EmptyState text={t('agentPerspectiveLoading')} spinning />
      ) : traces.error && traces.records.length === 0 ? (
        <EmptyState text={t('agentPerspectiveLoadError', { error: traces.error })} warning />
      ) : traces.records.length === 0 ? (
        <EmptyState text={t('agentPerspectiveEmpty')} />
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-[220px_minmax(0,1fr)]">
          {visibleRounds.length ? (
            <AgentPerspectiveRoundList
              rounds={visibleRounds}
              activityEvents={events}
              selectedEventId={selected?.id ?? null}
              threadId={threadId}
              nextCursor={traces.nextCursor}
              loadingOlder={traces.loadingOlder}
              onLoadOlder={traces.loadOlder}
              onSelect={(event) => {
                setSelectedEventId(event.id)
                traces.select(event.record.id)
              }}
            />
          ) : (
            <aside className="border-r border-ds-border-muted bg-ds-surface-subtle/25">
              <p className="px-3 py-8 text-center text-[10px] leading-4 text-ds-faint">
                {t('agentPerspectiveNoMatchingEvents')}
              </p>
            </aside>
          )}

          <main className="flex min-h-0 min-w-0 flex-col bg-ds-card/35">
            {selected ? (
              <>
                <EventHero event={selected} />
                <nav
                  role="tablist"
                  aria-label={t('agentPerspectiveDetailSections')}
                  className="flex shrink-0 gap-0.5 overflow-x-auto border-b border-ds-border-muted px-2"
                >
                  {SECTION_KEYS.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      role="tab"
                      aria-selected={section === item.id}
                      onClick={() => setSection(item.id)}
                      className={`whitespace-nowrap border-b-2 px-2 py-2 text-[9px] font-medium transition ${
                        section === item.id
                          ? 'border-accent text-ds-ink'
                          : 'border-transparent text-ds-muted hover:text-ds-ink'
                      }`}
                    >
                      {t(item.label)}
                    </button>
                  ))}
                </nav>
                <div className="min-h-0 flex-1 overflow-auto p-3">
                  <EventDetail event={selected} section={section} />
                </div>
              </>
            ) : (
              <EmptyState text={t('agentPerspectiveNoMatchingEvents')} />
            )}
          </main>
        </div>
      )}

      {traces.error && traces.records.length > 0 ? (
        <div role="alert" className="shrink-0 border-t border-amber-500/25 bg-amber-500/8 px-3 py-1.5 text-[10px] text-amber-700 dark:text-amber-300">
          {t('agentPerspectiveLoadError', { error: traces.error })}
        </div>
      ) : null}
      {traces.warnings.map((warning) => (
        <div key={warning} role="status" className="shrink-0 border-t border-amber-500/25 bg-amber-500/8 px-3 py-1.5 text-[10px] text-amber-700 dark:text-amber-300">
          {warning}
        </div>
      ))}
      <div className="shrink-0 border-t border-ds-border-muted px-3 py-1 text-center text-[8px] text-ds-faint">
        {t('agentPerspectivePrivacyNotice')}
      </div>
    </div>
  )
}

function EventHero({ event }: { event: AgentPerspectiveEvent }): ReactElement {
  const { t } = useTranslation('common')
  const style = eventStyle(event.kind)
  const Icon = style.Icon
  const record = event.record
  const usage = record.decoded?.usage
  const totalTokens = usageNumber(usage, 'totalTokens')
  const cacheHitRate = usageNumber(usage, 'cacheHitRate')
  const semantic = event.kind === 'tool_call' ? null : event.semantic
  const toolGroups = semantic ? groupToolsByProvenance(semantic.tools) : []
  return (
    <section className="shrink-0 border-b border-ds-border-muted px-3 py-2.5">
      <div className="flex items-center gap-2">
        <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${style.iconClass}`}>
          <Icon className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <h3 className="truncate text-[11px] font-semibold">{t(style.label)}</h3>
            <StatusBadge record={record} />
          </div>
          <p className="mt-0.5 truncate text-[9px] text-ds-muted">{eventSubtitle(event)}</p>
        </div>
        <div className="text-right text-[8px] text-ds-faint">
          <div>{formatTimestamp(record.startedAt)}</div>
          {record.durationMs !== undefined ? <div>{Math.round(record.durationMs)} ms</div> : null}
        </div>
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5 text-[8px]">
        <MetaChip>{record.model}</MetaChip>
        <MetaChip>{record.provider}</MetaChip>
        {event.kind === 'tool_call' ? (
          <ToolProvenanceBadges provenance={event.provenance} />
        ) : semantic?.tools.length ? (
          <MetaChip>
            {t('agentPerspectiveToolSourceSummary', {
              groups: toolGroups.length,
              tools: semantic.tools.length
            })}
          </MetaChip>
        ) : null}
        {totalTokens !== undefined ? <MetaChip>{t('agentPerspectiveTokens', { count: totalTokens })}</MetaChip> : null}
        {cacheHitRate !== undefined ? <MetaChip>{t('agentPerspectiveCacheHit', { rate: Math.round(cacheHitRate * 100) })}</MetaChip> : null}
        {record.delegated ? (
          <>
            <MetaChip>{delegatedProviderLabel(record.delegated.providerKind)}</MetaChip>
            <MetaChip>{t(delegatedPhaseKey(record.delegated.phase))}</MetaChip>
          </>
        ) : null}
        <MetaChip>{record.endpointFormat}</MetaChip>
      </div>
    </section>
  )
}

function EventDetail({ event, section }: { event: AgentPerspectiveEvent; section: DetailSection }): ReactElement {
  if (section === 'summary') return <EventSummary event={event} />
  if (section === 'output') return <ResponseDetail record={event.record} />
  if (section === 'technical') return <TechnicalDetail record={event.record} />
  if (event.kind === 'tool_call') return <ToolCallDetail event={event} />
  if (event.kind === 'title_generation') {
    return <SemanticRequestDetail semantic={event.semantic} record={event.record} />
  }
  return <SemanticRequestDetail semantic={event.semantic} record={event.record} />
}

function EventSummary({ event }: { event: AgentPerspectiveEvent }): ReactElement {
  const { t } = useTranslation('common')
  if (event.kind === 'tool_call') return <ToolCallDetail event={event} />
  if (event.kind === 'title_generation') return <TitleGenerationDetail event={event} />

  const record = event.record
  const usage = record.decoded?.usage
  const cacheHitRate = usageNumber(usage, 'cacheHitRate')
  const error = record.decoded?.error || record.error ||
    (record.response && record.response.status >= 400
      ? `HTTP ${record.response.status} ${record.response.statusText}`
      : '')
  const output = record.decoded?.text || record.decoded?.reasoning || ''
  const composition = requestComposition(event.semantic, record)
  const metrics: Array<[string, string]> = [
    [
      t('agentPerspectiveStatus'),
      record.response ? `HTTP ${record.response.status}` : statusLabel(t, record)
    ],
    [
      t('agentPerspectiveTimeToHeaders'),
      record.timeToHeadersMs === undefined ? '—' : formatMilliseconds(record.timeToHeadersMs)
    ],
    [
      t('agentPerspectiveDuration'),
      record.durationMs === undefined ? '—' : formatMilliseconds(record.durationMs)
    ],
    [
      t('agentPerspectiveCacheHitLabel'),
      cacheHitRate === undefined ? '—' : `${Math.round(cacheHitRate * 100)}%`
    ]
  ]

  return (
    <div className="space-y-4">
      {error ? (
        <section className="border-l-2 border-red-500 px-3 py-1.5">
          <h4 className="text-[11px] font-semibold text-red-600 dark:text-red-300">{error}</h4>
          <p className="mt-1 text-[9px] text-ds-muted">
            {record.status === 'transport_error'
              ? t('agentPerspectiveTransportError')
              : t('agentPerspectiveModelError')}
          </p>
        </section>
      ) : null}
      {record.delegated ? <DelegatedTraceSummary delegated={record.delegated} /> : null}
      <dl className="grid grid-cols-2 gap-x-5 gap-y-3 border-y border-ds-border-muted py-3 sm:grid-cols-4">
        {metrics.map(([label, value]) => (
          <div key={label} className="min-w-0">
            <dt className="text-[8px] text-ds-faint">{label}</dt>
            <dd className="mt-1 truncate text-[11px] font-semibold tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
      <SummaryComposition items={composition} />
      {output ? (
        <section>
          <h4 className="text-[9px] font-semibold uppercase tracking-wide text-ds-muted">
            {t('agentPerspectiveKeyOutput')}
          </h4>
          <p className="mt-2 line-clamp-4 whitespace-pre-wrap break-words text-[10px] leading-5 text-ds-ink">
            {output}
          </p>
        </section>
      ) : null}
    </div>
  )
}

function TechnicalDetail({ record }: { record: ModelRequestTraceRecord }): ReactElement {
  return (
    <div className="space-y-5">
      <TimingDetail record={record} />
      <RawRequest record={record} />
      <StreamDetail record={record} />
    </div>
  )
}

function SemanticRequestDetail({
  semantic,
  record,
  compact = false
}: {
  semantic: SemanticRequest
  record: ModelRequestTraceRecord
  compact?: boolean
}): ReactElement {
  const { t } = useTranslation('common')
  const composition = requestComposition(semantic, record)
  return (
    <div className="space-y-3">
      {semantic.parseError ? <Notice text={semantic.parseError} warning /> : null}
      {record.delegated ? <DelegatedTraceSummary delegated={record.delegated} /> : null}
      {!compact ? <CompositionBar items={composition} /> : null}

      <SemanticSection
        title={t('agentPerspectiveSystemPrompt')}
        count={semantic.prompts.length}
        icon={<FileText className="h-3 w-3" />}
        open
      >
        {semantic.prompts.length ? semantic.prompts.map((prompt, index) => (
          <article key={prompt.id} className="border-b border-ds-border-muted px-2.5 py-2 last:border-b-0">
            <div className="mb-1 flex items-center justify-between text-[8px] font-medium uppercase tracking-wide text-ds-faint">
              <span>{prompt.source}</span>
              <span>{prompt.text.length.toLocaleString()} chars</span>
            </div>
            <ScrollablePre
              ariaLabel={`${t('agentPerspectiveSystemPrompt')} ${index + 1}`}
              className="max-h-56 whitespace-pre-wrap break-words font-sans text-[10px] leading-4 text-ds-ink"
            >
              {prompt.text}
            </ScrollablePre>
          </article>
        )) : <SectionEmpty text="—" />}
      </SemanticSection>

      <SemanticSection
        title={t('agentPerspectiveSkills')}
        count={semantic.skills.length}
        icon={<Sparkles className="h-3 w-3" />}
      >
        {semantic.skills.length ? semantic.skills.map((skill) => (
          <article key={skill.id} className="border-b border-ds-border-muted px-2.5 py-2 last:border-b-0">
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="truncate text-[10px] font-semibold">{skill.name}</span>
              <code className="truncate rounded bg-violet-500/10 px-1 py-0.5 text-[8px] text-violet-600 dark:text-violet-300">{skill.id}</code>
              {skill.active ? (
                <span className="ml-auto rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[8px] font-medium text-emerald-700 dark:text-emerald-300">
                  {t('agentPerspectiveSkillActive')}
                </span>
              ) : null}
            </div>
            {skill.description ? <p className="mt-1 line-clamp-3 text-[9px] leading-4 text-ds-muted">{skill.description}</p> : null}
            {skill.path ? <p className="mt-1 truncate font-mono text-[8px] text-ds-faint" title={skill.path}>{skill.path}</p> : null}
          </article>
        )) : <SectionEmpty text={t('agentPerspectiveNoSkills')} />}
      </SemanticSection>

      <SemanticSection
        title={t('agentPerspectiveToolDefinitions')}
        count={semantic.tools.length}
        icon={<Braces className="h-3 w-3" />}
        open
      >
        {semantic.tools.length
          ? <ToolDefinitionGroups tools={semantic.tools} />
          : <SectionEmpty text={t('agentPerspectiveNoTools')} />}
      </SemanticSection>

      <SemanticSection
        title={t('agentPerspectiveMessages')}
        count={semantic.messages.length}
        icon={<MessageSquareText className="h-3 w-3" />}
        open
      >
        {semantic.messages.length ? semantic.messages.map((message, index) => (
          <article key={message.id} className="border-b border-ds-border-muted px-2.5 py-2 last:border-b-0">
            <div className="mb-1 flex items-center gap-1.5">
              <RoleBadge role={message.role} />
              {message.name ? <code className="text-[8px] text-ds-muted">{message.name}</code> : null}
              {message.callId ? <code className="ml-auto truncate text-[8px] text-ds-faint">{message.callId}</code> : null}
            </div>
            <ScrollablePre
              ariaLabel={`${t('agentPerspectiveMessages')} ${index + 1}`}
              className="max-h-48 whitespace-pre-wrap break-words font-sans text-[10px] leading-4 text-ds-ink"
            >
              {message.text || '—'}
            </ScrollablePre>
          </article>
        )) : <SectionEmpty text={t('agentPerspectiveNoMessages')} />}
      </SemanticSection>

      <SemanticSection
        title={t('agentPerspectiveParameters')}
        count={semantic.parameters.length}
        icon={<Braces className="h-3 w-3" />}
      >
        {semantic.parameters.length ? semantic.parameters.map((parameter) => (
          <div key={parameter.name} className="grid grid-cols-[minmax(90px,0.32fr)_minmax(0,1fr)] border-b border-ds-border-muted text-[9px] last:border-b-0">
            <code className="break-all bg-ds-surface-subtle px-2.5 py-2 text-ds-muted">{parameter.name}</code>
            <code className="min-w-0 break-words px-2.5 py-2">{formatValue(parameter.value)}</code>
          </div>
        )) : <SectionEmpty text="—" />}
      </SemanticSection>
    </div>
  )
}

function DelegatedTraceSummary({
  delegated
}: {
  delegated: ModelRequestTraceDelegated
}): ReactElement {
  const { t } = useTranslation('common')
  const capabilities: Array<{
    key: keyof ModelRequestTraceDelegated['capabilities']
    label: string
  }> = [
    { key: 'nativeResume', label: 'agentPerspectiveCapabilityNativeResume' },
    { key: 'structuredStreaming', label: 'agentPerspectiveCapabilityStructuredStreaming' },
    { key: 'kunTools', label: 'agentPerspectiveCapabilityKunTools' },
    { key: 'externalApproval', label: 'agentPerspectiveCapabilityExternalApproval' },
    { key: 'liveSteering', label: 'agentPerspectiveCapabilityLiveSteering' },
    { key: 'nativeContextTelemetry', label: 'agentPerspectiveCapabilityContextTelemetry' },
    { key: 'fork', label: 'agentPerspectiveCapabilityFork' }
  ]
  return (
    <section
      className="rounded-xl border border-violet-500/20 bg-violet-500/5 p-3"
      aria-label={t('agentPerspectiveSdkExecution')}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="flex h-6 w-6 items-center justify-center rounded-md bg-violet-500/12 text-violet-700 dark:text-violet-300">
          <Bot className="h-3.5 w-3.5" aria-hidden />
        </span>
        <span className="text-[10px] font-semibold">{t('agentPerspectiveSdkExecution')}</span>
        <span className="rounded-full border border-violet-500/20 bg-violet-500/10 px-1.5 py-0.5 text-[8px] font-medium text-violet-700 dark:text-violet-300">
          {delegatedProviderLabel(delegated.providerKind)}
        </span>
      </div>
      <dl className="mt-2 grid grid-cols-[110px_minmax(0,1fr)] gap-x-2 gap-y-1.5 text-[9px]">
        <dt className="text-ds-faint">{t('agentPerspectiveContinuity')}</dt>
        <dd className="font-medium">{t(delegatedPhaseKey(delegated.phase))}</dd>
        {delegated.reason ? (
          <>
            <dt className="text-ds-faint">{t('agentPerspectiveContinuityReason')}</dt>
            <dd className="font-medium">{t(delegatedReasonKey(delegated.reason))}</dd>
          </>
        ) : null}
        <dt className="text-ds-faint">{t('agentPerspectiveContextOwner')}</dt>
        <dd className="font-medium">{t('agentPerspectiveSdkManaged')}</dd>
        <dt className="text-ds-faint">{t('agentPerspectiveNativeHistory')}</dt>
        <dd className="font-medium">
          {t(delegated.nativeHistory === 'unknown'
            ? 'agentPerspectiveNativeHistoryUnknown'
            : delegated.nativeHistory === 'none'
              ? 'agentPerspectiveNativeHistoryNone'
              : 'agentPerspectiveNativeHistoryKnown')}
        </dd>
      </dl>
      <div className="mt-3 border-t border-violet-500/15 pt-2">
        <p className="mb-1.5 text-[8px] font-semibold uppercase tracking-wide text-ds-faint">
          {t('agentPerspectiveCapabilities')}
        </p>
        <div className="flex flex-wrap gap-1">
          {capabilities.map((capability) => {
            const supported = delegated.capabilities[capability.key]
            return (
              <span
                key={capability.key}
                className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[8px] ${
                  supported
                    ? 'border-emerald-500/20 bg-emerald-500/8 text-emerald-700 dark:text-emerald-300'
                    : 'border-ds-border-muted bg-ds-surface-subtle text-ds-faint'
                }`}
                title={t(supported
                  ? 'agentPerspectiveCapabilitySupported'
                  : 'agentPerspectiveCapabilityUnavailable')}
              >
                {supported ? <Check className="h-2.5 w-2.5" aria-hidden /> : <span aria-hidden>—</span>}
                {t(capability.label)}
              </span>
            )
          })}
        </div>
      </div>
    </section>
  )
}

function ToolCallDetail({ event }: { event: Extract<AgentPerspectiveEvent, { kind: 'tool_call' }> }): ReactElement {
  const { t } = useTranslation('common')
  return (
    <div className="space-y-3">
      <div className={`rounded-xl border p-3 ${event.result ? 'border-emerald-500/25 bg-emerald-500/5' : 'border-amber-500/25 bg-amber-500/5'}`}>
        <div className="flex items-center gap-2">
          {event.result ? <CheckCircle2 className="h-4 w-4 text-emerald-500" /> : <LoaderCircle className="h-4 w-4 text-amber-500" />}
          <div className="min-w-0">
            <h4 className="truncate font-mono text-[11px] font-semibold">{event.toolName}</h4>
            <p className="text-[9px] text-ds-muted">
              {t(event.result ? 'agentPerspectiveToolCompleted' : 'agentPerspectiveToolPending')}
            </p>
          </div>
        </div>
        <dl className="mt-3 grid grid-cols-[90px_minmax(0,1fr)] gap-y-1 text-[9px]">
          <dt className="text-ds-faint">{t('agentPerspectiveCallId')}</dt>
          <dd className="truncate font-mono">{event.callId}</dd>
          <dt className="text-ds-faint">{t('agentPerspectiveParentRequest')}</dt>
          <dd className="truncate font-mono">{event.record.id}</dd>
          <dt className="text-ds-faint">{t('agentPerspectiveToolSource')}</dt>
          <dd className="flex min-w-0 flex-wrap gap-1">
            <ToolProvenanceBadges provenance={event.provenance} />
          </dd>
        </dl>
      </div>
      <JsonCard title={t('agentPerspectiveToolArguments')} value={event.arguments} />
      {event.result ? (
        <section>
          <SectionHeading title={t('agentPerspectiveToolResult')} copyValue={event.result.text} />
          <ScrollablePre
            ariaLabel={t('agentPerspectiveToolResult')}
            className="max-h-96 whitespace-pre-wrap break-words rounded-lg border border-ds-border-muted bg-ds-surface-subtle p-2.5 font-mono text-[9px] leading-4"
          >
            {event.result.text || '—'}
          </ScrollablePre>
        </section>
      ) : <Notice text={t('agentPerspectiveToolResultPending')} />}
    </div>
  )
}

function ToolDefinitionGroups({ tools }: { tools: readonly SemanticToolDefinition[] }): ReactElement {
  const groups = groupToolsByProvenance(tools)
  return (
    <div className="space-y-2 bg-ds-surface-subtle/25 p-2">
      {groups.map((group, index) => (
        <ToolSourceDisclosure key={group.source} group={group} initiallyOpen={index === 0} />
      ))}
    </div>
  )
}

function ToolSourceDisclosure({
  group,
  initiallyOpen
}: {
  group: ToolProvenanceGroup<SemanticToolDefinition>
  initiallyOpen: boolean
}): ReactElement {
  const { t } = useTranslation('common')
  const [expanded, setExpanded] = useState(initiallyOpen)
  const Icon = sourceIcon(group.source)
  const label = sourceLabel(t, group.source)
  return (
    <details
      open={expanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
      className="group/source overflow-hidden rounded-lg border border-ds-border-muted bg-ds-card"
    >
      <summary
        aria-label={t('agentPerspectiveExpandToolSource', { source: label })}
        className="flex cursor-pointer list-none items-center gap-2 px-2.5 py-2 text-[9px] font-semibold hover:bg-ds-hover [&::-webkit-details-marker]:hidden"
      >
        <span className={sourceIconClass(group.source)}><Icon className="h-3 w-3" /></span>
        <span>{label}</span>
        <span className="rounded-full bg-ds-surface-subtle px-1.5 py-0.5 text-[8px] tabular-nums text-ds-faint">
          {group.tools.length}
        </span>
        <ChevronDown className="ml-auto h-3 w-3 text-ds-faint transition group-open/source:rotate-180" />
      </summary>
      <div className="space-y-1.5 border-t border-ds-border-muted p-1.5">
        {group.subgroups.map((subgroup, index) => (
          <ToolProviderDisclosure
            key={subgroup.id}
            subgroup={subgroup}
            initiallyOpen={index === 0}
          />
        ))}
      </div>
    </details>
  )
}

function ToolProviderDisclosure({
  subgroup,
  initiallyOpen
}: {
  subgroup: ToolProvenanceSubgroup<SemanticToolDefinition>
  initiallyOpen: boolean
}): ReactElement {
  const { t } = useTranslation('common')
  const [expanded, setExpanded] = useState(initiallyOpen)
  const label = subgroupLabel(t, subgroup)
  return (
    <details
      open={expanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
      className="group/provider overflow-hidden rounded-md border border-ds-border-muted bg-ds-surface-subtle/35"
    >
      <summary
        aria-label={t('agentPerspectiveExpandToolProvider', { provider: label })}
        className="flex cursor-pointer list-none items-center gap-1.5 px-2 py-1.5 text-[9px] hover:bg-ds-hover [&::-webkit-details-marker]:hidden"
      >
        <span className="min-w-0 flex-1 truncate font-medium">{label}</span>
        {subgroup.management ? <ManagementBadge management={subgroup.management} /> : null}
        <span className="tabular-nums text-ds-faint">{subgroup.tools.length}</span>
        <ChevronDown className="h-3 w-3 text-ds-faint transition group-open/provider:rotate-180" />
      </summary>
      <div className="divide-y divide-ds-border-muted border-t border-ds-border-muted bg-ds-card">
        {subgroup.tools.map((tool) => <ToolDefinitionDisclosure key={tool.name} tool={tool} />)}
      </div>
    </details>
  )
}

function ToolDefinitionDisclosure({ tool }: { tool: SemanticToolDefinition }): ReactElement {
  const { t } = useTranslation('common')
  const [expanded, setExpanded] = useState(false)
  const schema = tool.inputSchema ? JSON.stringify(tool.inputSchema, null, 2) : ''
  const copyValue = [tool.description, schema].filter(Boolean).join('\n\n')
  return (
    <details
      open={expanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
      className="group/tool"
    >
      <summary
        aria-label={t('agentPerspectiveExpandTool', { tool: tool.name })}
        className="cursor-pointer list-none px-2.5 py-2 hover:bg-ds-hover [&::-webkit-details-marker]:hidden"
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <code className="min-w-0 flex-1 truncate text-[9px] font-semibold text-cyan-700 dark:text-cyan-300">
            {tool.name}
          </code>
          <ToolProvenanceBadges provenance={tool.provenance} compact />
          <ChevronDown className="h-3 w-3 shrink-0 text-ds-faint transition group-open/tool:rotate-180" />
        </span>
        <span className="mt-1 block truncate text-[8px] leading-3 text-ds-muted">
          {tool.description || t('agentPerspectiveNoToolDescription')}
        </span>
      </summary>
      <div className="border-t border-ds-border-muted bg-ds-surface-subtle/30 px-2.5 py-2">
        <div className="flex items-start gap-2">
          <p className="min-w-0 flex-1 whitespace-pre-wrap text-[9px] leading-4 text-ds-muted">
            {tool.description || t('agentPerspectiveNoToolDescription')}
          </p>
          {copyValue ? <CopyButton value={copyValue} /> : null}
        </div>
        {schema ? (
          <ScrollablePre
            ariaLabel={t('agentPerspectiveToolSchema', { tool: tool.name })}
            className="mt-2 max-h-40 whitespace-pre-wrap break-words rounded-md border border-ds-border-muted bg-ds-card p-2 font-mono text-[8px] leading-3 text-ds-muted"
          >
            {schema}
          </ScrollablePre>
        ) : null}
      </div>
    </details>
  )
}

function ToolProvenanceBadges({
  provenance,
  compact = false
}: {
  provenance: ToolProvenance
  compact?: boolean
}): ReactElement {
  const { t } = useTranslation('common')
  const label = provenanceLabel(t, provenance)
  return (
    <>
      <span
        title={label}
        className={`max-w-36 truncate rounded border px-1 py-0.5 font-medium ${compact ? 'text-[7px]' : 'text-[8px]'} ${sourceBadgeClass(provenance.source)}`}
      >
        {label}
      </span>
      {provenance.management ? <ManagementBadge management={provenance.management} compact={compact} /> : null}
      {provenance.inferred ? (
        <span className={`shrink-0 rounded bg-amber-500/10 px-1 py-0.5 text-amber-700 dark:text-amber-300 ${compact ? 'text-[7px]' : 'text-[8px]'}`}>
          {t('agentPerspectiveHistoricalInference')}
        </span>
      ) : null}
    </>
  )
}

function ManagementBadge({
  management,
  compact = false
}: {
  management: ToolProvenanceManagement
  compact?: boolean
}): ReactElement {
  const { t } = useTranslation('common')
  return (
    <span className={`shrink-0 rounded bg-violet-500/10 px-1 py-0.5 text-violet-700 dark:text-violet-300 ${compact ? 'text-[7px]' : 'text-[8px]'}`}>
      {t(management === 'discovery'
        ? 'agentPerspectiveMcpDiscovery'
        : 'agentPerspectiveKunManaged')}
    </span>
  )
}

function TitleGenerationDetail({ event }: { event: Extract<AgentPerspectiveEvent, { kind: 'title_generation' }> }): ReactElement {
  const { t } = useTranslation('common')
  return (
    <div className="space-y-3">
      <section className="rounded-xl border border-amber-500/25 bg-amber-500/5 p-3">
        <div className="flex items-center gap-2 text-amber-700 dark:text-amber-300">
          <Sparkles className="h-4 w-4" />
          <h4 className="text-[10px] font-semibold">{t('agentPerspectiveGeneratedTitle')}</h4>
        </div>
        <div className="mt-2 flex items-center gap-2 rounded-lg bg-ds-card px-3 py-2 shadow-sm">
          <p className="min-w-0 flex-1 break-words text-[13px] font-semibold">{event.title || '—'}</p>
          {event.title ? <CopyButton value={event.title} /> : null}
        </div>
      </section>
      <SemanticRequestDetail semantic={event.semantic} record={event.record} compact />
    </div>
  )
}

function RawRequest({ record }: { record: ModelRequestTraceRecord }): ReactElement {
  const { t } = useTranslation('common')
  return (
    <div className="space-y-4">
      <DetailBlock title={t('agentPerspectiveUrl')} value={record.request.url} copyValue={record.request.url} mono />
      <HeadersTable headers={record.request.headers} />
      <BodyViewer body={record.request.body} title={t('agentPerspectiveBody')} />
      {record.request.urlRedacted || record.request.headers.redactedNames.length > 0 ? <RedactionNotice /> : null}
    </div>
  )
}

function ResponseDetail({ record }: { record: ModelRequestTraceRecord }): ReactElement {
  const { t } = useTranslation('common')
  if (!record.response && !record.decoded) return <EmptyState text={t('agentPerspectiveNoResponse')} />
  return (
    <div className="space-y-3">
      {record.response ? (
        <div className="flex items-center gap-2 rounded-lg border border-ds-border-muted bg-ds-surface-subtle px-2.5 py-2 text-[10px]">
          <StatusDot record={record} />
          <span className="font-semibold">HTTP {record.response.status}</span>
          <span className="text-ds-muted">{record.response.statusText}</span>
        </div>
      ) : null}
      {record.decoded?.text ? <TextCard title={t('agentPerspectiveResponseOutput')} value={record.decoded.text} /> : null}
      {record.decoded?.reasoning ? <TextCard title={t('agentPerspectiveReasoningOutput')} value={record.decoded.reasoning} /> : null}
      {record.decoded?.toolCalls.length ? <JsonCard title={t('agentPerspectiveToolCalls')} value={record.decoded.toolCalls} /> : null}
      {record.decoded?.usage ? <JsonCard title={t('agentPerspectiveUsage')} value={record.decoded.usage} /> : null}
      {record.decoded?.error ? <Notice text={record.decoded.error} warning /> : null}
      {record.response ? <HeadersTable headers={record.response.headers} /> : null}
      {!record.decoded?.text && !record.decoded?.reasoning && !record.decoded?.toolCalls.length && !record.decoded?.usage ? (
        <EmptyState text={t('agentPerspectiveNoDecoded')} />
      ) : null}
    </div>
  )
}

function StreamDetail({ record }: { record: ModelRequestTraceRecord }): ReactElement {
  const { t } = useTranslation('common')
  if (!record.response?.body) return <EmptyState text={record.response?.captureError || t('agentPerspectiveNoResponse')} />
  return (
    <div className="space-y-3">
      <BodyViewer body={record.response.body} title={t('agentPerspectiveRawResponse')} />
      {record.response.body.truncated ? <TruncationNotice /> : null}
    </div>
  )
}

function TimingDetail({ record }: { record: ModelRequestTraceRecord }): ReactElement {
  const { t } = useTranslation('common')
  const rows: Array<[string, string]> = [
    [t('agentPerspectiveStatus'), statusLabel(t, record)],
    [t('agentPerspectiveAttempt'), `${record.attempt} · ${attemptLabel(t, record.attemptReason)}`],
    [t('agentPerspectiveStartedAt'), formatTimestamp(record.startedAt, true)]
  ]
  if (record.responseStartedAt) rows.push([t('agentPerspectiveResponseStartedAt'), formatTimestamp(record.responseStartedAt, true)])
  if (record.finishedAt) rows.push([t('agentPerspectiveFinishedAt'), formatTimestamp(record.finishedAt, true)])
  if (record.timeToHeadersMs !== undefined) rows.push([t('agentPerspectiveTimeToHeaders'), `${Math.round(record.timeToHeadersMs)} ms`])
  if (record.durationMs !== undefined) rows.push([t('agentPerspectiveDuration'), `${Math.round(record.durationMs)} ms`])
  return (
    <div className="space-y-3">
      <dl className="overflow-hidden rounded-lg border border-ds-border-muted">
        {rows.map(([label, value]) => (
          <div key={label} className="grid grid-cols-[minmax(110px,0.34fr)_minmax(0,1fr)] border-b border-ds-border-muted last:border-b-0">
            <dt className="bg-ds-surface-subtle px-2.5 py-2 text-[9px] font-medium text-ds-muted">{label}</dt>
            <dd className="min-w-0 break-words px-2.5 py-2 text-[9px]">{value}</dd>
          </div>
        ))}
      </dl>
      {record.error ? <Notice text={record.error} warning /> : null}
      {record.captureWarnings?.map((warning) => <Notice key={warning} text={warning} warning />)}
      {record.request.body.truncated || record.response?.body?.truncated ? <TruncationNotice /> : null}
    </div>
  )
}

function CompositionBar({ items }: { items: Array<{ label: string; value: number; color: string }> }): ReactElement {
  const { t } = useTranslation('common')
  const total = items.reduce((sum, item) => sum + item.value, 0)
  return (
    <section className="rounded-xl border border-ds-border-muted bg-ds-card p-3">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-[9px] font-semibold uppercase tracking-wide text-ds-muted">{t('agentPerspectiveRequestComposition')}</h4>
        <span className="text-[8px] tabular-nums text-ds-faint">≈ {total.toLocaleString()} tokens</span>
      </div>
      <div className="mt-2 flex h-2 overflow-hidden rounded-full bg-ds-surface-subtle">
        {items.filter((item) => item.value > 0).map((item) => (
          <span key={item.label} className={item.color} style={{ width: `${Math.max(2, item.value / Math.max(1, total) * 100)}%` }} />
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[8px] text-ds-muted">
        {items.map((item) => (
          <span key={item.label} className="flex items-center gap-1">
            <span className={`h-1.5 w-1.5 rounded-full ${item.color}`} />
            {item.label} <span className="tabular-nums text-ds-faint">≈{item.value}</span>
          </span>
        ))}
      </div>
    </section>
  )
}

function SummaryComposition({ items }: { items: Array<{ label: string; value: number; color: string }> }): ReactElement {
  const { t } = useTranslation('common')
  const total = items.reduce((sum, item) => sum + item.value, 0)
  return (
    <section>
      <h4 className="text-[9px] font-semibold uppercase tracking-wide text-ds-muted">
        {t('agentPerspectiveRequestComposition')}
      </h4>
      <div className="mt-2 flex h-1.5 overflow-hidden rounded-full bg-ds-surface-subtle">
        {items.filter((item) => item.value > 0).map((item) => (
          <span
            key={item.label}
            className={item.color}
            style={{ width: `${Math.max(2, item.value / Math.max(1, total) * 100)}%` }}
          />
        ))}
      </div>
      <p className="mt-2 truncate text-[8px] text-ds-faint">
        {items.map((item) => `${item.label} ${Math.round(item.value / Math.max(1, total) * 100)}%`).join(' · ')}
      </p>
    </section>
  )
}

function SemanticSection({
  title,
  count,
  icon,
  open = false,
  children
}: {
  title: string
  count: number
  icon: ReactNode
  open?: boolean
  children: ReactNode
}): ReactElement {
  const [expanded, setExpanded] = useState(open)
  return (
    <details
      open={expanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
      className="group overflow-hidden rounded-xl border border-ds-border-muted bg-ds-card"
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 px-2.5 py-2 text-[10px] font-semibold hover:bg-ds-hover [&::-webkit-details-marker]:hidden">
        <span className="text-ds-muted">{icon}</span>
        <span>{title}</span>
        <span className="rounded-full bg-ds-surface-subtle px-1.5 py-0.5 text-[8px] font-medium text-ds-faint">{count}</span>
        <ChevronDown className="ml-auto h-3 w-3 text-ds-faint transition group-open:rotate-180" />
      </summary>
      <div className="border-t border-ds-border-muted">{children}</div>
    </details>
  )
}

function SectionEmpty({ text }: { text: string }): ReactElement {
  return <div className="px-2.5 py-3 text-center text-[9px] text-ds-faint">{text}</div>
}

function ScrollablePre({
  ariaLabel,
  className,
  children
}: {
  ariaLabel: string
  className: string
  children: ReactNode
}): ReactElement {
  return (
    <pre
      tabIndex={0}
      aria-label={ariaLabel}
      className={`overflow-auto outline-none focus-visible:ring-1 focus-visible:ring-accent/50 ${className}`}
    >
      {children}
    </pre>
  )
}

function MetaChip({ children }: { children: ReactNode }): ReactElement {
  return <span className="max-w-48 truncate rounded-md border border-ds-border-muted bg-ds-surface-subtle px-1.5 py-0.5 text-ds-muted">{children}</span>
}

function StatusBadge({ record }: { record: ModelRequestTraceRecord }): ReactElement {
  const { t } = useTranslation('common')
  const failed = requestFailed(record)
  const pending = record.status === 'pending'
  return (
    <span className={`rounded-full px-1.5 py-0.5 text-[8px] font-medium ${
      failed
        ? 'bg-red-500/10 text-red-600 dark:text-red-300'
        : pending
          ? 'bg-amber-500/10 text-amber-700 dark:text-amber-300'
          : 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
    }`}>
      {failed ? t('agentPerspectiveTransportError') : pending ? t('agentPerspectivePending') : `HTTP ${record.response?.status ?? '200'}`}
    </span>
  )
}

function StatusDot({ record }: { record: ModelRequestTraceRecord }): ReactElement {
  const failed = requestFailed(record)
  const pending = record.status === 'pending'
  return <span className={`ml-auto h-1.5 w-1.5 shrink-0 rounded-full ${failed ? 'bg-red-500' : pending ? 'animate-pulse bg-amber-500' : 'bg-emerald-500'}`} />
}

function RoleBadge({ role }: { role: string }): ReactElement {
  const className = role === 'user'
    ? 'bg-blue-500/10 text-blue-700 dark:text-blue-300'
    : role === 'assistant'
      ? 'bg-violet-500/10 text-violet-700 dark:text-violet-300'
      : role === 'tool'
        ? 'bg-cyan-500/10 text-cyan-700 dark:text-cyan-300'
        : 'bg-ds-surface-subtle text-ds-muted'
  return <span className={`rounded px-1.5 py-0.5 text-[8px] font-semibold uppercase ${className}`}>{role}</span>
}

function EmptyState({
  text,
  spinning = false,
  warning = false
}: {
  text: string
  spinning?: boolean
  warning?: boolean
}): ReactElement {
  const Icon = warning ? AlertTriangle : spinning ? RefreshCw : ScanSearch
  return (
    <div className="flex h-full min-h-40 flex-col items-center justify-center gap-2 px-6 text-center text-[11px] text-ds-muted">
      <Icon className={`h-5 w-5 ${spinning ? 'animate-spin' : ''}`} aria-hidden />
      <p className="max-w-72 leading-5">{text}</p>
    </div>
  )
}

function HeadersTable({ headers }: { headers: ModelRequestTraceHeaders }): ReactElement {
  const { t } = useTranslation('common')
  const entries = Object.entries(headers.values)
  return (
    <section>
      <SectionHeading title={t('agentPerspectiveHeaders')} copyValue={JSON.stringify(headers.values, null, 2)} />
      <div className="overflow-hidden rounded-lg border border-ds-border-muted">
        {entries.length === 0 ? (
          <div className="px-2.5 py-2 text-[10px] text-ds-faint">—</div>
        ) : entries.map(([name, value]) => (
          <div key={name} className="grid grid-cols-[minmax(100px,0.34fr)_minmax(0,1fr)] border-b border-ds-border-muted font-mono text-[9px] last:border-b-0">
            <div className="break-all bg-ds-surface-subtle px-2.5 py-2 text-ds-muted">{name}</div>
            <div className="min-w-0 break-all px-2.5 py-2">{value}</div>
          </div>
        ))}
      </div>
    </section>
  )
}

function BodyViewer({
  body,
  title
}: {
  body: ModelRequestTraceBody
  title: string
}): ReactElement {
  const { t } = useTranslation('common')
  const pretty = useMemo(() => prettyJson(body.text), [body.text])
  const [mode, setMode] = useState<BodyMode>(pretty !== null ? 'pretty' : 'raw')
  const value = mode === 'pretty' && pretty !== null ? pretty : body.text
  return (
    <section>
      <div className="mb-1.5 flex items-center gap-1">
        <h3 className="mr-auto text-[9px] font-semibold uppercase tracking-wide text-ds-muted">{title}</h3>
        {pretty !== null ? (
          <div className="flex rounded-md bg-ds-surface-subtle p-0.5 text-[8px]">
            {(['pretty', 'raw'] as const).map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => setMode(item)}
                className={`rounded px-1.5 py-0.5 ${mode === item ? 'bg-ds-card text-ds-ink shadow-sm' : 'text-ds-muted'}`}
              >
                {t(item === 'pretty' ? 'agentPerspectivePretty' : 'agentPerspectiveRaw')}
              </button>
            ))}
          </div>
        ) : null}
        <CopyButton value={value} />
      </div>
      <textarea
        readOnly
        value={value}
        spellCheck={false}
        aria-label={title}
        className="h-72 w-full resize-y rounded-lg border border-ds-border-muted bg-ds-surface-subtle p-2.5 font-mono text-[9px] leading-4 text-ds-ink outline-none"
      />
      <div className="mt-1 flex items-center justify-between text-[8px] text-ds-faint">
        <span>{body.capturedBytes.toLocaleString()} / {body.originalBytes.toLocaleString()} B</span>
        {body.truncated ? <span>{t('agentPerspectiveTruncated')}</span> : null}
      </div>
    </section>
  )
}

function JsonCard({ title, value }: { title: string; value: unknown }): ReactElement {
  const text = JSON.stringify(value, null, 2)
  return (
    <section>
      <SectionHeading title={title} copyValue={text} />
      <ScrollablePre
        ariaLabel={title}
        className="max-h-96 whitespace-pre-wrap break-words rounded-lg border border-ds-border-muted bg-ds-surface-subtle p-2.5 font-mono text-[9px] leading-4"
      >
        {text}
      </ScrollablePre>
    </section>
  )
}

function TextCard({ title, value }: { title: string; value: string }): ReactElement {
  return (
    <section>
      <SectionHeading title={title} copyValue={value} />
      <ScrollablePre
        ariaLabel={title}
        className="max-h-96 whitespace-pre-wrap break-words rounded-lg border border-ds-border-muted bg-ds-surface-subtle p-2.5 font-sans text-[10px] leading-4"
      >
        {value}
      </ScrollablePre>
    </section>
  )
}

function SectionHeading({ title, copyValue }: { title: string; copyValue?: string }): ReactElement {
  return (
    <div className="mb-1.5 flex items-center justify-between">
      <h3 className="text-[9px] font-semibold uppercase tracking-wide text-ds-muted">{title}</h3>
      {copyValue ? <CopyButton value={copyValue} /> : null}
    </div>
  )
}

function DetailBlock({
  title,
  value,
  copyValue,
  mono = false
}: {
  title: string
  value: string
  copyValue?: string
  mono?: boolean
}): ReactElement {
  return (
    <section>
      <SectionHeading title={title} copyValue={copyValue} />
      <div className={`break-all rounded-lg border border-ds-border-muted bg-ds-surface-subtle px-2.5 py-2 text-[9px] ${mono ? 'font-mono' : ''}`}>
        {value}
      </div>
    </section>
  )
}

function CopyButton({ value }: { value: string }): ReactElement {
  const { t } = useTranslation('common')
  const [copied, setCopied] = useState(false)
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1_200)
    } catch {
      setCopied(false)
    }
  }
  const Icon = copied ? Check : Clipboard
  return (
    <button
      type="button"
      onClick={() => void copy()}
      className="rounded p-1 text-ds-muted transition hover:bg-ds-hover hover:text-ds-ink"
      aria-label={t(copied ? 'agentPerspectiveCopied' : 'agentPerspectiveCopy')}
      data-tooltip={t(copied ? 'agentPerspectiveCopied' : 'agentPerspectiveCopy')}
    >
      <Icon className="h-3 w-3" />
    </button>
  )
}

function Notice({ text, warning = false }: { text: string; warning?: boolean }): ReactElement {
  return (
    <div className={`flex gap-2 rounded-lg border px-2.5 py-2 text-[9px] leading-4 ${warning ? 'border-amber-500/25 bg-amber-500/8 text-amber-700 dark:text-amber-300' : 'border-ds-border-muted bg-ds-surface-subtle text-ds-muted'}`}>
      {warning ? <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" /> : null}
      <span>{text}</span>
    </div>
  )
}

function RedactionNotice(): ReactElement {
  const { t } = useTranslation('common')
  return <Notice text={t('agentPerspectiveRedacted')} />
}

function TruncationNotice(): ReactElement {
  const { t } = useTranslation('common')
  return <Notice text={t('agentPerspectiveTruncationNotice')} warning />
}

function sourceLabel(t: TFunction, source: ToolProvenanceSource): string {
  if (source === 'kun') return t('agentPerspectiveSourceKun')
  if (source === 'mcp') return t('agentPerspectiveSourceMcp')
  if (source === 'extension') return t('agentPerspectiveSourceExtension')
  return t('agentPerspectiveSourceUnclassified')
}

function categoryLabel(t: TFunction, category: ToolProvenanceCategory): string {
  if (category === 'kun-core') return t('agentPerspectiveKunCore')
  if (category === 'kun-gui') return t('agentPerspectiveKunGui')
  if (category === 'kun-runtime') return t('agentPerspectiveKunRuntime')
  return t('agentPerspectiveSourceUnclassified')
}

function subgroupLabel(
  t: TFunction,
  subgroup: ToolProvenanceSubgroup<SemanticToolDefinition>
): string {
  if (subgroup.category === 'mcp-server') {
    return `${t('agentPerspectiveMcpServer')} · ${subgroup.providerName || t('agentPerspectiveProviderUnknown')}`
  }
  if (subgroup.category === 'extension-provider') {
    return `${t('agentPerspectiveExtensionProvider')} · ${subgroup.providerName || t('agentPerspectiveProviderUnknown')}`
  }
  return categoryLabel(t, subgroup.category)
}

function provenanceLabel(t: TFunction, provenance: ToolProvenance): string {
  if (provenance.source === 'kun') return categoryLabel(t, provenance.category)
  if (provenance.source === 'mcp') {
    return `${t('agentPerspectiveSourceMcp')} · ${provenance.providerName || t('agentPerspectiveProviderUnknown')}`
  }
  if (provenance.source === 'extension') {
    return `${t('agentPerspectiveSourceExtension')} · ${provenance.providerName || t('agentPerspectiveProviderUnknown')}`
  }
  const detail = provenance.providerName || provenance.providerKind
  return detail
    ? `${t('agentPerspectiveSourceUnclassified')} · ${detail}`
    : t('agentPerspectiveSourceUnclassified')
}

function sourceIcon(source: ToolProvenanceSource): typeof Bot {
  if (source === 'mcp') return ScanSearch
  if (source === 'extension') return Puzzle
  if (source === 'unclassified') return AlertTriangle
  return Bot
}

function sourceIconClass(source: ToolProvenanceSource): string {
  return `flex h-5 w-5 items-center justify-center rounded-md ${
    source === 'kun'
      ? 'bg-blue-500/10 text-blue-700 dark:text-blue-300'
      : source === 'mcp'
        ? 'bg-violet-500/10 text-violet-700 dark:text-violet-300'
        : source === 'extension'
          ? 'bg-amber-500/10 text-amber-700 dark:text-amber-300'
          : 'bg-ds-surface-subtle text-ds-muted'
  }`
}

function sourceBadgeClass(source: ToolProvenanceSource): string {
  if (source === 'kun') return 'border-blue-500/20 bg-blue-500/8 text-blue-700 dark:text-blue-300'
  if (source === 'mcp') return 'border-violet-500/20 bg-violet-500/8 text-violet-700 dark:text-violet-300'
  if (source === 'extension') return 'border-amber-500/20 bg-amber-500/8 text-amber-700 dark:text-amber-300'
  return 'border-ds-border-muted bg-ds-surface-subtle text-ds-muted'
}

function eventStyle(kind: AgentPerspectiveEventKind): {
  Icon: typeof Bot
  label: string
  iconClass: string
  textClass: string
} {
  if (kind === 'tool_call') return {
    Icon: Hammer,
    label: 'agentPerspectiveToolCall',
    iconClass: 'bg-cyan-500/12 text-cyan-700 dark:text-cyan-300',
    textClass: 'text-cyan-700 dark:text-cyan-300'
  }
  if (kind === 'title_generation') return {
    Icon: Sparkles,
    label: 'agentPerspectiveTitleGeneration',
    iconClass: 'bg-amber-500/12 text-amber-700 dark:text-amber-300',
    textClass: 'text-amber-700 dark:text-amber-300'
  }
  return {
    Icon: Bot,
    label: 'agentPerspectiveLlmRequest',
    iconClass: 'bg-blue-500/12 text-blue-700 dark:text-blue-300',
    textClass: 'text-blue-700 dark:text-blue-300'
  }
}

function eventSubtitle(event: AgentPerspectiveEvent): string {
  if (event.kind === 'tool_call') return event.toolName
  if (event.kind === 'title_generation') return event.title || event.record.model
  return event.record.model
}

function eventSearchText(event: AgentPerspectiveEvent): string {
  if (event.kind === 'tool_call') {
    return `${event.kind} ${event.toolName} ${event.callId} ${event.provenance.providerKind ?? ''} ${event.provenance.providerId ?? ''} ${JSON.stringify(event.arguments)}`
  }
  const delegated = event.record.delegated
  return [
    event.kind,
    event.record.model,
    event.record.provider,
    event.kind === 'title_generation' ? event.title : '',
    delegated?.providerKind ?? '',
    delegated?.phase ?? '',
    delegated?.reason ?? ''
  ].join(' ')
}

function delegatedProviderLabel(
  providerKind: ModelRequestTraceDelegated['providerKind']
): string {
  if (providerKind === 'agent-sdk') return 'Claude Agent SDK'
  if (providerKind === 'cursor-sdk') return 'Cursor Agent SDK'
  return 'Google Antigravity CLI'
}

function delegatedPhaseKey(
  phase: ModelRequestTraceDelegated['phase']
): string {
  if (phase === 'resumed') return 'agentPerspectivePhaseResumed'
  if (phase === 'portable') return 'agentPerspectivePhasePortable'
  return 'agentPerspectivePhaseRebased'
}

function delegatedReasonKey(
  reason: NonNullable<ModelRequestTraceDelegated['reason']>
): string {
  if (reason === 'route_changed') return 'agentPerspectiveReasonRouteChanged'
  if (reason === 'capabilities_changed') return 'agentPerspectiveReasonCapabilitiesChanged'
  if (reason === 'history_changed') return 'agentPerspectiveReasonHistoryChanged'
  if (reason === 'native_state_unavailable') {
    return 'agentPerspectiveReasonNativeStateUnavailable'
  }
  return 'agentPerspectiveReasonNew'
}

function requestComposition(
  semantic: SemanticRequest,
  record: ModelRequestTraceRecord
): Array<{ label: string; value: number; color: string }> {
  const { prompts, skills, tools, messages } = semantic
  const weights = [
    Math.max(1, prompts.reduce((sum, prompt) => sum + prompt.text.length, 0)),
    Math.max(0, skills.reduce((sum, skill) => sum + skill.name.length + skill.description.length, 0)),
    Math.max(0, tools.reduce((sum, tool) => sum + tool.name.length + tool.description.length + JSON.stringify(tool.inputSchema ?? {}).length, 0)),
    Math.max(0, messages.reduce((sum, message) => sum + message.text.length, 0))
  ]
  const weightTotal = weights.reduce((sum, value) => sum + value, 0)
  const reported = usageNumber(record.decoded?.usage, 'promptTokens')
  const tokenTotal = reported ?? Math.max(1, Math.round(weightTotal / 4))
  const values = weights.map((weight) => Math.round(tokenTotal * weight / Math.max(1, weightTotal)))
  const labels = ['System', 'Skills', 'Tools', 'Messages']
  const colors = ['bg-blue-500', 'bg-violet-500', 'bg-cyan-500', 'bg-emerald-500']
  return labels.map((label, index) => ({ label, value: values[index] ?? 0, color: colors[index] ?? 'bg-ds-muted' }))
}

function requestFailed(record: ModelRequestTraceRecord): boolean {
  const status = record.response?.status
  return record.status === 'transport_error' ||
    record.status === 'capture_error' ||
    Boolean(record.decoded?.error) ||
    (status !== undefined && status >= 400)
}

function prettyJson(value: string): string | null {
  try {
    return JSON.stringify(JSON.parse(value), null, 2)
  } catch {
    return null
  }
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function formatTimestamp(value: string, full = false): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat(undefined, full
    ? { dateStyle: 'medium', timeStyle: 'medium' }
    : { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(date)
}

function formatMilliseconds(value: number): string {
  if (value < 1_000) return `${Math.round(value)} ms`
  return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)} s`
}

function attemptLabel(
  t: (key: string) => string,
  reason: ModelRequestTraceRecord['attemptReason']
): string {
  if (reason === 'transport_retry') return t('agentPerspectiveTransportRetry')
  if (reason === 'stream_options_fallback') return t('agentPerspectiveStreamFallback')
  return t('agentPerspectiveInitial')
}

function statusLabel(t: (key: string) => string, record: ModelRequestTraceRecord): string {
  if (record.status === 'pending') return t('agentPerspectivePending')
  if (record.status === 'transport_error') return t('agentPerspectiveTransportError')
  if (record.status === 'capture_error') return t('agentPerspectiveCaptureError')
  if (record.decoded?.error) return t('agentPerspectiveModelError')
  return `${t('agentPerspectiveCompleted')}${record.response ? ` · HTTP ${record.response.status}` : ''}`
}
