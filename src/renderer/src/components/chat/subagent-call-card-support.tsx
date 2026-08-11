import { useEffect, useState, type ReactElement } from 'react'
import type { TFunction } from 'i18next'
import type { ChatBlock } from '../../agent/types'
import {
  isTerminalSubagentStatus,
  type SubagentLivenessStatus
} from '../subagents/SubagentLiveness'

export type CardStatus = SubagentLivenessStatus
export type OpenChildThreadHandler = (threadId: string) => void

export const KNOWN_POSE_IDS = new Set([
  'general',
  'explore',
  'design-reviewer',
  'over-engineering-reviewer',
  'code-reviewer',
  'test-engineer',
  'security-auditor',
  'web-performance-auditor',
  'code-review',
  'compaction',
  'title',
  'summary'
])

/** Parsed shape of the `delegate_task` / `explore_agent` tool `detail` JSON (all optional). */
export type DelegateDetail = {
  /** The child thread id — always present in the tool result, unlike `meta.child`. */
  childId?: string
  status?: 'queued' | 'running' | 'completed' | 'failed' | 'aborted'
  /** Short UI title from explore_agent (or early lifecycle updates). */
  title?: string
  /** Narrow explore query from the initial tool arguments payload. */
  query?: string
  summary?: string
  summaryTruncated?: boolean
  resultRef?: {
    artifactId: string
    byteSize: number
    lineCount: number
    mimeType: 'text/markdown'
  }
  resultUnavailableReason?: string
  error?: string
  profile?: string
  profileName?: string
  model?: string
  toolPolicy?: string
  toolInvocations?: number
  durationMs?: number
  queuedMs?: number
  totalTokens?: number
  detached?: boolean
  generated?: boolean
  generatedAgentName?: string
}

export type ExploreBatchChildDetail = DelegateDetail & {
  index: number
  title: string
  query: string
  status: NonNullable<DelegateDetail['status']>
  profile: 'explore'
  profileName: string
}

export function parseDelegateDetail(detail: string | undefined): DelegateDetail {
  if (!detail || !detail.trim()) return {}
  let raw: unknown
  try {
    raw = JSON.parse(detail)
  } catch {
    return {}
  }
  if (!raw || typeof raw !== 'object') return {}
  const obj = raw as Record<string, unknown>
  const usage = obj.usage && typeof obj.usage === 'object' ? (obj.usage as Record<string, unknown>) : undefined
  const routing = obj.routing && typeof obj.routing === 'object' ? (obj.routing as Record<string, unknown>) : undefined
  const generatedAgent = obj.generatedAgent && typeof obj.generatedAgent === 'object'
    ? (obj.generatedAgent as Record<string, unknown>)
    : undefined
  const routingAgent = routing?.agent && typeof routing.agent === 'object'
    ? (routing.agent as Record<string, unknown>)
    : undefined
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim() ? v.trim() : undefined
  const status = (v: unknown): DelegateDetail['status'] =>
    v === 'queued' || v === 'running' || v === 'completed' || v === 'failed' || v === 'aborted'
      ? v
      : undefined
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? v : undefined
  const resultRef = obj.resultRef && typeof obj.resultRef === 'object'
    ? obj.resultRef as Record<string, unknown>
    : undefined
  const artifactId = str(resultRef?.artifactId)
  const byteSize = num(resultRef?.byteSize)
  const lineCount = num(resultRef?.lineCount)
  return {
    childId: str(obj.childId),
    status: status(obj.status),
    title: str(obj.title),
    query: str(obj.query),
    summary: str(obj.summary),
    summaryTruncated: obj.summaryTruncated === true,
    ...(artifactId && byteSize !== undefined && lineCount !== undefined
      ? { resultRef: { artifactId, byteSize, lineCount, mimeType: 'text/markdown' } }
      : {}),
    resultUnavailableReason: str(obj.resultUnavailableReason),
    error: str(obj.error),
    profile: str(obj.profile),
    profileName: str(obj.profileName),
    model: str(obj.model),
    toolPolicy: str(obj.toolPolicy),
    toolInvocations: num(obj.toolInvocations),
    durationMs: num(obj.durationMs),
    queuedMs: num(obj.queuedMs),
    totalTokens: usage ? num(usage.totalTokens) : undefined,
    detached: obj.detached === true,
    generated: routing?.selectedKind === 'generated' || str(obj.profile)?.startsWith('generated:') === true,
    generatedAgentName: str(generatedAgent?.name) ?? str(routingAgent?.name)
  }
}

