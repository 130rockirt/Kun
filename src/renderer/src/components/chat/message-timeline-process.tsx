import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, ReactElement, RefObject } from 'react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { LucideIcon } from 'lucide-react'
import {
  Brain,
  Bot,
  BookOpen,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  FolderOpen,
  ListTodo,
  LoaderCircle,
  MessageSquareQuote,
  Minimize2,
  PencilLine,
  BellRing,
  Search,
  Sparkles,
  Square,
  Terminal,
  Wrench
} from 'lucide-react'
import type { ChatBlock, ToolBlock } from '../../agent/types'
import { parseBackgroundSubagentCompletionNotice } from '@shared/background-subagent-notice'
import { extractUnifiedDiffText } from '../../lib/diff-stats'
import { useDeferredRender } from '../../hooks/use-deferred-render'
import { openWorkspacePathInEditor } from '../../lib/open-workspace-path'
import { previewWorkspaceFile } from '../../lib/workspace-file-preview'
import { DiffView } from '../DiffView'
import { AssistantMarkdown } from './AssistantMarkdown'
import { GeneratedFilesPanel, MessageBubble } from './message-timeline-bubbles'
import {
  blockHasPendingRuntimeWork,
  isBackgroundShellNoticeBlock,
  isBackgroundSubagentNoticeBlock,
  splitThink
} from './message-timeline-turns'
import {
  formatDuration,
  formatToolTitle,
  isBackgroundShellCommandBlock,
  parseToolBlockPayload,
  summarizeBackgroundShellToolBlock
} from './message-timeline-tools'
import { isExploreToolBlock } from './explore-card-copy'
import { SubagentGroup, type OpenChildThreadHandler } from './SubagentCallCard'
import { InjectedMemoryMetaChip } from './injected-memory-meta-chip'

export type ProcessSection = {
  id: string
  kind: 'reasoning' | 'execution' | 'output' | 'subagent'
  blocks: ChatBlock[]
}

/**
 * A `delegate_task` tool call (or any block carrying child runtime metadata)
 * is rendered as a "Kun Crew" subagent card, not a generic tool row.
 */
export function isSubagentBlock(block: ChatBlock): boolean {
  if (block.kind !== 'tool') return false
  const meta = block.meta
  if (meta?.child && typeof meta.child === 'object') return true
  const toolName = typeof meta?.toolName === 'string' ? meta.toolName.trim() : ''
  return (
    toolName === 'delegate_task' ||
    toolName === 'generate_subagent' ||
    toolName === 'explore_agent'
  )
}

function processBlockHasGeneratedMedia(block: ChatBlock): block is ToolBlock {
  if (block.kind !== 'tool' || block.status !== 'success') return false
  return (
    Array.isArray(block.meta?.attachments) && block.meta.attachments.length > 0
  ) || (
    Array.isArray(block.meta?.generatedFiles) && block.meta.generatedFiles.length > 0
  )
}

function subagentParentTurnId(block: ChatBlock): string {
  if (block.kind !== 'tool') return ''
  const child = block.meta?.child
  if (child && typeof child === 'object') {
    const parent = (child as Record<string, unknown>).parentTurnId
    if (typeof parent === 'string' && parent.trim()) return parent.trim()
  }
  return ''
}

function isExploreSubagentBlock(block: ChatBlock): boolean {
  return block.kind === 'tool' && isExploreToolBlock(block)
}

function sectionHasExploreBlock(section: ProcessSection): boolean {
  return section.blocks.some(isExploreSubagentBlock)
}

export function groupProcessSections(blocks: ChatBlock[]): ProcessSection[] {
  const sections: ProcessSection[] = []

  for (const block of blocks) {
    if (isSubagentBlock(block)) {
      const last = sections[sections.length - 1]
      // Coalesce sibling non-explore delegations of one turn (same parentTurnId)
      // into one swarm section. Explore cards stay independent so they never
      // land under an "N subagents" swarm shell.
      // Blocks without a parentTurnId only merge with an adjacent
      // parentTurnId-less non-explore subagent run.
      if (
        last &&
        last.kind === 'subagent' &&
        !isExploreSubagentBlock(block) &&
        !sectionHasExploreBlock(last)
      ) {
        const lastParent = subagentParentTurnId(last.blocks[0])
        const parent = subagentParentTurnId(block)
        if (lastParent === parent) {
          last.blocks.push(block)
          continue
        }
      }
      sections.push({ id: `subagent-${block.id}`, kind: 'subagent', blocks: [block] })
      continue
    }
    if (processBlockHasGeneratedMedia(block)) {
      sections.push({ id: `execution-${block.id}`, kind: 'execution', blocks: [block] })
      continue
    }
    if (block.kind === 'compaction') {
      sections.push({ id: `compaction-${block.id}`, kind: 'execution', blocks: [block] })
      continue
    }
    const kind =
      block.kind === 'reasoning'
        ? 'reasoning'
        : block.kind === 'assistant'
          ? 'output'
          : 'execution'
    const last = sections[sections.length - 1]
    const followsGeneratedMedia = last?.blocks.some(processBlockHasGeneratedMedia) === true
    const followsCompaction = last?.blocks.some(
      (candidate) => candidate.kind === 'compaction'
    ) === true

    // Keep a real assistant text update as a hard timeline boundary, but fold
    // adjacent non-text work together. A long read/search/reason sequence does
    // not need to expand into dozens of empty process rows while it runs.
    // The expanded detail still preserves every original entry in order.
    const silentProcessPhase = kind === 'reasoning' || kind === 'execution'
    const previousIsSilentProcessPhase =
      last?.kind === 'reasoning' || last?.kind === 'execution'
    if (
      last &&
      !followsGeneratedMedia &&
      !followsCompaction &&
      silentProcessPhase &&
      previousIsSilentProcessPhase
    ) {
      if (last.kind === 'reasoning' && kind === 'reasoning') {
        last.blocks.push(block)
        continue
      }
      last.kind = 'execution'
      last.blocks.push(block)
      continue
    }

    if (last && !followsGeneratedMedia && !followsCompaction && last.kind === kind) {
      last.blocks.push(block)
      continue
    }
    sections.push({
      id: `${kind}-${block.id}`,
      kind,
      blocks: [block]
    })
  }

  return sections
}

function getReasoningSectionText(section: ProcessSection): string {
  if (section.kind !== 'reasoning') return ''
  return section.blocks
    .filter(
      (block): block is Extract<ChatBlock, { kind: 'reasoning' }> => block.kind === 'reasoning'
    )
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join('\n\n')
}

function sectionHasDetails(
  section: ProcessSection,
  t: (key: string, opts?: Record<string, unknown>) => string
): boolean {
  if (section.kind === 'reasoning') {
    return getReasoningSectionText(section).length > 0
  }
  if (section.kind === 'output') {
    return section.blocks.some(
      (block) => getProcessDetail(block, describeProcessBlock(block, t)).kind === 'assistant'
    )
  }
  if (section.blocks.length > 1) return true
  const [block] = section.blocks
  return block ? getProcessDetail(block, describeProcessBlock(block, t)).kind !== 'none' : false
}

export function processSectionHasActiveWork(
  section: ProcessSection,
  processing: boolean
): boolean {
  if (!processing) return false
  if (section.kind === 'reasoning') {
    return section.blocks.some((block) => block.id === 'live-reasoning')
  }
  if (section.kind === 'output') {
    return section.blocks.some((block) => block.id === 'live-assistant')
  }
  return section.blocks.some(
    (block) =>
      block.id === 'live-reasoning' ||
      block.id === 'live-assistant' ||
      blockHasPendingRuntimeWork(block)
  )
}

function isRequestUserInputTool(block: ChatBlock): boolean {
  if (block.kind === 'user_input' && block.status === 'pending') return true
  if (block.kind !== 'tool' || block.status !== 'running') return false
  const toolName = typeof block.meta?.toolName === 'string' ? block.meta.toolName.trim() : ''
  if (toolName === 'request_user_input' || toolName === 'user_input') return true
  return /^request_user_input\s*:/i.test(block.summary.trim())
}

