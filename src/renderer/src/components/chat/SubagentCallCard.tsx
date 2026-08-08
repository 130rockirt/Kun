import type { ReactElement } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { Check, ChevronDown, ChevronRight, Eye, Hourglass, Loader2 } from 'lucide-react'
import type { ChatBlock, ToolBlock } from '../../agent/types'
import { useChatStore } from '../../store/chat-store'
import { AgentKun } from '../subagents/AgentKun'
import {
  isTerminalSubagentStatus,
  SubagentLiveAvatar as AvatarDisc,
  SubagentLivenessLane as LaneHairline,
  type SubagentLivenessStatus,
  useSubagentElapsed,
  useSubagentReducedMotion
} from '../subagents/SubagentLiveness'
import { BUILTIN_AGENT_CATALOG_BY_ID } from '../../../../../kun/src/delegation/builtin-agent-catalog'
import { AssistantMarkdown } from './AssistantMarkdown'
import { ExplorePeekPopover } from './ExplorePeekPopover'
import {
  firstUsefulLine,
  isBareSubagentToolName,
  isExploreToolBlock,
  resolveExploreTaskTitle
} from './explore-card-copy'
import {
  formatChildActivityLabel,
  readChildActivityFromBlock
} from './explore-peek-summary'

/**
 * "Kun Crew" — the subagent (`delegate_task`) visualization for the chat
 * timeline. A single delegation renders as one {@link SubagentCallCard}; sibling
 * delegations of one turn coalesce under a {@link SwarmHeader} (only N >= 2).
 *
 * Three independent visual channels: AgentKun **pose** = role, **motion** =
 * liveness, **disc ring + status dot** = status. Bound only to fields that
 * exist today (`block.meta.child` + guarded parse of the tool `detail` JSON);
 * every read degrades gracefully so a contract change never blanks the card.
 */

type CardStatus = SubagentLivenessStatus
export type OpenChildThreadHandler = (threadId: string) => void