/** Parse the new aggregate explore result without changing legacy scalar parsing. */
export function parseExploreBatchChildren(detail: string | undefined): ExploreBatchChildDetail[] {
  if (!detail || !detail.trim()) return []
  let raw: unknown
  try {
    raw = JSON.parse(detail)
  } catch {
    return []
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return []
  const children = (raw as Record<string, unknown>).children
  if (!Array.isArray(children) || children.length < 1 || children.length > 4) return []
  const parsed: ExploreBatchChildDetail[] = []
  const seen = new Set<number>()
  for (const candidate of children) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return []
    const child = candidate as Record<string, unknown>
    const detailValue = parseDelegateDetail(JSON.stringify(child))
    const index = child.index
    if (!Number.isInteger(index) || (index as number) < 0 || (index as number) > 3 || seen.has(index as number)) {
      return []
    }
    if (!detailValue.title || !detailValue.query || !detailValue.status || detailValue.profile !== 'explore') {
      return []
    }
    seen.add(index as number)
    parsed.push({
      ...detailValue,
      index: index as number,
      title: detailValue.title,
      query: detailValue.query,
      status: detailValue.status,
      profile: 'explore',
      profileName: detailValue.profileName || 'Repository Explorer'
    })
  }
  return parsed.sort((left, right) => left.index - right.index)
}

export type ChildMeta = {
  childId?: string
  childLabel?: string
  childProfile?: string
  childProfileName?: string
  childModel?: string
  childStatus?: string
  childSeq?: number
  parentTurnId?: string
  toolInvocations?: number
  durationMs?: number
  queuedMs?: number
  totalTokens?: number
  summaryTruncated?: boolean
  resultRef?: DelegateDetail['resultRef']
  resultUnavailableReason?: string
  detached?: boolean
}

export function readChildMeta(block: ChatBlock): ChildMeta {
  const meta =
    block.kind === 'tool' || block.kind === 'approval' || block.kind === 'user'
      ? block.meta
      : undefined
  const child = meta?.child && typeof meta.child === 'object' ? (meta.child as Record<string, unknown>) : null
  if (!child) return {}
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim() ? v.trim() : undefined
  return {
    childId: str(child.childId),
    childLabel: str(child.childLabel),
    childProfile: str(child.childProfile),
    childProfileName: str(child.childProfileName),
    childModel: str(child.childModel),
    childStatus: str(child.childStatus),
    childSeq: typeof child.childSeq === 'number' ? child.childSeq : undefined,
    parentTurnId: str(child.parentTurnId),
    toolInvocations: typeof child.toolInvocations === 'number' ? child.toolInvocations : undefined,
    durationMs: typeof child.durationMs === 'number' ? child.durationMs : undefined,
    queuedMs: typeof child.queuedMs === 'number' ? child.queuedMs : undefined,
    totalTokens: typeof child.totalTokens === 'number' ? child.totalTokens : undefined,
    summaryTruncated: child.summaryTruncated === true,
    ...(child.resultRef && typeof child.resultRef === 'object'
      ? { resultRef: child.resultRef as DelegateDetail['resultRef'] }
      : {}),
    resultUnavailableReason: str(child.resultUnavailableReason),
    detached: child.detached === true
  }
}

/**
 * Map the child run + block status to one of five card states. Terminal
 * evidence is monotonic: a stale replayed `queued`/`running` child snapshot
 * must not override a settled tool result that is already on the timeline.
 */
export function resolveStatus(block: ChatBlock, child: ChildMeta, detail?: DelegateDetail): CardStatus {
  const detached = child.detached === true || detail?.detached === true
  const cs = child.childStatus
  const blockStatus =
    'status' in block && typeof block.status === 'string' ? block.status : undefined

  // A terminal child event is the most specific signal and can still turn a
  // superficially successful tool result into a failed child card.
  if (cs === 'completed') return 'done'
  if (cs === 'failed' || cs === 'aborted') return 'failed'
  if (detail?.status === 'completed') return 'done'
  if (detail?.status === 'failed' || detail?.status === 'aborted') return 'failed'

  // The tool projection is monotonic: success/error means the child settled,
  // even if a stale lifecycle snapshot still says queued/running.
  if (blockStatus === 'success') return 'done'
  if (blockStatus === 'error') return 'failed'

  if (detached) {
    if (cs === 'queued' || cs === 'running') return 'running'
    if (detail?.status === 'queued' || detail?.status === 'running') return 'running'
  }
  if (cs === 'queued') return 'queued'
  if (cs === 'running') return 'running'
  if (detail?.status === 'queued') return 'queued'
  if (detail?.status === 'running') return 'running'
  // Pending approval surfaced as an approval block alongside the child.
  if (block.kind === 'approval' && block.status === 'pending') return 'awaiting-permission'
  if (blockStatus === 'running') return 'running'
  return 'running'
}

export function isTerminal(status: CardStatus): boolean {
  return isTerminalSubagentStatus(status)
}

/** Deterministic hue from a string, so same-pose custom agents differ. */
export function hashHue(input: string): number {
  let h = 0
  for (let i = 0; i < input.length; i += 1) {
    h = (h * 31 + input.charCodeAt(i)) | 0
  }
  return Math.abs(h) % 360
}