type ProcessErrorTone = 'tool' | 'error' | null

function processBlockErrorTone(block: ChatBlock): ProcessErrorTone {
  if (block.kind === 'tool' && block.status === 'error') return 'tool'
  if (block.kind === 'compaction' && block.status === 'error') return 'error'
  if (block.kind === 'approval' && block.status === 'error') return 'error'
  if (
    block.kind === 'approval_review' &&
    (block.status === 'timed-out' || block.status === 'failed-closed')
  ) return 'error'
  if (block.kind === 'user_input' && block.status === 'error') return 'error'
  if (block.kind === 'system' && block.severity === 'error') return 'error'
  return null
}

function processSectionErrorTone(blocks: ChatBlock[]): ProcessErrorTone {
  let fallback: ProcessErrorTone = null
  for (const block of blocks) {
    const tone = processBlockErrorTone(block)
    if (tone === 'error') return tone
    if (tone === 'tool') fallback = tone
  }
  return fallback
}

function processErrorTextClass(tone: ProcessErrorTone): string {
  if (tone === 'tool') return 'text-orange-700 dark:text-orange-300'
  if (tone === 'error') return 'text-red-600 dark:text-red-300'
  return 'text-ds-muted'
}

function processErrorDotClass(tone: ProcessErrorTone): string {
  if (tone === 'tool') return 'bg-orange-500 dark:bg-orange-300'
  if (tone === 'error') return 'bg-red-500 dark:bg-red-300'
  return ''
}

function sectionHasRequestUserInput(section: ProcessSection): boolean {
  return section.blocks.some(isRequestUserInputTool)
}

function isPendingApproval(block: ChatBlock): boolean {
  return block.kind === 'approval' && block.status === 'pending'
}

function sectionHasPendingApproval(section: ProcessSection): boolean {
  return section.blocks.some(isPendingApproval)
}