const KNOWN_POSE_IDS = new Set([
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
type DelegateDetail = {
  /** The child thread id — always present in the tool result, unlike `meta.child`. */
  childId?: string
  status?: 'queued' | 'running' | 'completed' | 'failed' | 'aborted'
  /** Short UI title from explore_agent (or early lifecycle updates). */
  title?: string
  /** Narrow explore query from the initial tool arguments payload. */
  query?: string
  summary?: string
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
  return {
    childId: str(obj.childId),
    status: status(obj.status),
    title: str(obj.title),
    query: str(obj.query),
    summary: str(obj.summary),
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

type ChildMeta = {
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
  detached?: boolean
}

function readChildMeta(block: ChatBlock): ChildMeta {
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
    detached: child.detached === true
  }
}

/**
 * Map the child run + block status to one of five card states. Terminal
 * evidence is monotonic: a stale replayed `queued`/`running` child snapshot
 * must not override a settled tool result that is already on the timeline.
 */
function resolveStatus(block: ChatBlock, child: ChildMeta, detail?: DelegateDetail): CardStatus {
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

function isTerminal(status: CardStatus): boolean {
  return isTerminalSubagentStatus(status)
}

/** Deterministic hue from a string, so same-pose custom agents differ. */
function hashHue(input: string): number {
  let h = 0
  for (let i = 0; i < input.length; i += 1) {
    h = (h * 31 + input.charCodeAt(i)) | 0
  }
  return Math.abs(h) % 360
}

/** Freeze animation when the card scrolls out of the viewport. */
function useOnScreen(ref: React.RefObject<Element | null>): boolean {
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

function StatusPill({ status, t }: { status: CardStatus; t: (k: string) => string }): ReactElement | null {
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

function BackgroundPill({ t }: { t: (k: string) => string }): ReactElement {
  return (
    <span className="whitespace-nowrap rounded-full bg-sky-500/10 px-2 py-[2px] text-[10.5px] font-semibold text-sky-600 dark:text-sky-300">
      {t('subagentDetachedBadge')}
    </span>
  )
}

function GeneratedPill({ t }: { t: TFunction<'common'> }): ReactElement {
  return (
    <span className="whitespace-nowrap rounded-full bg-violet-500/10 px-2 py-[2px] text-[10.5px] font-semibold text-violet-600 dark:text-violet-300">
      {t('subagentGeneratedBadge', { defaultValue: 'Generated' })}
    </span>
  )
}

function ExploreKindBadge({ t }: { t: TFunction<'common'> }): ReactElement {
  return (
    <span
      data-testid="explore-kind-badge"
      className="shrink-0 rounded-full bg-emerald-500/12 px-2 py-[2px] text-[10.5px] font-semibold text-emerald-700 dark:text-emerald-300"
    >
      {t('exploreKindBadge', { defaultValue: 'Explore' })}
    </span>
  )
}

function MetaChip({ children, title }: { children: React.ReactNode; title?: string }): ReactElement {
  return (
    <span
      className="rounded-[7px] border border-ds-border-muted bg-ds-card-muted/45 px-2 py-[3px] text-[10.5px] text-ds-muted"
      title={title}
    >
      {children}
    </span>
  )
}

function AgentModelMetadata({
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

export function SubagentCallCard({
  block,
  compact = false,
  inGroup = false,
  tickNow,
  onOpenChildThread
}: {
  block: ChatBlock
  /** Smaller avatar variant used inside a swarm group. */
  compact?: boolean
  /** Inside a SwarmHeader group: suppress own shell, inline-toggle only. */
  inGroup?: boolean
  /** Parent group clock used to keep all child timers moving in lockstep. */
  tickNow?: number
  onOpenChildThread?: OpenChildThreadHandler
}): ReactElement | null {
  const { t } = useTranslation('common')
  const selectThread = useChatStore((s) => s.selectThread)
  const reducedMotion = useSubagentReducedMotion()
  const ref = useRef<HTMLElement | null>(null)
  const onScreen = useOnScreen(ref)

  const child = readChildMeta(block)
  const detail = useMemo(
    () => parseDelegateDetail(block.kind === 'tool' ? (block as ToolBlock).detail : undefined),
    [block]
  )
  const activity = useMemo(() => readChildActivityFromBlock(block), [block])
  const status = resolveStatus(block, child, detail)
  const detached = child.detached === true || detail.detached === true
  const generated = detail.generated === true || (child.childProfile?.startsWith('generated:') ?? false)
  const animate = !reducedMotion && onScreen && status === 'running'
  const isExplore = block.kind === 'tool' && isExploreToolBlock(block as ToolBlock)

  // Profile id: prefer the live `childProfile` from the runtime metadata (set on
  // the first queued/running event) so the agent type shows immediately; the
  // result-JSON `profile` only arrives after the child completes.
  const profileId = child.childProfile || detail.profile || (isExplore ? 'explore' : undefined)
  // Pose key: profile → childLabel → block toolName → 'custom'.
  const poseId = profileId || (isExplore ? 'explore' : undefined) || child.childLabel || child.childId || 'custom'
  const isKnownPose = KNOWN_POSE_IDS.has(poseId)
  const hue = isKnownPose ? null : hashHue(poseId)

  // Keep the task label and the selected agent identity separate. The runtime
  // snapshot is authoritative for custom/generated roles; built-ins may use a
  // localized catalog label without consulting mutable profile settings.
  const taskText = block.kind === 'tool' ? splitTaskLine(block as ToolBlock) : undefined
  const exploreCatalog = BUILTIN_AGENT_CATALOG_BY_ID.explore
  const recordedAgentName = child.childProfileName || detail.profileName || detail.generatedAgentName
  const localizedBuiltinName =
    profileId && BUILTIN_AGENT_CATALOG_BY_ID[profileId]
      ? t(`subagentsPanel.role.${profileId}.name`, BUILTIN_AGENT_CATALOG_BY_ID[profileId]!.name)
      : undefined
  const exploreAgentName = t(
    'subagentsPanel.role.explore.name',
    exploreCatalog?.name ?? 'Repository Explorer'
  )
  const agentName = isExplore
    ? (localizedBuiltinName || recordedAgentName || exploreAgentName)
    : (
      localizedBuiltinName ||
      recordedAgentName ||
      (profileId && KNOWN_POSE_IDS.has(profileId)
        ? t(`subagentsPanel.role.${profileId}.name`, profileId)
        : undefined) ||
      profileId?.trim() ||
      t('subagentNotRecorded', { defaultValue: 'Not recorded' })
    )
  const agentIdentity = isExplore
    ? agentName
    : (profileId && agentName !== profileId ? `${agentName} (${profileId})` : agentName)
  const model = (child.childModel || detail.model || '').trim() || undefined
  const taskTitle = isExplore
    ? resolveExploreTaskTitle({
      childLabel: child.childLabel,
      title: detail.title,
      query: detail.query,
      summary: detail.summary,
      blockSummary: block.kind === 'tool' ? (block as ToolBlock).summary : undefined,
      fallback: t('exploreTaskDefaultTitle', { defaultValue: 'Explore task' })
    })
    : (
      firstUsefulLine(child.childLabel) ||
      firstUsefulLine(detail.title) ||
      firstUsefulLine(taskText, 48) ||
      (isBareSubagentToolName(agentName) ? t('subagentDefaultName') : agentName) ||
      t('subagentDefaultName')
    )
  const activityLine = !isTerminal(status) ? formatChildActivityLabel(activity) : undefined
  const steps = child.toolInvocations ?? detail.toolInvocations
  const childId = child.childId || detail.childId
  // Short subtitle only — keep CTA on the explicit process button, not in truncated text.
  const taskLine = activityLine || (
    isExplore && isTerminal(status)
      ? (firstUsefulLine(detail.summary, 96) || firstUsefulLine(detail.query, 96) || undefined)
      : (
        detail.summary?.trim() ||
        detail.query?.trim() ||
        (taskText?.trim() !== taskTitle ? taskText?.trim() : '') ||
        undefined
      )
  )

  const elapsed = useSubagentElapsed(
    status,
    block.createdAt,
    child.durationMs ?? detail.durationMs,
    tickNow
  )

  const hasBody = Boolean(detail.summary?.trim() || detail.error?.trim())
  // Completed explore conclusions default open so the full text is readable.
  const exploreConclusionDefaultOpen = isExplore && isTerminal(status) && hasBody
  const [userToggled, setUserToggled] = useState<boolean | null>(null)
  const [peekOpen, setPeekOpen] = useState(false)
  const expanded = hasBody && !peekOpen && (userToggled ?? exploreConclusionDefaultOpen)

  const canJump = Boolean(childId)
  const openChild = (): void => {
    if (!childId) return
    setPeekOpen(false)
    if (onOpenChildThread) {
      onOpenChildThread(childId)
      return
    }
    void selectThread(childId).catch(() => undefined)
  }
  const toggleConclusion = (): void => {
    if (!hasBody) return
    setUserToggled(!(userToggled ?? exploreConclusionDefaultOpen))
  }

  // Stagger sweep/pulse per child so a swarm reads as independent.
  const staggerDelay = typeof child.childSeq === 'number' ? `${(child.childSeq % 6) * 0.18}s` : '0s'

  const shellClass = inGroup
    ? 'overflow-hidden border-t border-ds-border-muted first:border-t-0'
    : 'ds-subagent-mount overflow-hidden rounded-[20px] border border-ds-border bg-ds-card/80 shadow-[0_16px_40px_rgba(86,103,136,0.08)] backdrop-blur-xl'
  const failBorder = !inGroup && status === 'failed' ? ' border-ds-danger/60' : ''

  return (
    <section
      ref={ref as React.RefObject<HTMLElement>}
      className={`${shellClass}${failBorder}`}
      style={{ ['--ds-subagent-stagger' as string]: staggerDelay }}
      aria-label={`${taskTitle} · ${agentIdentity}${model ? ` · ${model}` : ''} · ${pillText(status, t)}`}
      data-testid="subagent-call-card"
      data-explore={isExplore ? 'true' : 'false'}
      data-activity-label={activityLine ?? ''}
      data-conclusion-expanded={expanded ? 'true' : 'false'}
    >
      <div
        role={hasBody ? 'button' : undefined}
        tabIndex={hasBody ? 0 : undefined}
        aria-expanded={hasBody ? expanded : undefined}
        onClick={() => {
          if (hasBody) toggleConclusion()
        }}
        onKeyDown={(e) => {
          if (!hasBody) return
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            toggleConclusion()
          }
        }}
        className={`flex items-center gap-3 px-4 ${compact ? 'py-2.5' : 'py-3'} text-left ${
          hasBody ? 'cursor-pointer transition hover:bg-ds-hover/30' : ''
        }`}
      >
        <AvatarDisc poseId={poseId} status={status} hue={hue} compact={compact} animate={animate} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            {isExplore ? <ExploreKindBadge t={t} /> : null}
            <span className="truncate text-[14px] font-semibold text-ds-ink" title={taskTitle}>{taskTitle}</span>
            {generated ? <GeneratedPill t={t} /> : null}
            {detached ? <BackgroundPill t={t} /> : null}
            {!compact || !inGroup ? <StatusPill status={status} t={t} /> : null}
          </div>
          <AgentModelMetadata
            agentIdentity={agentIdentity}
            profileId={profileId}
            model={model}
            compact={compact}
            t={t}
          />
          {taskLine && !expanded ? (
            <span
              className={`mt-0.5 block truncate text-[12.5px] ${
                activityLine ? 'text-accent' : 'text-ds-muted'
              }`}
              title={taskLine}
              data-testid="subagent-activity-line"
            >
              {taskLine}
            </span>
          ) : null}
          {hasBody && !expanded ? (
            <span className="mt-0.5 block text-[11.5px] font-semibold text-accent">
              {t('exploreExpandConclusion', { defaultValue: 'Show conclusion' })}
            </span>
          ) : null}
        </div>
        <span className="shrink-0 text-right tabular-nums">
          <span className="block text-[13px] font-semibold text-ds-ink">{elapsed}</span>
          <span className="mt-px block text-[10.5px] text-ds-faint">
            {typeof steps === 'number'
              ? t('subagentSteps', { count: steps })
                : status === 'queued' && typeof (child.queuedMs ?? detail.queuedMs) === 'number'
                  ? t('subagentQueuedHint')
                  : ''}
          </span>
        </span>
        {childId ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              setPeekOpen((value) => !value)
            }}
            className="flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] font-semibold text-ds-faint transition hover:bg-ds-hover hover:text-ds-ink"
            aria-label={t('explorePeekPreview', { defaultValue: 'Preview' })}
            title={t('explorePeekPreview', { defaultValue: 'Preview' })}
            data-testid="explore-peek-button"
          >
            <Eye className="h-3.5 w-3.5" strokeWidth={2} />
            <span className="hidden sm:inline">{t('explorePeekPreview', { defaultValue: 'Preview' })}</span>
          </button>
        ) : null}
        {childId ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              openChild()
            }}
            className="flex h-7 shrink-0 items-center gap-1 rounded-md bg-accent/10 px-2 text-[11px] font-semibold text-accent transition hover:bg-accent/15"
            aria-label={
              isExplore
                ? t('exploreViewProcess', { defaultValue: 'View explore process' })
                : t('subagentOpenSession')
            }
            title={
              isExplore
                ? t('exploreViewProcess', { defaultValue: 'View explore process' })
                : t('subagentOpenSession')
            }
            data-testid="explore-open-process-button"
          >
            {isExplore
              ? t('exploreViewProcessShort', { defaultValue: 'Open' })
              : t('subagentOpenSessionShort', { defaultValue: 'Open' })}
            <ChevronRight className="h-3.5 w-3.5" strokeWidth={2} />
          </button>
        ) : null}
        {hasBody ? (
          expanded ? (
            <ChevronDown className="h-4 w-4 shrink-0 text-ds-faint" strokeWidth={1.8} />
          ) : (
            <ChevronRight className="h-4 w-4 shrink-0 text-ds-faint" strokeWidth={1.8} />
          )
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0 text-ds-faint/40" strokeWidth={1.8} />
        )}
      </div>

      <LaneHairline status={status} animate={animate} />

      {expanded ? (
        <div
          className="border-t border-ds-border-muted/70 px-4 py-3.5"
          data-testid="subagent-conclusion-body"
        >
          {detail.error?.trim() ? (
            <pre className="max-h-[320px] overflow-y-auto whitespace-pre-wrap break-words rounded-[10px] border border-red-200/80 bg-red-50/80 px-3 py-2.5 font-mono text-[12px] leading-5 text-ds-danger dark:border-red-800/40 dark:bg-red-500/10">
              {detail.error}
            </pre>
          ) : detail.summary?.trim() ? (
            isExplore ? (
              <div className="max-h-[360px] overflow-y-auto text-[14px] leading-6 text-ds-ink">
                <AssistantMarkdown
                  text={detail.summary}
                  streaming={false}
                  className="ds-markdown text-[14px] leading-6 text-ds-ink"
                />
              </div>
            ) : (
              <p className="max-h-[320px] overflow-y-auto whitespace-pre-wrap text-[14px] leading-6 text-ds-muted">
                {detail.summary}
              </p>
            )
          ) : null}

          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            {detail.profile ? <MetaChip title={detail.profile}>{detail.profile}</MetaChip> : null}
            {typeof (child.totalTokens ?? detail.totalTokens) === 'number' && (child.totalTokens ?? detail.totalTokens ?? 0) > 0 ? (
              <MetaChip>{t('subagentTokensChip', { count: child.totalTokens ?? detail.totalTokens })}</MetaChip>
            ) : null}
            {detail.toolPolicy ? (
              <MetaChip>
                {detail.toolPolicy === 'readOnly' ? t('subagentPolicyReadOnly') : t('subagentPolicyFull')}
              </MetaChip>
            ) : null}
          </div>
        </div>
      ) : null}

      {childId ? (
        <ExplorePeekPopover
          open={peekOpen}
          anchorEl={ref.current}
          childId={childId}
          title={taskTitle}
          elapsedLabel={elapsed}
          statusLabel={pillText(status, t)}
          activity={activity}
          summary={detail.summary}
          onClose={() => setPeekOpen(false)}
          onOpenChildThread={(threadId) => {
            setPeekOpen(false)
            if (onOpenChildThread) {
              onOpenChildThread(threadId)
              return
            }
            void selectThread(threadId).catch(() => undefined)
          }}
        />
      ) : null}
    </section>
  )
}

function pillText(status: CardStatus, t: (k: string) => string): string {
  switch (status) {
    case 'queued':
      return t('subagentStatusQueued')
    case 'running':
      return t('subagentStatusRunning')
    case 'done':
      return t('subagentStatusDone')
    case 'failed':
      return t('subagentStatusFailed')
    case 'awaiting-permission':
      return t('subagentStatusAwaiting')
    default:
      return ''
  }
}

/** Best-effort task one-liner from a generic delegate/explore summary string. */
function splitTaskLine(block: ToolBlock): string | undefined {
  const detail = parseDelegateDetail(block.detail)
  if (detail.title?.trim()) return detail.title.trim()
  const raw = block.summary?.trim()
  if (!raw) return undefined
  const stripped = raw
    .replace(/^(delegate_task|explore_agent|generate_subagent)\s*:\s*/i, '')
    .trim()
  if (!stripped || stripped.length > 160) return undefined
  // Bare tool name (no task text yet, e.g. while running) — nothing useful.
  if (/^(delegate_task|explore_agent|generate_subagent)$/i.test(stripped)) return undefined
  return stripped
}

/**
 * Coalesces sibling {@link SubagentCallCard}s of one turn. Renders a single
 * full card for N=1 (no header); for N>=2 wraps them under a {@link SwarmHeader}
 * with a stacked-avatar cluster and an aggregate count line.
 */
export function SubagentGroup({
  blocks,
  onOpenChildThread
}: {
  blocks: ChatBlock[]
  onOpenChildThread?: OpenChildThreadHandler
}): ReactElement | null {
  const { t } = useTranslation('common')
  const [collapsed, setCollapsed] = useState(false)
  const reducedMotion = useSubagentReducedMotion()
  const [tickNow, setTickNow] = useState(() => Date.now())

  const sorted = [...blocks].sort((a, b) => {
    const sa = readChildMeta(a).childSeq ?? 0
    const sb = readChildMeta(b).childSeq ?? 0
    return sa - sb
  })

  let running = 0
  let queued = 0
  let done = 0
  for (const b of sorted) {
    const detail = parseDelegateDetail(b.kind === 'tool' ? (b as ToolBlock).detail : undefined)
    const s = resolveStatus(b, readChildMeta(b), detail)
    if (s === 'running' || s === 'awaiting-permission') running += 1
    else if (s === 'queued') queued += 1
    else if (s === 'done') done += 1
  }
  const anyRunning = running > 0 || queued > 0
  useEffect(() => {
    if (!anyRunning) return
    setTickNow(Date.now())
    const id = window.setInterval(() => setTickNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [anyRunning])

  if (sorted.length === 0) return null

  const allExplore = sorted.every(
    (b) => b.kind === 'tool' && isExploreToolBlock(b as ToolBlock)
  )

  // N=1, or an all-explore cluster: full independent cards (no swarm shell).
  if (sorted.length === 1 || allExplore) {
    if (sorted.length === 1) {
      return <SubagentCallCard block={sorted[0]} tickNow={tickNow} onOpenChildThread={onOpenChildThread} />
    }
    return (
      <div className="flex flex-col gap-2" data-testid="explore-independent-stack">
        {sorted.map((b) => (
          <SubagentCallCard
            key={b.id}
            block={b}
            tickNow={tickNow}
            onOpenChildThread={onOpenChildThread}
          />
        ))}
      </div>
    )
  }

  const clusterPoses = sorted.slice(0, 5).map((b) => {
    const c = readChildMeta(b)
    const d = parseDelegateDetail(b.kind === 'tool' ? (b as ToolBlock).detail : undefined)
    return c.childProfile || d.profile || c.childLabel || c.childId || 'custom'
  })
  const overflow = sorted.length - clusterPoses.length

  const summaryParts: string[] = []
  if (running > 0) summaryParts.push(t('subagentSwarmRunning', { count: running }))
  if (queued > 0) summaryParts.push(t('subagentSwarmQueued', { count: queued }))
  if (done > 0) summaryParts.push(t('subagentSwarmDone', { count: done }))

  return (
    <section className="ds-subagent-mount overflow-hidden rounded-[20px] border border-ds-border bg-ds-card/80 shadow-[0_16px_40px_rgba(86,103,136,0.08)] backdrop-blur-xl">
      <button
        type="button"
        onClick={() => setCollapsed((v) => !v)}
        aria-expanded={!collapsed}
        className="flex w-full items-center gap-3 border-b border-ds-border-muted bg-gradient-to-b from-ds-card to-ds-card-muted/40 px-4 py-3 text-left transition hover:bg-ds-hover/30"
      >
        {anyRunning && !reducedMotion ? (
          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-accent" strokeWidth={2.2} />
        ) : anyRunning ? (
          <Hourglass className="h-4 w-4 shrink-0 text-accent" strokeWidth={2} />
        ) : (
          <Check className="h-4 w-4 shrink-0 text-ds-success" strokeWidth={2.4} />
        )}
        <span className="min-w-0 flex-1 text-[12.5px] font-semibold text-ds-heading">
          {t('subagentSwarmTitle', { count: sorted.length })}
          {summaryParts.length > 0 ? (
            <span className="font-normal text-ds-muted"> · {summaryParts.join(' · ')}</span>
          ) : null}
        </span>
        <span className="flex shrink-0">
          {clusterPoses.map((pose, i) => (
            <span
              key={`${pose}-${i}`}
              className="flex h-6 w-6 items-center justify-center rounded-full border-2 border-ds-card"
              style={{
                marginLeft: i === 0 ? 0 : -8,
                background: 'radial-gradient(circle at 50% 36%,#fff,#eef4fb)'
              }}
            >
              <AgentKun id={pose} className="h-5 w-5" />
            </span>
          ))}
          {overflow > 0 ? (
            <span
              className="flex h-6 w-6 items-center justify-center rounded-full border-2 border-ds-card bg-ds-card-muted text-[9px] font-semibold text-ds-muted"
              style={{ marginLeft: -8 }}
            >
              +{overflow}
            </span>
          ) : null}
        </span>
        {collapsed ? (
          <ChevronRight className="h-4 w-4 shrink-0 text-ds-faint" strokeWidth={1.8} />
        ) : (
          <ChevronDown className="h-4 w-4 shrink-0 text-ds-faint" strokeWidth={1.8} />
        )}
      </button>
      {!collapsed ? (
        <div>
          {sorted.map((b) => (
            <SubagentCallCard
              key={b.id}
              block={b}
              compact
              inGroup
              tickNow={tickNow}
              onOpenChildThread={onOpenChildThread}
            />
          ))}
        </div>
      ) : null}
    </section>
  )
}