/** Freeze animation when the card scrolls out of the viewport. */
export function useOnScreen(ref: React.RefObject<Element | null>): boolean {
  const [onScreen, setOnScreen] = useState(true)
  useEffect(() => {
    const el = ref.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver((entries) => {
      const entry = entries[0]
      if (entry) setOnScreen(entry.isIntersecting)
    })
    io.observe(el)
    return () => io.disconnect()
  }, [ref])
  return onScreen
}

export function StatusPill({ status, t }: { status: CardStatus; t: (k: string) => string }): ReactElement | null {
  const base = 'whitespace-nowrap rounded-full px-2 py-[2px] text-[10.5px] font-semibold'
  switch (status) {
    case 'queued':
      return <span className={`${base} bg-ds-card-muted text-ds-muted`}>{t('subagentStatusQueued')}</span>
    case 'running':
      return <span className={`${base} bg-accent/10 text-accent`}>{t('subagentStatusRunning')}</span>
    case 'done':
      return (
        <span className={`${base} text-ds-success bg-ds-success-soft`}>{t('subagentStatusDone')}</span>
      )
    case 'failed':
      return (
        <span className={`${base} text-ds-danger bg-ds-danger-soft`}>{t('subagentStatusFailed')}</span>
      )
    case 'awaiting-permission':
      return (
        <span className={`${base} bg-amber-500/10 text-amber-600 dark:text-amber-300`}>
          {t('subagentStatusAwaiting')}
        </span>
      )
    default:
      return null
  }
}

export function BackgroundPill({ t }: { t: (k: string) => string }): ReactElement {
  return (
    <span className="whitespace-nowrap rounded-full bg-sky-500/10 px-2 py-[2px] text-[10.5px] font-semibold text-sky-600 dark:text-sky-300">
      {t('subagentDetachedBadge')}
    </span>
  )
}

export function GeneratedPill({ t }: { t: TFunction<'common'> }): ReactElement {
  return (
    <span className="whitespace-nowrap rounded-full bg-violet-500/10 px-2 py-[2px] text-[10.5px] font-semibold text-violet-600 dark:text-violet-300">
      {t('subagentGeneratedBadge', { defaultValue: 'Generated' })}
    </span>
  )
}

export function ExploreKindBadge({ t }: { t: TFunction<'common'> }): ReactElement {
  return (
    <span
      data-testid="explore-kind-badge"
      className="shrink-0 rounded-full bg-emerald-500/12 px-2 py-[2px] text-[10.5px] font-semibold text-emerald-700 dark:text-emerald-300"
    >
      {t('exploreKindBadge', { defaultValue: 'Explore' })}
    </span>
  )
}

export function MetaChip({ children, title }: { children: React.ReactNode; title?: string }): ReactElement {
  return (
    <span
      className="rounded-[7px] border border-ds-border-muted bg-ds-card-muted/45 px-2 py-[3px] text-[10.5px] text-ds-muted"
      title={title}
    >
      {children}
    </span>
  )
}

export function AgentModelMetadata({
  agentIdentity,
  profileId,
  model,
  compact,
  t
}: {
  agentIdentity: string
  profileId?: string
  /** When omitted/empty, the model chips are hidden (never show "Not recorded"). */
  model?: string
  compact: boolean
  t: TFunction<'common'>
}): ReactElement {
  const labelClass = 'shrink-0 rounded-[5px] bg-ds-card-muted/70 px-1.5 py-0.5 font-semibold text-ds-faint'
  const valueClass = 'min-w-0 truncate rounded-[5px] bg-ds-card-muted/45 px-1.5 py-0.5 text-ds-muted'
  const modelValue = model?.trim() || ''
  return (
    <div
      data-testid="subagent-route-metadata"
      data-agent-id={profileId ?? ''}
      data-model={modelValue}
      className="mt-1 flex min-w-0 items-center gap-1 overflow-hidden text-[10.5px] leading-4"
    >
      <span className={labelClass}>{t('subagentAgentLabel', { defaultValue: 'Agent' })}</span>
      <span
        className={`${valueClass} ${compact ? 'max-w-[180px]' : 'max-w-[240px]'}`}
        title={agentIdentity}
      >
        {agentIdentity}
      </span>
      {modelValue ? (
        <>
          <span className="shrink-0 text-ds-faint">·</span>
          <span className={labelClass}>{t('subagentModelLabel', { defaultValue: 'Model' })}</span>
          <span
            className={`${valueClass} ${compact ? 'max-w-[130px]' : 'max-w-[180px]'} font-mono`}
            title={modelValue}
          >
            {modelValue}
          </span>
        </>
      ) : null}
    </div>
  )
}