export function ProcessSectionRow({
  section,
  processing,
  reasoningDurationMs,
  singleReasoningSection,
  workspaceRoot,
  viewportRef,
  onOpenChildThread,
  onCancelToolCall,
  allowThreadActions = true
}: {
  section: ProcessSection
  processing: boolean
  reasoningDurationMs?: number
  singleReasoningSection: boolean
  workspaceRoot: string
  viewportRef: RefObject<HTMLDivElement | null>
  onOpenChildThread?: OpenChildThreadHandler
  onCancelToolCall?: (block: ToolBlock) => Promise<boolean>
  allowThreadActions?: boolean
}): ReactElement {
  const { t } = useTranslation('common')
  const [userExpanded, setUserExpanded] = useState<boolean | null>(null)

  const assistantBlocks =
    section.kind === 'output'
      ? section.blocks.filter(
          (block): block is Extract<ChatBlock, { kind: 'assistant' }> => block.kind === 'assistant'
        )
      : []
  const hasDetails = sectionHasDetails(section, t)
  const active = processSectionHasActiveWork(section, processing)
  const errorTone = processSectionErrorTone(section.blocks)
  // Tool failures stay quiet on the batch header: only runtime/system errors
  // expand the group or tint the collapsed title. Inner rows keep their own tone.
  const hasRuntimeError = errorTone === 'error'
  // ConversationTurn owns the single live animation at the visual bottom.
  // Process sections stay quiet so reasoning cannot move that indicator back
  // into the historical timeline.
  const defaultExpanded =
    (processing && hasRuntimeError) ||
    sectionHasPendingApproval(section) ||
    (processing && section.kind === 'execution' && sectionHasRequestUserInput(section))
  const forceExpanded = sectionHasPendingApproval(section)
  const expanded = hasDetails && (forceExpanded || (userExpanded ?? defaultExpanded))
  const title = describeProcessSection(section, t, {
    processing,
    reasoningDurationMs,
    singleReasoningSection
  })
  const SectionIcon = processSectionIcon(section)
  const reasoningText = section.kind === 'reasoning' ? getReasoningSectionText(section) : ''
  const canToggleSection = hasDetails && !forceExpanded
  const showActiveError = active && hasRuntimeError
  const shouldDeferDetails = section.kind !== 'subagent'
  const { ref: deferredDetailRef, shouldRender: shouldRenderDetail } = useDeferredRender<HTMLDivElement>({
    enabled: shouldDeferDetails && expanded,
    immediate: shouldDeferDetails && (active || section.kind === 'execution'),
    root: viewportRef
  })

  if (section.kind === 'subagent') {
    return <SubagentGroup blocks={section.blocks} onOpenChildThread={onOpenChildThread} />
  }

  if (
    section.kind === 'execution' &&
    section.blocks.length === 1 &&
    section.blocks[0]?.kind !== 'reasoning'
  ) {
    const [block] = section.blocks
    if (block) {
      if (block.kind === 'compaction') {
        return <CompactionTimelineEntry block={block} processing={processing} />
      }
      return (
        <ProcessEntryRow
          block={block}
          processing={processing}
          workspaceRoot={workspaceRoot}
          onCancelToolCall={onCancelToolCall}
          allowThreadActions={allowThreadActions}
        />
      )
    }
  }

  if (section.kind === 'output') {
    return hasDetails ? (
      <div className="min-w-0">
        <div className="flex flex-col gap-2">
          {assistantBlocks.map((block) => (
            <ProcessEntryDetail
              key={block.id}
              block={block}
              detail={getProcessDetail(block)}
              processing={processing}
              allowThreadActions={allowThreadActions}
            />
          ))}
        </div>
      </div>
    ) : (
      <></>
    )
  }

  return (
    <div className="flex flex-col">
      {canToggleSection ? (
        <button
          type="button"
          onClick={() => setUserExpanded(!(userExpanded ?? defaultExpanded))}
          aria-expanded={expanded}
          className={`group flex w-fit max-w-full items-center gap-1.5 rounded-md py-0.5 text-left text-[14px] font-medium transition hover:opacity-85 ${
            hasRuntimeError ? processErrorTextClass(errorTone) : 'text-ds-muted'
          }`}
        >
          {showActiveError ? (
            <span className="ds-work-logo-slot ds-work-logo-slot-sm mr-0.5">
              <span className={`h-2 w-2 rounded-full ${processErrorDotClass(errorTone)}`} />
            </span>
          ) : null}
          {SectionIcon ? (
            <ProcessGlyph Icon={SectionIcon} />
          ) : null}
          <span className={active && !hasRuntimeError ? 'ds-shiny-text' : ''}>{title}</span>
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-45" strokeWidth={1.8} />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 shrink-0 opacity-0 transition group-hover:opacity-55" strokeWidth={1.8} />
          )}
        </button>
      ) : (
        <div
          className={`flex w-fit max-w-full items-center gap-1.5 py-0.5 text-[14px] font-medium ${
            hasRuntimeError ? processErrorTextClass(errorTone) : 'text-ds-muted'
          }`}
        >
          {showActiveError ? (
            <span className="ds-work-logo-slot ds-work-logo-slot-sm mr-0.5">
              <span className={`h-2 w-2 rounded-full ${processErrorDotClass(errorTone)}`} />
            </span>
          ) : null}
          {SectionIcon ? (
            <ProcessGlyph Icon={SectionIcon} />
          ) : null}
          <span className={active && !hasRuntimeError ? 'ds-shiny-text' : ''}>{title}</span>
        </div>
      )}

      {expanded ? (
        <div
          ref={deferredDetailRef}
          className="mt-1"
          style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 220px' }}
        >
          {shouldRenderDetail ? (
            section.kind === 'reasoning' ? (
            <div className="ds-markdown text-[13.5px] leading-6 text-ds-faint">
              <AssistantMarkdown
                text={reasoningText}
                streaming={active && processing}
                hideHtmlComments
              />
            </div>
          ) : (
            <ProcessStackRows
              blocks={section.blocks}
              processing={processing}
              workspaceRoot={workspaceRoot}
              onCancelToolCall={onCancelToolCall}
              allowThreadActions={allowThreadActions}
            />
          )
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function processBlockIsAutoOpenPending(block: ChatBlock, processing: boolean): boolean {
  return (
    processing &&
    ((block.kind === 'compaction' && block.status === 'running') ||
      (block.kind === 'approval' && block.status === 'pending') ||
      (block.kind === 'approval_review' && block.status === 'in-progress') ||
      (block.kind === 'user_input' && block.status === 'pending'))
  )
}

function processBlockIsActive(block: ChatBlock, processing: boolean): boolean {
  // Running tools stay visually quiet in the process timeline; ConversationTurn
  // owns the bottom "thinking / running" loading row.
  return (
    processBlockIsAutoOpenPending(block, processing) ||
    (processing && block.kind === 'assistant' && block.id === 'live-assistant')
  )
}

function processBlockHasError(block: ChatBlock): boolean {
  return processBlockErrorTone(block) !== null
}

function BackgroundSubagentRowSummary({
  block
}: {
  block: Extract<ChatBlock, { kind: 'user' }>
}): ReactElement {
  const { t } = useTranslation('common')
  const parsed = parseBackgroundSubagentCompletionNotice(block.text)
  const failed = parsed?.status === 'failed'
  const label =
    parsed?.label ||
    block.meta?.displayText?.trim() ||
    t('backgroundSubagentNotice.title', { defaultValue: 'Background subagent completed' })

  return (
    <span
      data-background-subagent-row="true"
      className="flex min-w-0 flex-1 items-center gap-2.5"
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13.5px] font-semibold text-ds-ink">{label}</span>
        <span className="block truncate text-[11.5px] text-ds-faint">
          {t('backgroundSubagentNotice.taskKind', { defaultValue: 'Background task' })}
        </span>
      </span>
      <span
        className={`inline-flex shrink-0 items-center gap-1.5 text-[11.5px] font-medium ${
          failed
            ? 'text-orange-700 dark:text-orange-300'
            : 'text-emerald-700 dark:text-emerald-300'
        }`}
      >
        <span className={`h-1.5 w-1.5 rounded-full ${failed ? 'bg-orange-500' : 'bg-emerald-500'}`} />
        {failed
          ? t('backgroundSubagentNotice.failed', { defaultValue: 'Failed' })
          : t('backgroundSubagentNotice.completed', { defaultValue: 'Completed' })}
      </span>
    </span>
  )
}

function toolCancelCallId(block: ChatBlock): string {
  if (block.kind !== 'tool') return ''
  const callId = block.meta?.callId
  return typeof callId === 'string' ? callId.trim() : ''
}

function toolCancelRequested(block: ChatBlock): boolean {
  if (block.kind !== 'tool') return false
  return typeof block.meta?.cancelRequestedAt === 'string' && block.meta.cancelRequestedAt.trim().length > 0
}

function canCancelToolBlock(block: ChatBlock, processing: boolean): block is ToolBlock {
  if (!processing || block.kind !== 'tool' || block.status !== 'running' || !toolCancelCallId(block)) return false
  // Detached/background work owns its own lifecycle and must keep using its
  // existing control surface rather than the foreground tool cancellation API.
  if (block.meta?.detached === true || isBackgroundShellCommandBlock(block) || isSubagentBlock(block)) {
    return false
  }
  return true
}

function ToolCancelButton({
  block,
  processing,
  onCancelToolCall
}: {
  block: ChatBlock
  processing: boolean
  onCancelToolCall?: (block: ToolBlock) => Promise<boolean>
}): ReactElement | null {
  const { t } = useTranslation('common')
  const [requested, setRequested] = useState(() => toolCancelRequested(block))
  const cancellable = canCancelToolBlock(block, processing)
  const blockStatus = block.kind === 'tool' ? block.status : undefined
  const blockCancelRequestedAt = block.kind === 'tool' && typeof block.meta?.cancelRequestedAt === 'string'
    ? block.meta.cancelRequestedAt
    : undefined
  const cancelRequested = toolCancelRequested(block)

  useEffect(() => {
    setRequested(cancelRequested)
  }, [block.id, blockStatus, blockCancelRequestedAt, cancelRequested])

  if (!cancellable || !onCancelToolCall) return null
  const stopping = requested || toolCancelRequested(block)
  const handleClick = (event: ReactMouseEvent<HTMLButtonElement>): void => {
    event.preventDefault()
    event.stopPropagation()
    if (stopping) return
    setRequested(true)
    void onCancelToolCall(block).then((accepted) => {
      if (!accepted) setRequested(false)
    }).catch(() => {
      setRequested(false)
    })
  }

  return (
    <button
      type="button"
      aria-label={stopping ? t('toolCancelling') : t('toolCancel')}
      title={stopping ? t('toolCancelling') : t('toolCancel')}
      aria-busy={stopping}
      disabled={stopping}
      onClick={handleClick}
      className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition ${
        stopping ? 'cursor-wait text-accent opacity-80' : 'text-ds-faint hover:bg-ds-hover/70 hover:text-ds-ink'
      }`}
    >
      {stopping ? (
        <LoaderCircle className="h-3.5 w-3.5 animate-spin" strokeWidth={1.9} />
      ) : (
        <Square className="h-3 w-3" fill="currentColor" strokeWidth={1.9} />
      )}
    </button>
  )
}

function ProcessStackRows({
  blocks,
  processing,
  workspaceRoot,
  onCancelToolCall,
  allowThreadActions = true
}: {
  blocks: ChatBlock[]
  processing: boolean
  workspaceRoot: string
  onCancelToolCall?: (block: ToolBlock) => Promise<boolean>
  allowThreadActions?: boolean
}): ReactElement {
  const { t } = useTranslation('common')
  const [openBlockId, setOpenBlockId] = useState<string | null>(null)
  const [closedBlockIds, setClosedBlockIds] = useState<ReadonlySet<string>>(() => new Set())

  return (
    <div className="ds-work-stack">
      {blocks.map((block) => {
        const summary = describeProcessBlock(block, t)
        const detail = getProcessDetail(block, summary)
        const canExpand = detail.kind !== 'none'
        const autoOpenRequestInput = processing && isRequestUserInputTool(block)
        const autoOpenPending = processBlockIsAutoOpenPending(block, processing) || isPendingApproval(block)
        const errorTone = processBlockErrorTone(block)
        const isError = errorTone !== null
        // Keep failed tool payloads tucked away while the turn continues. The
        // warning-toned row still surfaces the failure and remains expandable.
        const defaultOpen = processing && isError && block.kind !== 'tool'
        const forceOpen = autoOpenPending || autoOpenRequestInput
        const userClosed = closedBlockIds.has(block.id)
        const userOpened = openBlockId === block.id
        const open = canExpand && (forceOpen || userOpened || (defaultOpen && !userClosed))
        const rowActive = processBlockIsActive(block, processing)
        const canToggle = canExpand && !forceOpen
        const RowIcon = processBlockIcon(block)
        const isBackgroundSubagent = isBackgroundSubagentNoticeBlock(block)
        const handleToggle = (): void => {
          if (!canToggle) return
          if (open) {
            setOpenBlockId((id) => (id === block.id ? null : id))
            if (defaultOpen) {
              setClosedBlockIds((ids) => {
                const next = new Set(ids)
                next.add(block.id)
                return next
              })
            }
            return
          }
          setClosedBlockIds((ids) => {
            if (!ids.has(block.id)) return ids
            const next = new Set(ids)
            next.delete(block.id)
            return next
          })
          setOpenBlockId(block.id)
        }
        const handleToggleButton = (event: ReactMouseEvent<HTMLButtonElement>): void => {
          event.stopPropagation()
          handleToggle()
        }
        const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
          if (!canToggle) return
          if (event.key !== 'Enter' && event.key !== ' ') return
          event.preventDefault()
          handleToggle()
        }

        return (
          <div key={block.id} className="min-w-0">
            <div
              role={canToggle ? 'button' : undefined}
              tabIndex={canToggle ? 0 : undefined}
              aria-expanded={canToggle ? open : undefined}
              onClick={handleToggle}
              onKeyDown={handleKeyDown}
              className={`group flex w-full min-w-0 items-center text-left text-[13.5px] leading-6 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/25 ${
                isBackgroundSubagent
                  ? 'gap-2.5 rounded-[12px] border border-ds-border bg-ds-card/55 px-3 py-2.5 shadow-[0_2px_10px_rgba(42,52,72,0.035)]'
                  : 'gap-1.5 rounded-md px-1 py-0.5'
              } ${
                isError
                  ? processErrorTextClass(errorTone)
                  : 'text-ds-faint hover:text-ds-muted'
              } ${canToggle ? `cursor-pointer ${isBackgroundSubagent ? 'hover:border-ds-border-strong hover:bg-ds-card' : 'hover:bg-ds-hover/45'}` : 'cursor-default'}`}
            >
              {RowIcon ? <ProcessGlyph Icon={RowIcon} /> : null}
              {isBackgroundSubagent && block.kind === 'user' ? (
                <BackgroundSubagentRowSummary block={block} />
              ) : (
                <span className={`min-w-0 flex-1 truncate ${rowActive && !isError ? 'ds-shiny-text' : ''}`}>
                  <ProcessSummaryText block={block} summary={summary} workspaceRoot={workspaceRoot} />
                </span>
              )}
              {canExpand ? (
                <button
                  type="button"
                  aria-label={open ? t('processCollapseDetail') : t('processExpandDetail')}
                  aria-expanded={open}
                  disabled={!canToggle}
                  onClick={handleToggleButton}
                  className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition ${
                    canToggle ? 'cursor-pointer hover:bg-ds-hover/70' : 'cursor-default'
                  }`}
                >
                  {open ? (
                    <ChevronDown className="h-3 w-3 opacity-45" strokeWidth={2} />
                  ) : (
                    <ChevronRight className="h-3 w-3 opacity-45" strokeWidth={2} />
                  )}
                </button>
              ) : null}
              <ToolCancelButton block={block} processing={processing} onCancelToolCall={onCancelToolCall} />
            </div>
            {open ? (
              detail.kind === 'assistant' ? (
                <div className="ml-1 mt-1">
                  <ProcessEntryDetail
                    block={block}
                    detail={detail}
                    processing={processing}
                    allowThreadActions={allowThreadActions}
                  />
                </div>
              ) : (
                <div className="ds-work-timeline-detail ml-1">
                  <ProcessEntryDetail
                    block={block}
                    detail={detail}
                    processing={processing}
                    allowThreadActions={allowThreadActions}
                  />
                </div>
              )
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

/**
 * A compaction (manual `/compact` or automatic context fold) is a durable
 * timeline event, not a generic tool row: it renders as a full-width divider
 * with its own status icon, trigger source, released-context meta line, and an
 * optional expandable summary so the folded context stays reviewable.
 */
export function CompactionTimelineEntry({
  block,
  processing
}: {
  block: Extract<ChatBlock, { kind: 'compaction' }>
  processing: boolean
}): ReactElement {
  const { t } = useTranslation('common')
  const [userOpen, setUserOpen] = useState<boolean | null>(null)

  const isRunning = block.status === 'running'
  const isError = block.status === 'error'
  // `auto === false` means the user explicitly ran `/compact`; absent/true is
  // loop-triggered (automatic) compaction per the runtime contract.
  const isAuto = block.auto !== false
  const summary = block.summary?.trim() ?? ''
  const detail = block.detail?.trim() ?? ''
  const hasDetails = Boolean(summary || detail)
  // Live animation/expansion only while the turn is actually processing.
  const live = processing && isRunning
  // While a compaction runs it stays open so the live summary is visible;
  // once settled the record collapses back into the timeline by default.
  const forceOpen = live && hasDetails
  const open = hasDetails && (forceOpen || (userOpen ?? false))
  const canToggle = hasDetails && !forceOpen

  const Icon = isRunning ? LoaderCircle : isError ? CircleAlert : CheckCircle2
  const title = isRunning
    ? t('compactionRunning')
    : isError
      ? t('compactionFailed')
      : isAuto
        ? t('compactionAutoCompleted')
        : t('compactionManualCompleted')
  const meta = compactionMetaText(block, t)
  const iconTone = isRunning
    ? 'text-accent'
    : isError
      ? 'text-ds-danger'
      : 'text-ds-success'

  const handleToggle = (): void => {
    if (!canToggle) return
    setUserOpen((value) => !(value ?? false))
  }
  const handleToggleButton = (event: ReactMouseEvent<HTMLButtonElement>): void => {
    event.stopPropagation()
    handleToggle()
  }
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (!canToggle) return
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    handleToggle()
  }

  return (
    <div
      role={canToggle ? 'button' : undefined}
      tabIndex={canToggle ? 0 : undefined}
      aria-expanded={canToggle ? open : undefined}
      onClick={handleToggle}
      onKeyDown={handleKeyDown}
      data-compaction-timeline-entry="true"
      className={`group w-full border-y border-ds-border-muted px-2 py-2.5 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/25 ${
        canToggle ? 'cursor-pointer hover:bg-ds-hover/45' : 'cursor-default'
      }`}
    >
      <div className="flex min-w-0 items-start gap-2.5">
        <span
          className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-ds-border-muted bg-ds-card/70 ${iconTone}`}
        >
          <Icon
            className={`h-3.5 w-3.5 ${live ? 'animate-spin' : ''}`}
            strokeWidth={1.9}
          />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
            <span
              role={live ? 'status' : undefined}
              aria-live={live ? 'polite' : undefined}
              className={`min-w-0 text-[13.5px] font-semibold leading-6 ${
                isError ? 'text-ds-danger' : 'text-ds-ink'
              }`}
            >
              {title}
            </span>
            <span className="inline-flex items-center rounded-md border border-ds-border-muted bg-ds-card/75 px-1.5 py-0.5 text-[11px] font-medium text-ds-faint">
              {isAuto ? t('compactionTriggerAuto') : t('compactionTriggerManual')}
            </span>
          </span>
          {meta ? (
            <span className="mt-0.5 block truncate text-[12px] leading-5 text-ds-faint">
              {meta}
            </span>
          ) : null}
        </span>
        {canToggle ? (
          <button
            type="button"
            aria-label={open ? t('processCollapseDetail') : t('processExpandDetail')}
            aria-expanded={open}
            onClick={handleToggleButton}
            className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition hover:bg-ds-hover/70"
          >
            {open ? (
              <ChevronDown className="h-3 w-3 opacity-45" strokeWidth={2} />
            ) : (
              <ChevronRight className="h-3 w-3 opacity-45" strokeWidth={2} />
            )}
          </button>
        ) : null}
      </div>
      {open ? (
        <div className="ds-work-timeline-detail ml-9 mt-1.5">
          {summary ? (
            <div className="flex flex-col gap-0.5">
              <span className="text-[11px] font-medium uppercase tracking-wide text-ds-faint">
                {t('compactionSummaryLabel')}
              </span>
              <p className="whitespace-pre-wrap text-[13px] leading-6 text-ds-muted">{summary}</p>
            </div>
          ) : null}
          {detail ? (
            <p className="mt-1 whitespace-pre-wrap text-[12.5px] leading-5 text-ds-faint">{detail}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function compactionMetaText(
  block: Extract<ChatBlock, { kind: 'compaction' }>,
  t: (key: string, opts?: Record<string, unknown>) => string
): string | null {
  if (block.status !== 'success') return null
  if (
    typeof block.messagesBefore === 'number' &&
    typeof block.messagesAfter === 'number'
  ) {
    return t('compactionMessagesReduced', {
      before: block.messagesBefore,
      after: block.messagesAfter
    })
  }
  // `messagesBefore` carries the folded (released) token estimate. Only render
  // a concrete number when the runtime reported one.
  const releasedTokens = typeof block.messagesBefore === 'number' ? block.messagesBefore : 0
  if (releasedTokens > 0) {
    return t('compactionReleasedTokens', { tokens: releasedTokens.toLocaleString() })
  }
  return null
}

/** One line inside an execution section. */
function ProcessEntryRow({
  block,
  processing,
  workspaceRoot,
  onCancelToolCall,
  allowThreadActions = true
}: {
  block: ChatBlock
  processing: boolean
  workspaceRoot: string
  onCancelToolCall?: (block: ToolBlock) => Promise<boolean>
  allowThreadActions?: boolean
}): ReactElement {
  const { t } = useTranslation('common')
  const [userOpen, setUserOpen] = useState<boolean | null>(null)
  const summary = describeProcessBlock(block, t)
  const detail = getProcessDetail(block, summary)
  const canExpand = detail.kind !== 'none'
  const isAssistantProcessText = block.kind === 'assistant'
  const isAutoOpenPending = processBlockIsAutoOpenPending(block, processing) || isPendingApproval(block)
  const isStreamingAssistant = processing && block.kind === 'assistant' && block.id === 'live-assistant'
  const errorTone = processBlockErrorTone(block)
  const isError = errorTone !== null
  const forceOpen = isAutoOpenPending || isAssistantProcessText || isStreamingAssistant
  // A tool failure should not interrupt the live process by expanding its
  // often verbose result. Runtime errors still open so they are not hidden.
  const defaultOpen = processing && isError && block.kind !== 'tool'
  const open =
    canExpand &&
    (forceOpen || (userOpen ?? defaultOpen))

  const { verb, rest } = splitVerb(summary)
  const rowActive = isAutoOpenPending || isStreamingAssistant
  const wrapSummary = (block.kind === 'system' && !canExpand) || isAssistantProcessText
  const canToggle = canExpand && !forceOpen
  const RowIcon = processBlockIcon(block)
  const isBackgroundSubagent = isBackgroundSubagentNoticeBlock(block)
  const showInlineGeneratedMedia = processing && processBlockHasGeneratedMedia(block)
  const handleToggle = (): void => {
    if (!canToggle) return
    setUserOpen(!open)
  }
  const handleToggleButton = (event: ReactMouseEvent<HTMLButtonElement>): void => {
    event.stopPropagation()
    handleToggle()
  }
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (!canToggle) return
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    handleToggle()
  }

  return (
    <div className="flex flex-col">
      <div
        role={canToggle ? 'button' : undefined}
        tabIndex={canToggle ? 0 : undefined}
        aria-expanded={canToggle ? open : undefined}
        onClick={handleToggle}
        onKeyDown={handleKeyDown}
        className={`group flex w-full text-left text-[13.5px] leading-[1.55] transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/25 ${
          isBackgroundSubagent
            ? 'items-center gap-2.5 rounded-[12px] border border-ds-border bg-ds-card/55 px-3 py-2.5 shadow-[0_2px_10px_rgba(42,52,72,0.035)]'
            : 'items-start gap-2 rounded-md px-2 py-1'
        } ${
          isError
            ? processErrorTextClass(errorTone)
            : 'text-ds-faint hover:text-ds-ink'
        } ${
          canToggle
            ? `cursor-pointer ${isBackgroundSubagent ? 'hover:border-ds-border-strong hover:bg-ds-card' : 'hover:bg-ds-hover/70'}`
            : 'cursor-default'
        }`}
      >
        {RowIcon ? (
          <ProcessGlyph Icon={RowIcon} className="mt-1" />
        ) : null}
        {isBackgroundSubagent && block.kind === 'user' ? (
          <BackgroundSubagentRowSummary block={block} />
        ) : (
          <span
            role={block.kind === 'compaction' && block.status === 'running' ? 'status' : undefined}
            aria-live={block.kind === 'compaction' && block.status === 'running' ? 'polite' : undefined}
            data-compaction-timeline-entry={block.kind === 'compaction' ? 'true' : undefined}
            className={`min-w-0 flex-1 ${wrapSummary ? 'whitespace-pre-wrap break-words' : 'truncate'} ${
              rowActive && !isError ? 'ds-shiny-text' : ''
            }`}
          >
            <span
              className={`font-medium ${isError ? '' : rowActive ? '' : 'text-ds-muted'}`}
            >
              {verb}
            </span>
            {rest ? (
              <span className="ml-1.5 font-mono text-[13px]">
                <ProcessSummaryText block={block} summary={rest} workspaceRoot={workspaceRoot} />
              </span>
            ) : null}
          </span>
        )}
        {canExpand ? (
          <button
            type="button"
            aria-label={open ? t('processCollapseDetail') : t('processExpandDetail')}
            aria-expanded={open}
            disabled={!canToggle}
            onClick={handleToggleButton}
            className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition ${
              canToggle ? 'cursor-pointer hover:bg-ds-hover/70' : 'cursor-default'
            }`}
          >
            {open ? (
              <ChevronDown className="h-3 w-3 opacity-45" strokeWidth={2} />
            ) : (
              <ChevronRight className="h-3 w-3 opacity-45" strokeWidth={2} />
            )}
          </button>
        ) : null}
        <ToolCancelButton block={block} processing={processing} onCancelToolCall={onCancelToolCall} />
      </div>
      <RuntimeMetaBadges block={block} t={t} />
      {canExpand && open ? (
        detail.kind === 'assistant' ? (
          <div className="mt-1">
            <ProcessEntryDetail
              block={block}
              detail={detail}
              processing={processing}
              allowThreadActions={allowThreadActions}
            />
          </div>
        ) : (
          <div className="ds-work-timeline-detail">
            <ProcessEntryDetail
              block={block}
              detail={detail}
              processing={processing}
              allowThreadActions={allowThreadActions}
            />
          </div>
        )
      ) : null}
      {showInlineGeneratedMedia ? (
        <div className="ml-2 mt-2">
          <GeneratedFilesPanel blocks={[block]} placement="timeline" />
        </div>
      ) : null}
    </div>
  )
}

