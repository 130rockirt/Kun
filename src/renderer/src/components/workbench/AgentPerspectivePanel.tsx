import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react'
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
import { kunThreadPath } from '@shared/kun-endpoints'
import { parseRuntimeErrorBody, runtimeErrorToError } from '@shared/runtime-error'
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
  ModelRequestTraceFailureOrigin,
  ModelRequestTraceHeaders,
  ModelRequestTraceRecord
} from '../../agent/model-request-traces'
import { AgentPerspectiveRoundList } from './AgentPerspectiveRoundList'
import { useModelRequestTraces } from './useModelRequestTraces'
import { EmptyState } from './AgentPerspectiveTraceViews'

import { EventDetail, EventHero } from './AgentPerspectiveEventDetail'
import { eventSearchText, requestFailed } from './agent-perspective-support'
import type { DetailSection, EventFilter } from './agent-perspective-types'

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
  const [captureEnabled, setCaptureEnabled] = useState<boolean | null>(null)
  const [captureUpdating, setCaptureUpdating] = useState(false)
  const [captureError, setCaptureError] = useState<string | null>(null)
  const captureGeneration = useRef(0)

  useEffect(() => {
    captureGeneration.current += 1
    const generation = captureGeneration.current
    setCaptureEnabled(null)
    setCaptureUpdating(false)
    setCaptureError(null)
    if (!threadId || !active) return
    void window.kunGui.runtimeRequest(kunThreadPath(threadId), 'GET')
      .then((response) => {
        if (generation !== captureGeneration.current) return
        if (!response.ok) {
          throw runtimeErrorToError(parseRuntimeErrorBody(
            response.body,
            'failed to load Agent Perspective capture state'
          ))
        }
        const thread = JSON.parse(response.body) as { modelRequestCaptureEnabled?: boolean }
        setCaptureEnabled(thread.modelRequestCaptureEnabled === true)
      })
      .catch((error) => {
        if (generation !== captureGeneration.current) return
        setCaptureEnabled(false)
        setCaptureError(error instanceof Error ? error.message : String(error))
      })
  }, [active, threadId])

  const toggleCapture = useCallback(async (): Promise<void> => {
    if (!threadId || captureEnabled === null || captureUpdating) return
    const generation = captureGeneration.current
    const previous = captureEnabled
    const next = !previous
    setCaptureEnabled(next)
    setCaptureUpdating(true)
    setCaptureError(null)
    try {
      const response = await window.kunGui.runtimeRequest(
        kunThreadPath(threadId),
        'PATCH',
        JSON.stringify({ modelRequestCaptureEnabled: next })
      )
      if (!response.ok) {
        throw runtimeErrorToError(parseRuntimeErrorBody(
          response.body,
          'failed to update Agent Perspective capture state'
        ))
      }
      const thread = JSON.parse(response.body) as { modelRequestCaptureEnabled?: boolean }
      if (generation === captureGeneration.current) {
        setCaptureEnabled(thread.modelRequestCaptureEnabled === true)
      }
    } catch (error) {
      if (generation === captureGeneration.current) {
        setCaptureEnabled(previous)
        setCaptureError(error instanceof Error ? error.message : String(error))
      }
    } finally {
      if (generation === captureGeneration.current) setCaptureUpdating(false)
    }
  }, [captureEnabled, captureUpdating, threadId])

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
            role="switch"
            aria-checked={captureEnabled === true}
            aria-label={t('agentPerspectiveCaptureToggle')}
            title={t(captureEnabled ? 'agentPerspectiveCaptureOnHint' : 'agentPerspectiveCaptureOffHint')}
            disabled={!threadId || captureEnabled === null || captureUpdating}
            onClick={() => void toggleCapture()}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-[9px] font-medium text-ds-muted transition hover:bg-ds-hover hover:text-ds-ink disabled:opacity-45"
          >
            <span>{t('agentPerspectiveCapture')}</span>
            <span
              className={`relative h-4 w-7 rounded-full transition ${
                captureEnabled ? 'bg-accent' : 'bg-ds-border'
              }`}
              aria-hidden
            >
              <span
                className={`absolute left-0 top-0.5 h-3 w-3 rounded-full bg-white shadow-sm transition-transform ${
                  captureEnabled ? 'translate-x-3.5' : 'translate-x-0.5'
                }`}
              />
            </span>
          </button>
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
        {captureError ? (
          <p role="alert" className="mt-1.5 truncate text-[9px] text-ds-danger" title={captureError}>
            {t('agentPerspectiveCaptureError', { error: captureError })}
          </p>
        ) : null}
      </header>

      {!threadId ? (
        <EmptyState text={t('agentPerspectiveUnsupported')} />
      ) : traces.loading && traces.records.length === 0 ? (
        <EmptyState text={t('agentPerspectiveLoading')} spinning />
      ) : traces.error && traces.records.length === 0 ? (
        <EmptyState text={t('agentPerspectiveLoadError', { error: traces.error })} warning />
      ) : traces.records.length === 0 ? (
        <EmptyState text={t(captureEnabled === false
          ? 'agentPerspectiveCaptureDisabledEmpty'
          : 'agentPerspectiveEmpty')} />
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
