import {
  AlertTriangle,
  Bot,
  Hammer,
  Puzzle,
  ScanSearch,
  Sparkles
} from 'lucide-react'
import type { TFunction } from 'i18next'
import {
  usageNumber,
  type AgentPerspectiveEvent,
  type AgentPerspectiveEventKind,
  type SemanticRequest,
  type SemanticToolDefinition
} from '../../agent/agent-perspective-events'
import type {
  ToolProvenance,
  ToolProvenanceCategory,
  ToolProvenanceSource,
  ToolProvenanceSubgroup
} from '../../agent/agent-tool-provenance'
import type {
  ModelRequestTraceDelegated,
  ModelRequestTraceFailureOrigin,
  ModelRequestTraceRecord
} from '../../agent/model-request-traces'

export function sourceLabel(t: TFunction, source: ToolProvenanceSource): string {
  if (source === 'kun') return t('agentPerspectiveSourceKun')
  if (source === 'mcp') return t('agentPerspectiveSourceMcp')
  if (source === 'extension') return t('agentPerspectiveSourceExtension')
  return t('agentPerspectiveSourceUnclassified')
}

export function categoryLabel(t: TFunction, category: ToolProvenanceCategory): string {
  if (category === 'kun-core') return t('agentPerspectiveKunCore')
  if (category === 'kun-gui') return t('agentPerspectiveKunGui')
  if (category === 'kun-runtime') return t('agentPerspectiveKunRuntime')
  return t('agentPerspectiveSourceUnclassified')
}

export function subgroupLabel(
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

export function provenanceLabel(t: TFunction, provenance: ToolProvenance): string {
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

export function sourceIcon(source: ToolProvenanceSource): typeof Bot {
  if (source === 'mcp') return ScanSearch
  if (source === 'extension') return Puzzle
  if (source === 'unclassified') return AlertTriangle
  return Bot
}

export function sourceIconClass(source: ToolProvenanceSource): string {
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

export function sourceBadgeClass(source: ToolProvenanceSource): string {
  if (source === 'kun') return 'border-blue-500/20 bg-blue-500/8 text-blue-700 dark:text-blue-300'
  if (source === 'mcp') return 'border-violet-500/20 bg-violet-500/8 text-violet-700 dark:text-violet-300'
  if (source === 'extension') return 'border-amber-500/20 bg-amber-500/8 text-amber-700 dark:text-amber-300'
  return 'border-ds-border-muted bg-ds-surface-subtle text-ds-muted'
}

export function eventStyle(kind: AgentPerspectiveEventKind): {
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

export function eventSubtitle(event: AgentPerspectiveEvent): string {
  if (event.kind === 'tool_call') return event.toolName
  if (event.kind === 'title_generation') return event.title || event.record.model
  return event.record.model
}

export function eventSearchText(event: AgentPerspectiveEvent): string {
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

export function delegatedProviderLabel(
  providerKind: ModelRequestTraceDelegated['providerKind']
): string {
  if (providerKind === 'agent-sdk') return 'Claude Agent SDK'
  if (providerKind === 'cursor-sdk') return 'Cursor Agent SDK'
  return 'Google Antigravity CLI'
}

export function delegatedPhaseKey(
  phase: ModelRequestTraceDelegated['phase']
): string {
  if (phase === 'resumed') return 'agentPerspectivePhaseResumed'
  if (phase === 'portable') return 'agentPerspectivePhasePortable'
  return 'agentPerspectivePhaseRebased'
}

export function delegatedReasonKey(
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

export function requestComposition(
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

export function requestFailed(record: ModelRequestTraceRecord): boolean {
  const status = record.response?.status
  return record.status === 'transport_error' ||
    record.status === 'capture_error' ||
    Boolean(record.decoded?.error) ||
    (status !== undefined && status >= 400)
}

export function prettyJson(value: string): string | null {
  try {
    return JSON.stringify(JSON.parse(value), null, 2)
  } catch {
    return null
  }
}

export function formatValue(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export function formatTimestamp(value: string, full = false): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat(undefined, full
    ? { dateStyle: 'medium', timeStyle: 'medium' }
    : { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(date)
}

export function formatMilliseconds(value: number): string {
  if (value < 1_000) return `${Math.round(value)} ms`
  return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)} s`
}

export function attemptLabel(
  t: (key: string) => string,
  reason: ModelRequestTraceRecord['attemptReason']
): string {
  if (reason === 'transport_retry') return t('agentPerspectiveTransportRetry')
  if (reason === 'stream_options_fallback') return t('agentPerspectiveStreamFallback')
  if (reason === 'credential_refresh') return t('agentPerspectiveCredentialRefresh')
  return t('agentPerspectiveInitial')
}

export function phaseLabel(t: (key: string) => string, record: ModelRequestTraceRecord): string {
  const key = record.phase === 'credential'
    ? 'agentPerspectivePhaseCredential'
    : record.phase === 'setup'
      ? 'agentPerspectivePhaseSetup'
      : record.phase === 'transport'
        ? 'agentPerspectivePhaseTransport'
        : record.phase === 'sdk'
          ? 'agentPerspectivePhaseSdk'
          : 'agentPerspectivePhaseModel'
  // Records captured before phase tagging are still model transports; mark them
  // as legacy so the viewer does not mistake them for a fresh diagnostic.
  const legacy = record.phase === undefined && record.status !== 'not_started'
    ? ` · ${t('agentPerspectiveLegacyTrace')}`
    : ''
  return `${t(key)}${legacy}`
}

export function failureOriginLabel(
  t: (key: string) => string,
  origin: ModelRequestTraceFailureOrigin
): string {
  switch (origin) {
    case 'provider': return t('agentPerspectiveFailureProvider')
    case 'credential': return t('agentPerspectiveFailureCredential')
    case 'setup': return t('agentPerspectiveFailureSetup')
    case 'config': return t('agentPerspectiveFailureConfig')
    case 'runtime': return t('agentPerspectiveFailureRuntime')
    case 'transport': return t('agentPerspectiveFailureTransport')
  }
}

export function statusLabel(t: (key: string) => string, record: ModelRequestTraceRecord): string {
  if (record.status === 'pending') return t('agentPerspectivePending')
  if (record.status === 'transport_error') return t('agentPerspectiveTransportError')
  if (record.status === 'capture_error') return t('agentPerspectiveCaptureError')
  if (record.status === 'not_started') return t('agentPerspectiveNotStarted')
  if (record.decoded?.error) return t('agentPerspectiveModelError')
  return `${t('agentPerspectiveCompleted')}${record.response ? ` · HTTP ${record.response.status}` : ''}`
}