function ProcessGlyph({
  Icon,
  className = 'mt-0.5'
}: {
  Icon: LucideIcon
  className?: string
}): ReactElement {
  return <Icon className={`${className} h-3.5 w-3.5 shrink-0 opacity-75`} strokeWidth={1.9} />
}

export function describeProcessSection(
  section: ProcessSection,
  t: (key: string, opts?: Record<string, unknown>) => string,
  opts: {
    processing: boolean
    reasoningDurationMs?: number
    singleReasoningSection: boolean
  }
): string {
  if (section.kind === 'reasoning') {
    if (opts.processing && processSectionHasActiveWork(section, true)) {
      return t('thinkingNow')
    }
    if (
      opts.singleReasoningSection &&
      typeof opts.reasoningDurationMs === 'number' &&
      opts.reasoningDurationMs >= 1000
    ) {
      return t('thoughtFor', { duration: formatDuration(opts.reasoningDurationMs) })
    }
    return section.blocks.length > 1
      ? t('thoughtSteps', { count: section.blocks.length })
      : t('thinkingLabel')
  }

  if (section.kind === 'output') {
    return t('processTextLabel')
  }

  if (opts.processing && processSectionHasActiveWork(section, true)) {
    const activeBlock = [...section.blocks].reverse().find(
      (block) =>
        block.id === 'live-reasoning' ||
        block.id === 'live-assistant' ||
        blockHasPendingRuntimeWork(block)
    )
    const phase = activeBlock
      ? activeBlock.kind === 'reasoning'
        ? t('thinkingNow')
        : activeBlock.kind === 'tool'
          ? t('workingToolAction', { action: summarizeToolBlock(activeBlock, t) })
          : describeProcessBlock(activeBlock, t)
      : t('processing')
    const workSummary = summarizeProcessWork(section.blocks, t)
    return workSummary ? `${phase} · ${workSummary}` : phase
  }

  if (section.blocks.length === 1) {
    return describeProcessBlock(section.blocks[0], t)
  }

  return summarizeProcessWork(section.blocks, t) || t('processSteps', { count: section.blocks.length })
}

