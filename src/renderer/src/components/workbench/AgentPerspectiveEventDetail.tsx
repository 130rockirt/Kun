import { useState, type ReactElement } from 'react'
import {
  Bot,
  Braces,
  Check,
  CheckCircle2,
  ChevronDown,
  FileText,
  LoaderCircle,
  MessageSquareText,
  Sparkles
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  usageNumber,
  type AgentPerspectiveEvent,
  type SemanticRequest,
  type SemanticToolDefinition
} from '../../agent/agent-perspective-events'
import {
  groupToolsByProvenance,
  type ToolProvenance,
  type ToolProvenanceGroup,
  type ToolProvenanceManagement,
  type ToolProvenanceSubgroup
} from '../../agent/agent-tool-provenance'
import type { ModelRequestTraceDelegated, ModelRequestTraceRecord } from '../../agent/model-request-traces'
import {
  CompositionBar,
  CopyButton,
  JsonCard,
  MetaChip,
  Notice,
  RawRequest,
  ResponseDetail,
  RoleBadge,
  ScrollablePre,
  SectionEmpty,
  SectionHeading,
  SemanticSection,
  StatusBadge,
  StreamDetail,
  SummaryComposition,
  TimingDetail
} from './AgentPerspectiveTraceViews'
import {
  delegatedPhaseKey,
  delegatedProviderLabel,
  delegatedReasonKey,
  eventStyle,
  eventSubtitle,
  formatMilliseconds,
  formatTimestamp,
  formatValue,
  provenanceLabel,
  requestComposition,
  sourceBadgeClass,
  sourceIcon,
  sourceIconClass,
  sourceLabel,
  statusLabel,
  subgroupLabel
} from './agent-perspective-support'
import type { DetailSection } from './agent-perspective-types'

export function EventHero({ event }: { event: AgentPerspectiveEvent }): ReactElement {
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

export function EventDetail({ event, section }: { event: AgentPerspectiveEvent; section: DetailSection }): ReactElement {
  if (section === 'summary') return <EventSummary event={event} />
  if (section === 'output') return <ResponseDetail record={event.record} />
  if (section === 'technical') return <TechnicalDetail record={event.record} />
  if (event.kind === 'tool_call') return <ToolCallDetail event={event} />
  if (event.kind === 'title_generation') {
    return <SemanticRequestDetail semantic={event.semantic} record={event.record} />
  }
  return <SemanticRequestDetail semantic={event.semantic} record={event.record} />
}

export function EventSummary({ event }: { event: AgentPerspectiveEvent }): ReactElement {
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

export function TechnicalDetail({ record }: { record: ModelRequestTraceRecord }): ReactElement {
  return (
    <div className="space-y-5">
      <TimingDetail record={record} />
      <RawRequest record={record} />
      <StreamDetail record={record} />
    </div>
  )
}

export function SemanticRequestDetail({
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

export function DelegatedTraceSummary({
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
                key={String(capability.key)}
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

export function ToolCallDetail({ event }: { event: Extract<AgentPerspectiveEvent, { kind: 'tool_call' }> }): ReactElement {
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

export function ToolDefinitionGroups({ tools }: { tools: readonly SemanticToolDefinition[] }): ReactElement {
  const groups = groupToolsByProvenance(tools)
  return (
    <div className="space-y-2 bg-ds-surface-subtle/25 p-2">
      {groups.map((group, index) => (
        <ToolSourceDisclosure key={group.source} group={group} initiallyOpen={index === 0} />
      ))}
    </div>
  )
}

export function ToolSourceDisclosure({
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

export function ToolProviderDisclosure({
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

export function ToolDefinitionDisclosure({ tool }: { tool: SemanticToolDefinition }): ReactElement {
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

export function ToolProvenanceBadges({
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

export function ManagementBadge({
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

export function TitleGenerationDetail({ event }: { event: Extract<AgentPerspectiveEvent, { kind: 'title_generation' }> }): ReactElement {
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
