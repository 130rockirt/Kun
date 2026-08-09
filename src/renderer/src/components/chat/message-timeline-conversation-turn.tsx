import { memo, useMemo, useState, type ReactElement, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import type { ChatBlock, RuntimeChildActivity, ToolBlock } from '../../agent/types'
import { formatChildActivityLabel } from './explore-peek-summary'
import { useChatStore } from '../../store/chat-store'
import { deriveTurnSections } from './derive-turn-sections'
import { GeneratedFilesPanel, MessageBubble } from './message-timeline-bubbles'
import { PresentationFilesPanel } from './PresentationFilesPanel'
import { presentationFileArtifactsForTurn } from './presentation-file-artifacts'
import { ReviewPlanCard, ReviewSummaryCard, TurnChangeSummary, WorkMetaRow } from './message-timeline-cards'
import { ProcessSectionRow, groupProcessSections, summarizeProcessWork, summarizeToolBlock } from './message-timeline-process'
import { ComponentPrototypeCard } from './ComponentPrototypeCard'
import type { OpenChildThreadHandler } from './SubagentCallCard'
import {
  AnimatedWorkLogo,
  IKUN_WORK_LOGO_VARIANT_LABEL_KEYS,
  WORK_LOGO_SWIM_MODE_LABEL_KEYS,
  useIkunWorkLogoVariant,
  useWorkLogoSwimMode,
  type IkunWorkLogoVariant,
  type WorkLogoSwimMode
} from './AnimatedWorkLogo'
import type { UiPluginLabelKey } from '@shared/ui-plugin'
import { useUiPluginWorkLabel } from '../../store/ui-plugin-store'
import { sameTurnContent, splitThink, type Turn } from './message-timeline-turns'
import { extractPlanMetadataFromBlock } from '../../plan/plan-tool'
import { planDisplayNameFromRelativePath } from '../../plan/plan-path'
import type { PlanBuildOrchestration } from '../../plan/plan-build'
import { TimelineRuntimeError, liveTurnProgressClass } from './message-timeline-jump-preview'

export type ConversationTurnProps = {
  turn: Turn
  isProcessing: boolean
  liveReasoning: string
  live: string
  durationMs?: number
  reasoningDurationMs?: number
  devPreviewCard?: ReactElement | null
  planActionsBusy?: boolean
  graphEnabled?: boolean
  onBuildPlan?: (orchestration: PlanBuildOrchestration) => void
  onOpenPlan?: () => void
  onOpenChanges?: () => void
  onReviewChanges?: () => void
  reviewChangesDisabled?: boolean
  onOpenChildThread?: OpenChildThreadHandler
  onCancelToolCall?: (block: ToolBlock) => Promise<boolean>
  onComponentPrototypePrompt?: (prompt: string) => void
  filePreviewWorkspaceRoot: string
  viewportRef: RefObject<HTMLDivElement | null>
  compactCards?: boolean
  /** Main-thread actions must stay disabled for isolated side conversations. */
  allowMainThreadActions?: boolean
}

export function ConversationTurn({
  turn,
  isProcessing,
  liveReasoning,
  live,
  durationMs,
  reasoningDurationMs,
  devPreviewCard,
  planActionsBusy,
  graphEnabled = false,
  onBuildPlan,
  onOpenPlan,
  onOpenChanges,
  onReviewChanges,
  reviewChangesDisabled = false,
  onOpenChildThread,
  onCancelToolCall,
  onComponentPrototypePrompt,
  filePreviewWorkspaceRoot,
  viewportRef,
  compactCards = false,
  allowMainThreadActions = true
}: ConversationTurnProps): ReactElement {
  const { t } = useTranslation('common')
  const forkThreadFromTurn = useChatStore((s) => s.forkThreadFromTurn)
  const rollbackWorkspaceToCheckpoint = useChatStore((s) => s.rollbackWorkspaceToCheckpoint)
  const [forking, setForking] = useState(false)
  const [rollingBackCheckpointId, setRollingBackCheckpointId] = useState<string | null>(null)
  // Inline Review Plan card: surfaced under a turn that produced a
  // successful `create_plan` result so the user can open/build the plan
  // without leaving the conversation.
  const planResult = useMemo(() => {
    if (isProcessing) return null
    for (let index = turn.blocks.length - 1; index >= 0; index -= 1) {
      const block = turn.blocks[index]
      if (block.kind !== 'tool' || block.status !== 'success') continue
      const meta = extractPlanMetadataFromBlock(block)
      if (meta) return meta
    }
    return null
  }, [turn.blocks, isProcessing])
  const { think: liveThink, content: liveContent } = splitThink(live)
  const liveProcessText = [liveReasoning, liveThink].filter(Boolean).join('\n\n')
  const [workExpandedOverride, setWorkExpandedOverride] = useState<boolean | null>(null)

  const {
    processBlocks,
    assistantContentBlocks,
    runtimeErrorBlocks,
    componentPrototypeBlocks,
    generatedFileBlocks,
    turnFileChanges
  } = useMemo(
    () =>
      deriveTurnSections({
        turn,
        isProcessing,
        liveProcessText,
        liveContent,
        workspaceRoot: filePreviewWorkspaceRoot
      }),
    [turn, isProcessing, liveProcessText, liveContent, filePreviewWorkspaceRoot]
  )
  const presentationFiles = useMemo(
    () => presentationFileArtifactsForTurn(
      turn.blocks,
      filePreviewWorkspaceRoot,
      isProcessing,
      typeof window === 'undefined' ? '' : window.kunGui?.platform ?? ''
    ),
    [turn.blocks, filePreviewWorkspaceRoot, isProcessing]
  )
  const workProcessBlocks = processBlocks
  const workSummary = useMemo(
    () => summarizeProcessWork(workProcessBlocks, t),
    [t, workProcessBlocks]
  )
  const workExpanded = workExpandedOverride ?? false
  const reviewBlocks = useMemo(
    () => turn.blocks.filter((block) => block.kind === 'review'),
    [turn.blocks]
  )

  const processSections = useMemo(
    () => (isProcessing || workExpanded ? groupProcessSections(workProcessBlocks) : []),
    [isProcessing, workProcessBlocks, workExpanded]
  )
  const reasoningSectionCount = useMemo(
    () => processSections.filter((section) => section.kind === 'reasoning').length,
    [processSections]
  )
  const forkTurnId =
    turn.user?.turnId?.trim() ||
    [...assistantContentBlocks].reverse().find((block) => block.turnId?.trim())?.turnId?.trim() ||
    ''
  const forkActionBlockId =
    allowMainThreadActions && !isProcessing && forkTurnId
      ? assistantContentBlocks[assistantContentBlocks.length - 1]?.id
      : undefined
  const rollbackCheckpointId = turn.user?.meta?.workspaceCheckpointId?.trim() ?? ''
  const rollbackActionBlockId =
    allowMainThreadActions && !isProcessing && rollbackCheckpointId
      ? assistantContentBlocks[assistantContentBlocks.length - 1]?.id
      : undefined

  // During a live turn, assistant text, reasoning, and tools share one ordered
  // process timeline. Once complete, that timeline folds by default and only
  // the final assistant text remains outside it.

  const hasProcess =
    isProcessing ||
    workProcessBlocks.length > 0 ||
    (runtimeErrorBlocks.length > 0 && typeof durationMs === 'number')
  const showLiveProgress = isProcessing
  const liveToolBlock = useMemo(
    () => [...workProcessBlocks].reverse().find(
      (block): block is Extract<ChatBlock, { kind: 'tool' }> =>
        block.kind === 'tool' && block.status === 'running'
    ) ?? [...workProcessBlocks].reverse().find(
      (block): block is Extract<ChatBlock, { kind: 'tool' }> =>
        block.kind === 'tool'
    ),
    [workProcessBlocks]
  )
  const liveChildActivityLabel = useMemo(() => {
    if (!liveToolBlock) return undefined
    const child = liveToolBlock.meta?.child
    if (!child || typeof child !== 'object' || Array.isArray(child)) return undefined
    const activity = (child as {
      activity?: { phase?: RuntimeChildActivity['phase']; label?: string; toolName?: string; startedAt?: string; updatedAt?: string }
    }).activity
    if (!activity?.label?.trim()) return undefined
    return formatChildActivityLabel({
      phase: activity.phase ?? 'tool',
      label: activity.label.trim(),
      ...(activity.toolName?.trim() ? { toolName: activity.toolName.trim() } : {}),
      startedAt: activity.startedAt ?? '',
      updatedAt: activity.updatedAt ?? ''
    })
  }, [liveToolBlock])
  const showLiveThinking = Boolean(liveProcessText.trim()) && !liveChildActivityLabel && !liveToolBlock
  const forkFromTurn = async (): Promise<void> => {
    if (!allowMainThreadActions || !forkTurnId || forking) return
    setForking(true)
    try {
      await forkThreadFromTurn(forkTurnId)
    } finally {
      setForking(false)
    }
  }
  const rollbackWorkspace = async (checkpointId: string): Promise<void> => {
    const targetCheckpointId = checkpointId.trim()
    if (!allowMainThreadActions || !targetCheckpointId || rollingBackCheckpointId) return
    setRollingBackCheckpointId(targetCheckpointId)
    try {
      await rollbackWorkspaceToCheckpoint(targetCheckpointId)
    } finally {
      setRollingBackCheckpointId(null)
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {turn.user ? (
        <MessageBubble block={turn.user} allowThreadActions={allowMainThreadActions} />
      ) : null}

      {hasProcess ? (
        <div className="flex flex-col gap-1 pb-2">
          <WorkMetaRow
            processing={isProcessing}
            stepCount={workProcessBlocks.length}
            durationMs={durationMs}
            reasoningDurationMs={reasoningDurationMs}
            summary={workSummary}
            expanded={isProcessing || workExpanded}
            collapsible={!isProcessing && workProcessBlocks.length > 0}
            onToggle={() => setWorkExpandedOverride((value) => !(value ?? false))}
          />
          {processSections.length > 0 ? (
            <div className="flex flex-col gap-1">
              {processSections.map((section) => (
                <ProcessSectionRow
                  key={section.id}
                  section={section}
                  processing={isProcessing}
                  reasoningDurationMs={reasoningDurationMs}
                  singleReasoningSection={reasoningSectionCount === 1}
                  workspaceRoot={filePreviewWorkspaceRoot}
                  viewportRef={viewportRef}
                  onOpenChildThread={onOpenChildThread}
                  onCancelToolCall={onCancelToolCall}
                  allowThreadActions={allowMainThreadActions}
                />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {componentPrototypeBlocks.map((block) => (
        <ComponentPrototypeCard
          key={block.id}
          block={block}
          workspaceRoot={filePreviewWorkspaceRoot}
          onPrompt={onComponentPrototypePrompt}
        />
      ))}

      {assistantContentBlocks.map((block) => (
        <MessageBubble
          key={block.id}
          block={block}
          allowThreadActions={allowMainThreadActions}
          forkAction={
            block.id === forkActionBlockId
              ? {
                  busy: forking,
                  onFork: () => {
                    void forkFromTurn()
                  }
                }
              : undefined
          }
          rollbackAction={
            block.id === rollbackActionBlockId
              ? {
                  busy: rollingBackCheckpointId === rollbackCheckpointId,
                  onRollback: () => {
                    void rollbackWorkspace(rollbackCheckpointId)
                  }
                }
              : undefined
          }
        />
      ))}

      {!isProcessing ? (
        <GeneratedFilesPanel blocks={generatedFileBlocks} placement="turn" />
      ) : null}

      <PresentationFilesPanel files={presentationFiles} workspaceRoot={filePreviewWorkspaceRoot} />

      {reviewBlocks.map((review) => (
        <ReviewSummaryCard key={review.id} review={review} />
      ))}

      {runtimeErrorBlocks.map((block) => (
        <TimelineRuntimeError key={block.id} block={block} />
      ))}

      {!isProcessing && devPreviewCard ? devPreviewCard : null}

      {planResult ? (
        <ReviewPlanCard
          title={planResult.title?.trim() || planDisplayNameFromRelativePath(planResult.relativePath)}
          relativePath={planResult.relativePath}
          busy={planActionsBusy === true}
          graphEnabled={graphEnabled}
          onOpen={onOpenPlan}
          onBuild={onBuildPlan}
        />
      ) : null}

      {!isProcessing && turnFileChanges.length > 0 ? (
        <TurnChangeSummary
          changes={turnFileChanges}
          viewportRef={viewportRef}
          compact={compactCards}
          onOpenChanges={allowMainThreadActions ? onOpenChanges : undefined}
          onReviewChanges={allowMainThreadActions ? onReviewChanges : undefined}
          reviewChangesDisabled={reviewChangesDisabled}
        />
      ) : null}

      {showLiveProgress ? (
        <LiveTurnProgressRow
          tool={liveToolBlock}
          thinking={showLiveThinking}
          activityLabel={liveChildActivityLabel}
        />
      ) : null}
    </div>
  )
}

function LiveTurnProgressRow({
  tool,
  thinking,
  activityLabel
}: {
  tool?: Extract<ChatBlock, { kind: 'tool' }>
  thinking: boolean
  activityLabel?: string
}): ReactElement {
  const { t, i18n } = useTranslation('common')
  const swimMode = useWorkLogoSwimMode(true)
  const ikunVariant = useIkunWorkLogoVariant(true)
  // iKun 模式是全局 html 属性;进行行每个回合重新挂载,挂载时读取即可
  const [ikunModeOn] = useState(
    () =>
      typeof document !== 'undefined' &&
      document.documentElement.getAttribute('data-ikun-mode') === 'on'
  )
  const swimLabelKey = WORK_LOGO_SWIM_MODE_LABEL_KEYS[swimMode]
  // UI 插件可声明自己的进行中文案(按泳姿键、按语言),未声明则用默认文案
  const pluginLabel = useUiPluginWorkLabel(
    swimLabelKey as UiPluginLabelKey,
    i18n.language ?? 'zh'
  )
  const label = activityLabel
    ? t('workingToolAction', { action: activityLabel })
    : thinking
      ? t('thinkingNow')
      : tool
        ? t('workingToolAction', { action: summarizeToolBlock(tool, t) })
        : ikunModeOn
          ? t(IKUN_WORK_LOGO_VARIANT_LABEL_KEYS[ikunVariant])
          : pluginLabel ?? t(swimLabelKey)

  return (
    <LiveTurnActivityRow
      label={label}
      ikunVariant={ikunVariant}
      swimMode={swimMode}
    />
  )
}

function LiveTurnActivityRow({
  label,
  ikunVariant,
  swimMode
}: {
  label: string
  ikunVariant?: IkunWorkLogoVariant
  swimMode?: WorkLogoSwimMode
}): ReactElement {
  return (
    <div className={liveTurnProgressClass()}>
      <span className="ds-work-logo-slot ds-work-logo-slot-sm mr-0.5">
        <AnimatedWorkLogo active ikunVariant={ikunVariant} mode={swimMode} phase="trail" size="sm" />
      </span>
      <span className="ds-shiny-text">{label}</span>
    </div>
  )
}

export const MemoMessageTurn = memo(ConversationTurn, (prev, next) => (
  sameTurnContent(prev.turn, next.turn) &&
  prev.isProcessing === next.isProcessing &&
  prev.liveReasoning === next.liveReasoning &&
  prev.live === next.live &&
  prev.durationMs === next.durationMs &&
  prev.reasoningDurationMs === next.reasoningDurationMs &&
  prev.devPreviewCard === next.devPreviewCard &&
  prev.planActionsBusy === next.planActionsBusy &&
  prev.graphEnabled === next.graphEnabled &&
  prev.onBuildPlan === next.onBuildPlan &&
  prev.onOpenPlan === next.onOpenPlan &&
  prev.onOpenChanges === next.onOpenChanges &&
  prev.onReviewChanges === next.onReviewChanges &&
  prev.reviewChangesDisabled === next.reviewChangesDisabled &&
  prev.onOpenChildThread === next.onOpenChildThread &&
  prev.onCancelToolCall === next.onCancelToolCall &&
  prev.onComponentPrototypePrompt === next.onComponentPrototypePrompt &&
  prev.filePreviewWorkspaceRoot === next.filePreviewWorkspaceRoot &&
  prev.compactCards === next.compactCards &&
  prev.allowMainThreadActions === next.allowMainThreadActions &&
  prev.viewportRef === next.viewportRef
))