/** A compact, activity-based recap for a collapsed process phase. */
export function summarizeProcessWork(
  blocks: ChatBlock[],
  t: (key: string, opts?: Record<string, unknown>) => string
): string {
  let readCount = 0
  let searchCount = 0
  let fileCount = 0
  let commandCount = 0
  let backgroundCommandCount = 0
  let toolCount = 0
  let approvalCount = 0

  for (const block of blocks) {
    if (block.kind === 'approval' || block.kind === 'approval_review') {
      approvalCount += 1
      continue
    }
    if (block.kind !== 'tool') continue
    if (block.toolKind === 'file_change') {
      fileCount += 1
    } else if (block.toolKind === 'command_execution') {
      if (isBackgroundShellCommandBlock(block)) {
        backgroundCommandCount += 1
      } else {
        commandCount += 1
      }
    } else if (isReadToolBlock(block)) {
      readCount += 1
    } else if (isSearchToolBlock(block)) {
      searchCount += 1
    } else {
      toolCount += 1
    }
  }

  const parts: string[] = []
  if (readCount > 0) {
    parts.push(readCount === 1 ? t('groupReadFile') : t('groupReadFiles', { count: readCount }))
  }
  if (searchCount > 0) {
    parts.push(searchCount === 1 ? t('groupSearchedOnce') : t('groupSearched', { count: searchCount }))
  }
  if (fileCount > 0) {
    parts.push(
      fileCount === 1 ? t('groupEditedFile') : t('groupEditedFiles', { count: fileCount })
    )
  }
  if (backgroundCommandCount > 0) {
    parts.push(
      backgroundCommandCount === 1
        ? t('groupRanBackgroundCommand')
        : t('groupRanBackgroundCommands', { count: backgroundCommandCount })
    )
  }
  if (commandCount > 0) {
    parts.push(
      commandCount === 1
        ? t('groupRanCommand')
        : t('groupRanCommands', { count: commandCount })
    )
  }
  if (toolCount > 0) {
    parts.push(toolCount === 1 ? t('groupUsedTool') : t('groupUsedTools', { count: toolCount }))
  }
  if (approvalCount > 0) {
    parts.push(
      approvalCount === 1 ? t('groupApproval') : t('groupApprovals', { count: approvalCount })
    )
  }

  return parts.join(' · ')
}

function isReadToolBlock(block: ToolBlock): boolean {
  const toolName = toolNameForBlock(block)
  return toolName === 'read' || toolName === 'read_file'
}

function isSearchToolBlock(block: ToolBlock): boolean {
  const toolName = toolNameForBlock(block)
  return (
    toolName === 'grep' ||
    toolName === 'grep_files' ||
    toolName === 'search' ||
    toolName === 'search_files' ||
    toolName === 'find'
  )
}

function processSectionIcon(section: ProcessSection): LucideIcon | null {
  if (section.kind === 'reasoning') return Brain
  if (section.kind === 'output') return MessageSquareQuote

  const toolIcons = section.blocks
    .map(processBlockIcon)
    .filter((icon): icon is LucideIcon => icon !== null)
  if (toolIcons.length === 0) return null
  const [first] = toolIcons
  return toolIcons.every((icon) => icon === first) ? first : Wrench
}

function processBlockIcon(block: ChatBlock): LucideIcon | null {
  if (block.kind === 'reasoning') return Brain
  if (block.kind === 'assistant') return MessageSquareQuote
  if (block.kind === 'compaction') return Minimize2
  if (block.kind === 'approval') return Wrench
  if (block.kind === 'approval_review') return Bot
  if (block.kind === 'user_input') return MessageSquareQuote
  if (isBackgroundShellNoticeBlock(block)) return BellRing
  if (isBackgroundSubagentNoticeBlock(block)) return Sparkles
  if (block.kind !== 'tool') return null
  return toolBlockIcon(block)
}

function toolBlockIcon(block: ToolBlock): LucideIcon {
  const toolName = toolNameForBlock(block)
  switch (toolName) {
    case 'bash':
    case 'shell':
    case 'terminal':
    case 'run_command':
    case 'exec':
      return Terminal
    case 'read':
    case 'read_file':
      return BookOpen
    case 'write':
    case 'write_file':
    case 'edit':
    case 'edit_file':
    case 'apply_patch':
    case 'create_file':
      return PencilLine
    case 'grep':
    case 'grep_files':
    case 'search':
    case 'search_files':
    case 'find':
      return Search
    case 'ls':
    case 'list':
    case 'list_dir':
      return FolderOpen
    case 'create_plan':
    case 'update_plan':
      return ListTodo
    default:
      break
  }

  if (block.toolKind === 'command_execution') return Terminal
  if (block.toolKind === 'file_change') return PencilLine
  return Wrench
}

function toolNameForBlock(block: ToolBlock): string {
  const rawSummary = block.summary?.trim() ?? ''
  return (extractToolName(rawSummary) || readMetaString(block.meta, 'toolName') || '').toLowerCase()
}

function splitVerb(summary: string): { verb: string; rest: string } {
  const trimmed = summary.trim()
  if (!trimmed) return { verb: '', rest: '' }
  const space = trimmed.search(/\s/)
  if (space < 0) return { verb: trimmed, rest: '' }
  return { verb: trimmed.slice(0, space), rest: trimmed.slice(space + 1).trim() }
}

function toolFilePath(block: ToolBlock): string | undefined {
  const sourceText = [block.summary, block.detail ?? ''].filter(Boolean).join('\n')
  return (
    block.filePath ||
    extractQuotedField(sourceText, 'path') ||
    extractQuotedField(sourceText, 'file_path') ||
    extractQuotedField(sourceText, 'file')
  )
}

function ProcessFileReference({
  path,
  workspaceRoot,
  children
}: {
  path: string
  workspaceRoot: string
  children: string
}): ReactElement {
  const { t } = useTranslation('common')

  const stopRowToggle = (event: ReactMouseEvent<HTMLElement>): void => {
    event.stopPropagation()
  }

  const preview = (event: ReactMouseEvent<HTMLButtonElement>): void => {
    event.preventDefault()
    event.stopPropagation()
    previewWorkspaceFile({ path, workspaceRoot })
  }

  const openInEditor = (event: ReactMouseEvent<HTMLButtonElement>): void => {
    event.preventDefault()
    event.stopPropagation()
    void openWorkspacePathInEditor({ path }, workspaceRoot).then((result) => {
      if (!result.ok) {
        void window.kunGui?.logError?.('editor-open', 'Failed to open process file reference', {
          message: result.message,
          target: { path, workspaceRoot }
        })?.catch(() => undefined)
      }
    })
  }

  return (
    <button
      type="button"
      className="ds-process-file-reference"
      title={t('processFileReferenceHint')}
      onClick={preview}
      onDoubleClick={openInEditor}
      onMouseDown={stopRowToggle}
    >
      {children}
    </button>
  )
}

function ProcessSummaryText({
  block,
  summary,
  workspaceRoot
}: {
  block: ChatBlock
  summary: string
  workspaceRoot: string
}): ReactElement {
  if (block.kind !== 'tool') return <>{summary}</>
  const path = toolFilePath(block)
  if (!path) return <>{summary}</>
  const index = summary.indexOf(path)
  if (index < 0) return <>{summary}</>
  const before = summary.slice(0, index)
  const after = summary.slice(index + path.length)
  return (
    <>
      {before}
      <ProcessFileReference path={path} workspaceRoot={workspaceRoot}>{path}</ProcessFileReference>
      {after}
    </>
  )
}

type ProcessDetail =
  | { kind: 'none' }
  | { kind: 'reasoning'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'tool'; text: string; isPatch: boolean; isError: boolean; filePath?: string }
  | { kind: 'approval' }
  | { kind: 'approval_review' }
  | { kind: 'user_input' }
  | { kind: 'background_shell' }
  | { kind: 'background_subagent' }
  | { kind: 'text'; text: string }

function summarizeProcessText(text: string, max = 96): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  if (!oneLine) return ''
  if (oneLine.length <= max) return oneLine
  return `${oneLine.slice(0, max - 1).trimEnd()}…`
}

function humanizeToolName(name: string): string {
  const trimmed = name.trim().replace(/[_-]+/g, ' ')
  if (!trimmed) return ''
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1)
}

function builtInToolLabel(
  toolName: string,
  t: (key: string, opts?: Record<string, unknown>) => string
): string | undefined {
  switch (toolName) {
    case 'read':
    case 'read_file':
      return t('toolBuiltinRead')
    case 'write':
    case 'write_file':
      return t('toolBuiltinWrite')
    case 'edit':
    case 'edit_file':
      return t('toolBuiltinEdit')
    case 'grep':
    case 'grep_files':
    case 'search_files':
      return t('toolBuiltinGrep')
    case 'find':
      return t('toolBuiltinFind')
    case 'ls':
      return t('toolBuiltinLs')
    case 'bash':
    case 'shell':
      return t('toolBuiltinBash')
    case 'background_shell':
      return t('toolBuiltinBackgroundShell', { defaultValue: 'Background shell' })
    case 'delegate_task':
    case 'generate_subagent':
      // Routed to SubagentCallCard before the generic row; labeled here as a
      // defensive fallback so an ungrouped delegate block never reads as raw JSON.
      return t('toolBuiltinDelegate')
    case 'design_component':
      return t('toolBuiltinDesignComponent')
    default:
      return undefined
  }
}

function extractToolName(summary: string): string {
  const match = summary.trim().match(/^([a-z0-9_-]+)\s*:/i)
  return match?.[1] ?? ''
}

function extractQuotedField(text: string, field: string): string | undefined {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const attr = new RegExp(`${escaped}="([^"]+)"`, 'i').exec(text)
  if (attr?.[1]) return attr[1]
  const json = new RegExp(`"${escaped}"\\s*:\\s*"([^"]+)"`, 'i').exec(text)
  if (json?.[1]) return json[1]
  return undefined
}

function readMetaString(meta: Record<string, unknown> | undefined, key: string): string | undefined {
  if (!meta) return undefined
  const value = meta[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function readMetaStringArray(meta: Record<string, unknown> | undefined, key: string): string[] {
  const value = meta?.[key]
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
}

function readMetaInstructionSources(meta: Record<string, unknown> | undefined): Array<{ path: string; scope: string }> {
  const value = meta?.injectedInstructionSources
  if (!Array.isArray(value)) return []
  return value
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null
      const raw = entry as Record<string, unknown>
      const path = typeof raw.path === 'string' && raw.path.trim() ? raw.path.trim() : ''
      const scope = typeof raw.scope === 'string' && raw.scope.trim() ? raw.scope.trim() : ''
      return path ? { path, scope } : null
    })
    .filter((entry): entry is { path: string; scope: string } => entry !== null)
}

function readMetaSources(meta: Record<string, unknown> | undefined): Array<{ title?: string; url?: string }> {
  const value = meta?.sources
  if (!Array.isArray(value)) return []
  return value
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null
      const raw = entry as Record<string, unknown>
      const title = typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : undefined
      const url = typeof raw.url === 'string' && raw.url.trim() ? raw.url.trim() : undefined
      return title || url ? { ...(title ? { title } : {}), ...(url ? { url } : {}) } : null
    })
    .filter((entry): entry is { title?: string; url?: string } => entry !== null)
}

function RuntimeMetaBadges({
  block,
  t
}: {
  block: ChatBlock
  t: (key: string, opts?: Record<string, unknown>) => string
}): ReactElement | null {
  const meta = block.kind === 'tool' || block.kind === 'approval' || block.kind === 'user' ? block.meta : undefined
  if (!meta) return null
  const showTurnDisclosure = block.kind !== 'tool'
  const sources = readMetaSources(meta)
  const attachmentIds = showTurnDisclosure ? readMetaStringArray(meta, 'attachmentIds') : []
  const activeSkillIds = showTurnDisclosure ? readMetaStringArray(meta, 'activeSkillIds') : []
  const injectedMemoryIds = showTurnDisclosure ? readMetaStringArray(meta, 'injectedMemoryIds') : []
  const injectedInstructionSources = showTurnDisclosure ? readMetaInstructionSources(meta) : []
  const child = meta.child && typeof meta.child === 'object' ? meta.child as Record<string, unknown> : null
  const childLabel =
    typeof child?.childLabel === 'string' && child.childLabel.trim()
      ? child.childLabel.trim()
      : typeof child?.childProfile === 'string' && child.childProfile.trim()
        ? child.childProfile.trim()
        : typeof child?.childId === 'string'
          ? child.childId
          : ''
  if (
    sources.length === 0 &&
    attachmentIds.length === 0 &&
    activeSkillIds.length === 0 &&
    injectedMemoryIds.length === 0 &&
    injectedInstructionSources.length === 0 &&
    !childLabel
  ) {
    return null
  }
  const chipClass = 'inline-flex max-w-full items-center gap-1 rounded-md border border-ds-border-muted bg-ds-card/75 px-1.5 py-0.5 text-[11px] font-medium text-ds-faint'
  return (
    <div className="ml-7 mt-1 flex min-w-0 flex-wrap gap-1.5">
      {childLabel ? (
        <span className={chipClass} title={childLabel}>
          <span>{t('toolChildAgent')}</span>
          <span className="max-w-28 truncate font-mono text-ds-muted">{childLabel}</span>
        </span>
      ) : null}
      {activeSkillIds.length > 0 ? (
        <span className={chipClass} title={activeSkillIds.join(', ')}>
          {t('toolActiveSkills')} {activeSkillIds.length}
        </span>
      ) : null}
      {injectedMemoryIds.length > 0 ? (
        <InjectedMemoryMetaChip meta={meta} memoryIds={injectedMemoryIds} chipClass={chipClass} />
      ) : null}
      {injectedInstructionSources.length > 0 ? (
        <span className={chipClass} title={injectedInstructionSources.map((source) => `${source.scope}: ${source.path}`).join('\n')}>
          {t('toolInjectedInstructions')} {injectedInstructionSources.length}
        </span>
      ) : null}
      {attachmentIds.length > 0 ? (
        <span className={chipClass} title={attachmentIds.join(', ')}>
          {t('toolAttachments')} {attachmentIds.length}
        </span>
      ) : null}
      {sources.slice(0, 4).map((source, index) =>
        source.url ? (
          <a
            key={`${source.url}-${index}`}
            href={source.url}
            target="_blank"
            rel="noreferrer"
            className={chipClass}
            title={source.url}
          >
            {t('toolSources')} {index + 1}
            <span className="max-w-32 truncate text-ds-muted">{source.title || source.url}</span>
          </a>
        ) : (
          <span key={`${source.title}-${index}`} className={chipClass} title={source.title}>
            {t('toolSources')} {index + 1}
          </span>
        )
      )}
    </div>
  )
}

export function summarizeToolBlock(
  block: ToolBlock,
  t: (key: string, opts?: Record<string, unknown>) => string
): string {
  const rawSummary = block.summary?.trim() ?? ''
  const toolName = toolNameForBlock(block)
  const label = builtInToolLabel(toolName, t) || humanizeToolName(toolName) || formatToolTitle(block, t)
  const sourceText = [rawSummary, block.detail ?? ''].filter(Boolean).join('\n')
  const filePath = toolFilePath(block)
  const pattern =
    extractQuotedField(sourceText, 'pattern') ||
    extractQuotedField(sourceText, 'query') ||
    readMetaString(block.meta, 'pattern')
  const command = readMetaString(block.meta, 'command')

  if (toolName === 'background_shell') {
    return summarizeBackgroundShellToolBlock(block, t)
  }

  if (toolName === 'explore_agent') {
    const payload = parseToolBlockPayload(block)
    const title =
      (typeof payload.title === 'string' && payload.title.trim() ? payload.title.trim() : undefined) ||
      (block.meta?.child && typeof block.meta.child === 'object'
        ? (typeof (block.meta.child as { childLabel?: unknown }).childLabel === 'string'
          ? (block.meta.child as { childLabel: string }).childLabel.trim()
          : undefined)
        : undefined)
    if (title) return `${label} ${summarizeProcessText(title, 72)}`
    return label
  }

  if ((toolName === 'read_file' || toolName === 'read') && filePath) {
    return `${label} ${filePath}`
  }
  if ((toolName === 'write' || toolName === 'edit' || toolName === 'write_file' || toolName === 'edit_file') && filePath) {
    return `${label} ${filePath}`
  }
  if ((toolName === 'grep_files' || toolName === 'search_files' || toolName === 'grep' || toolName === 'find') && pattern) {
    return filePath ? `${label} ${pattern} · ${filePath}` : `${label} ${pattern}`
  }
  if (toolName === 'ls' && filePath) {
    return `${label} ${filePath}`
  }
  if (command && block.toolKind === 'command_execution') {
    const action = isBackgroundShellCommandBlock(block)
      ? t('toolActionBackgroundCommand')
      : formatToolTitle(block, t)
    return `${action} ${summarizeProcessText(command, 72)}`
  }
  if (filePath) {
    return `${label} ${filePath}`
  }
  if (pattern) {
    return `${label} ${pattern}`
  }
  if (rawSummary) {
    const compact = toolName ? rawSummary.replace(/^([a-z0-9_-]+)\s*:\s*/i, '') : rawSummary
    const summary = summarizeProcessText(compact, 72)
    if (summary && normalizeProcessText(summary) === normalizeProcessText(label)) {
      return label
    }
    return summary ? `${label} ${summary}` : label
  }
  return label
}

function normalizeProcessText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase()
}

function getProcessDetail(block: ChatBlock, summaryText?: string): ProcessDetail {
  if (block.kind === 'reasoning') {
    return block.text.trim() ? { kind: 'reasoning', text: block.text } : { kind: 'none' }
  }
  if (block.kind === 'assistant') {
    const split = splitThink(block.text)
    const text = split.content || split.think
    return text.trim() ? { kind: 'assistant', text } : { kind: 'none' }
  }
  if (block.kind === 'tool') {
    const detailText = block.detail?.trim() ?? ''
    if (!detailText) return { kind: 'none' }
    if (summaryText && normalizeProcessText(detailText) === normalizeProcessText(summaryText)) {
      return { kind: 'none' }
    }
    const isError = block.status === 'error'
    const patchText =
      block.toolKind === 'file_change' && !isError
        ? extractUnifiedDiffText(detailText)
        : undefined
    return {
      kind: 'tool',
      text: patchText ?? block.detail!,
      isPatch: patchText !== undefined,
      isError,
      filePath: block.filePath
    }
  }
  if (block.kind === 'compaction') {
    const detailText = block.detail?.trim() ?? ''
    if (!detailText) return { kind: 'none' }
    if (summaryText && normalizeProcessText(detailText) === normalizeProcessText(summaryText)) {
      return { kind: 'none' }
    }
    return { kind: 'text', text: detailText }
  }
  if (block.kind === 'approval') return { kind: 'approval' }
  if (block.kind === 'approval_review') return { kind: 'approval_review' }
  if (block.kind === 'user_input') return { kind: 'user_input' }
  if (isBackgroundShellNoticeBlock(block)) return { kind: 'background_shell' }
  if (isBackgroundSubagentNoticeBlock(block)) return { kind: 'background_subagent' }
  if (block.kind === 'system' && block.text.trim()) {
    if (block.detail?.trim()) return { kind: 'text', text: block.detail }
    // Short system messages already fit in the summary line — skip the
    // expand affordance so we don't duplicate the same string.
    if (block.text.length <= 140) return { kind: 'none' }
    return { kind: 'text', text: block.text }
  }
  return { kind: 'none' }
}

function ProcessEntryDetail({
  block,
  detail,
  processing,
  allowThreadActions = true
}: {
  block: ChatBlock
  detail: ProcessDetail
  processing: boolean
  allowThreadActions?: boolean
}): ReactElement | null {
  if (detail.kind === 'reasoning') {
    const streamReason = block.id === 'live-reasoning' && processing
    return (
      <div className="ds-markdown text-[13.5px] leading-6 text-ds-muted">
        <AssistantMarkdown text={detail.text} streaming={streamReason} hideHtmlComments />
      </div>
    )
  }
  if (detail.kind === 'assistant') {
    return (
      <div className="ds-markdown text-[13.5px] leading-6 text-ds-ink">
        <AssistantMarkdown
          text={detail.text}
          streaming={processing && block.kind === 'assistant' && block.id === 'live-assistant'}
        />
      </div>
    )
  }
  if (detail.kind === 'tool') {
    if (detail.isPatch) {
      return <DiffView patch={detail.text} filePath={detail.filePath} />
    }
    if (detail.isError) {
      return (
        <div className="overflow-hidden rounded-[10px] border border-orange-200/80 bg-orange-50/80 dark:border-orange-800/40 dark:bg-orange-500/10">
          {detail.filePath ? (
            <div className="border-b border-orange-200/70 bg-orange-100/50 px-3 py-1.5 font-mono text-[12px] text-orange-700 dark:border-orange-800/40 dark:bg-orange-500/15 dark:text-orange-300">
              {detail.filePath}
            </div>
          ) : null}
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words px-3 py-2.5 font-mono text-[12px] leading-6 text-orange-900 dark:text-orange-100">
            {detail.text}
          </pre>
        </div>
      )
    }
    return (
      <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono text-[12px] leading-6 text-ds-ink">
        {detail.text}
      </pre>
    )
  }
  if (detail.kind === 'text') {
    return <p className="whitespace-pre-wrap text-[13.5px] leading-6 text-ds-muted">{detail.text}</p>
  }
  if (detail.kind === 'approval' && block.kind === 'approval') {
    return <MessageBubble block={block} nested allowThreadActions={allowThreadActions} />
  }
  if (detail.kind === 'approval_review' && block.kind === 'approval_review') {
    return <MessageBubble block={block} nested allowThreadActions={false} />
  }
  if (detail.kind === 'user_input' && block.kind === 'user_input') {
    return <MessageBubble block={block} nested allowThreadActions={allowThreadActions} />
  }
  if ((detail.kind === 'background_shell' || detail.kind === 'background_subagent') && block.kind === 'user') {
    return <MessageBubble block={block} nested allowThreadActions={allowThreadActions} />
  }
  return null
}

function describeProcessBlock(
  block: ChatBlock,
  t: (key: string, opts?: Record<string, unknown>) => string
): string {
  if (block.kind === 'reasoning') {
    return t('thinkingLabel')
  }
  if (block.kind === 'assistant') {
    return t('processTextLabel')
  }
  if (block.kind === 'tool') {
    return summarizeToolBlock(block, t)
  }
  if (block.kind === 'user' && isBackgroundShellNoticeBlock(block)) {
    return block.meta?.displayText?.trim() || t('backgroundShellNotice.title', { defaultValue: 'Background shell completed' })
  }
  if (block.kind === 'user' && isBackgroundSubagentNoticeBlock(block)) {
    return block.meta?.displayText?.trim() || t('backgroundSubagentNotice.title', { defaultValue: 'Background subagent completed' })
  }
  if (block.kind === 'compaction') {
    if (block.status === 'running') return t('compactionRunning')
    if (block.status === 'error') return block.summary || t('compactionFailed')
    if (typeof block.messagesBefore === 'number' && typeof block.messagesAfter === 'number') {
      return t('compactionCompletedWithCounts', {
        before: block.messagesBefore,
        after: block.messagesAfter
      })
    }
    // `messagesBefore` carries the folded (released) token estimate. When known,
    // show it so a manual compaction reads as a concrete, attributable action.
    const releasedTokens = typeof block.messagesBefore === 'number' ? block.messagesBefore : 0
    if (releasedTokens > 0) {
      const tokens = releasedTokens.toLocaleString()
      return block.auto === true
        ? t('compactionAutoCompletedWithTokens', { tokens })
        : t('compactionManualCompletedWithTokens', { tokens })
    }
    return block.auto === true ? t('compactionAutoCompleted') : t('compactionManualCompleted')
  }
  if (block.kind === 'approval') {
    return block.summary || t('approvalTitle')
  }
  if (block.kind === 'approval_review') {
    if (block.status === 'in-progress') return t('approvalReviewInProgress')
    return block.summary || t('approvalReviewTitle')
  }
  if (block.kind === 'user_input') {
    return t('userInputTitle')
  }
  if (block.kind === 'system') {
    return block.text
  }
  return 'text' in block ? block.text : t('processed')
}
