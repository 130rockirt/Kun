import { useEffect, useRef } from 'react'
import type { ChatBlock, ToolBlock } from '../../agent/types'
import { useChatStore } from '../../store/chat-store'
import { collectAssistantTextForTurn, threadHasPendingRuntimeWork } from '../../store/chat-store-runtime-helpers'
import { applyCanvasOpBlocks, applyCanvasOpsSince, extractCanvasOpBlocksFromValue, setLastCanvasOpErrors } from './apply-shape-ops'
import { useCanvasSelectionStore } from './canvas-selection-store'
import { useCanvasShapeStore } from './canvas-shape-store'
import { takeScreenBrief } from './screen-artifact-bridge'
import type { ExecuteOpsOptions, OpError } from './shape-ops'
import { isHtmlFrame, isImplicitImageSlot } from './canvas-types'
import { useDesignAssistantStore } from '../design-assistant-store'
import { useDesignWorkspaceStore } from '../design-workspace-store'
import {
  projectPptCanvasBundle,
  resolvePptCanvasProjection,
  type PptCanvasProjectionOptions
} from './ppt-canvas-projection'
import {
  takeNextReadyScreenGeneration,
  type PendingScreenGeneration
} from './canvas-screen-generation-queue'
import {
  applySvgArtifactToolBlock,
  shouldApplyDesignCanvasToolBlock,
  type SvgArtifactRequestHandler
} from './svg-artifact-tool-replay'
import { designSystemToolRevisionError, persistAppliedDesignSystemTool } from './design-system-tool-replay'
import { dispatchCanvasExportToolBlock, type CanvasAgentExportRequestHandler } from './canvas-export-tool-replay'
import {
  executeMotionOps,
  extractMotionOpsFromValue,
  isDesignMotionRendererToolName
} from './motion-ops'
import {
  resolveGeneratedImageFallbackTarget,
  rewriteGeneratedImageUrlsForTurn,
  type GeneratedImageFallbackTarget
} from './canvas-generated-image-replay'
import {
  activeCanvasTurnMatchesDesignTarget,
  activeCanvasTurnMatchesThread,
  blocksForActiveCanvasTurn,
  canvasReplayStateForStoreUpdate,
  designImagePlacementTargetFromUserBlock,
  designCanvasReplayContextForActiveTurn,
  placeGeneratedImagesForTurn,
  replayActiveCanvasTurn,
  type CanvasDesignDocumentTarget,
  type CanvasTurnReplayState
} from './canvas-design-turn-replay'
import {
  applyDurableCanvasOpsSince,
  replayIdleCanvasToolBlocks,
  replayIdleDesignCanvas
} from './canvas-design-idle-replay'

export {
  hasDispatchedSvgFollowup, shouldApplyDesignCanvasToolBlock,
  shouldApplyDurableSvgCreate, userTextBeforeToolBlock
} from './svg-artifact-tool-replay'
export {
  latestGeneratedImageRelativePathForTurn,
  latestGeneratedImageUrlForTurn,
  looksLikeExistingCanvasImageEditRequest,
  resolveGeneratedImageFallbackTarget,
  rewriteGeneratedImageUrlsForTurn
} from './canvas-generated-image-replay'
export {
  activeCanvasTurnMatchesThread,
  canvasReplayStateForStoreUpdate,
  replayActiveCanvasTurn
} from './canvas-design-turn-replay'
export { shouldReplayIdleCanvasToolBlock } from './canvas-design-idle-replay'
export type {
  PptCanvasProjectionOpenRequest,
  PptCanvasProjectionOptions
} from './ppt-canvas-projection'
export { takeNextReadyScreenGeneration } from './canvas-screen-generation-queue'
export type { PendingScreenGeneration } from './canvas-screen-generation-queue'
/** Coalesce per-token `liveAssistant` deltas so we re-parse at most this often. */
const STREAM_THROTTLE_MS = 120

function userTextForCanvasFallback(block: ChatBlock | null | undefined): string {
  if (!block || block.kind !== 'user') return ''
  const displayText = block.meta?.displayText
  return typeof displayText === 'string' && displayText.trim() ? displayText : block.text
}

function userBlockForActiveCanvasTurn(
  state: CanvasTurnReplayState
): Extract<ChatBlock, { kind: 'user' }> | null {
  if (state.currentTurnUserId) {
    const block = state.blocks.find((candidate) => candidate.kind === 'user' && candidate.id === state.currentTurnUserId)
    if (block?.kind === 'user') return block
  }
  for (let i = state.blocks.length - 1; i >= 0; i -= 1) {
    const block = state.blocks[i]
    if (block.kind === 'user') return block
  }
  return null
}

function userBlockUsesPrimaryImageLane(block: ChatBlock | null | undefined): boolean {
  if (block?.kind !== 'user') return false
  const profile = block.meta?.designProfile
  return Boolean(profile && profile.outputMedium === 'image')
}

/**
 * Apply the `design_canvas` / legacy ```shapeops``` blocks the chat agent emits
 * — IN REAL TIME, as they stream — so the design draft builds up live on the
 * canvas instead of appearing all at once when the turn ends.
 *
 * Each completed fenced block is executed the moment its closing ``` arrives in
 * `liveAssistant`; a per-turn cursor (`appliedCount`) guarantees every block runs
 * exactly once across the streaming passes and the final turn-complete flush.
 * Because the agent is encouraged to emit many small batches (one per logical
 * group — a frame, then its children, then the next section), the user watches
 * the layout materialize piece by piece, and add_screen frames pop in instantly
 * while their HTML generation is kicked off at turn end.
 *
 * Used in both design mode (DesignCanvas) and code mode (CodeCanvasPanel) —
 * wherever a CanvasViewport is rendered alongside a chat thread that may emit
 * canvas operations.
 */
export function useApplyShapeOpsLive(
  enabled: boolean,
  onScreenCreated?: (shapeId: string, userPrompt: string, brief?: string) => void,
  executeOptions?: ExecuteOpsOptions,
  errorKey?: string,
  targetThreadId?: string | null,
  onSvgArtifactRequested?: SvgArtifactRequestHandler,
  onCanvasExportRequested?: CanvasAgentExportRequestHandler,
  designDocumentTarget?: CanvasDesignDocumentTarget,
  expectedCanvasDocumentKey?: string,
  pptProjection?: PptCanvasProjectionOptions
): void {
  const onScreenCreatedRef = useRef(onScreenCreated)
  onScreenCreatedRef.current = onScreenCreated
  const onSvgArtifactRequestedRef = useRef(onSvgArtifactRequested)
  onSvgArtifactRequestedRef.current = onSvgArtifactRequested
  const designDocumentTargetRef = useRef(designDocumentTarget)
  designDocumentTargetRef.current = designDocumentTarget
  const onPptProjectionOpenRequestedRef = useRef(pptProjection?.onOpenRequested)
  onPptProjectionOpenRequestedRef.current = pptProjection?.onOpenRequested
  const pptProjectionWorkflowId = pptProjection?.workflowId?.trim() || undefined
  const pptProjectionChildId = pptProjection?.childId?.trim() || undefined
  useEffect(() => {
    if (!enabled) return
    const activeDesignTarget = designDocumentTargetRef.current
    // Per-turn streaming state. Lives in the subscription closure so it survives
    // across deltas without triggering React re-renders on every token.
    let appliedCount = 0
    const affectedThisTurn = new Set<string>()
    const errorsThisTurn: OpError[] = []
    let framedThisTurn = false
    let lastRunAt = 0
    let trailingTimer: ReturnType<typeof setTimeout> | null = null
    let screenDrainTimer: ReturnType<typeof setTimeout> | null = null
    let svgDrainTimer: ReturnType<typeof setTimeout> | null = null
    const appliedToolBlockIds = new Set<string>()
    const processingSvgToolBlockIds = new Set<string>()
    const pendingSvgToolBlocks = new Map<string, ToolBlock>()
    let generatedImageFallbackTarget: GeneratedImageFallbackTarget | null = null
    let generatedImagePlacementTargetId: string | null = null

    // Screens the agent creates via add_screen still need their HTML generated in
    // a follow-up turn. Several can be created in ONE turn, but those follow-up
    // turns must run one at a time on the shared chat thread — so queue them and
    // drain one per turn-completion. `screenGenSeen` guards against ever
    // re-enqueuing (hence regenerating) a frame across the run's lifetime.
    const pendingScreens: PendingScreenGeneration[] = []
    const screenGenSeen = new Set<string>()
    const canvasDocumentReady = (): boolean =>
      !expectedCanvasDocumentKey ||
      useCanvasShapeStore.getState().documentKey === expectedCanvasDocumentKey

    const resetTurn = (): void => {
      appliedCount = 0
      affectedThisTurn.clear()
      errorsThisTurn.length = 0
      framedThisTurn = false
      generatedImageFallbackTarget = null
      generatedImagePlacementTargetId = null
    }

    const captureGeneratedImageFallbackTarget = (state: CanvasTurnReplayState): void => {
      const userBlock = userBlockForActiveCanvasTurn(state)
      generatedImageFallbackTarget = resolveGeneratedImageFallbackTarget({
        document: useCanvasShapeStore.getState().document,
        selectedIds: useCanvasSelectionStore.getState().selectedIds,
        userText: userTextForCanvasFallback(userBlock)
      })
      const selectedIds = useCanvasSelectionStore.getState().selectedIds
      if (selectedIds.size !== 1) return
      const [selectedId] = [...selectedIds]
      const selected = useCanvasShapeStore.getState().document.objects[selectedId]
      if (selected && (selected.aiImageHolder || isImplicitImageSlot(selected))) {
        generatedImagePlacementTargetId = selected.id
      }
    }

    // The in-progress (or just-completed) turn's full assistant text. Using the
    // ASSEMBLED text — not raw `liveAssistant` — keeps the block cursor stable
    // even when a mid-turn tool call (e.g. generate_image) flushes a segment to a
    // block and resets `liveAssistant`; otherwise post-tool-call canvas ops would
    // never stream and the cursor would drift from the turn-complete flush.
    const assembledTurnText = (): string => {
      const s = useChatStore.getState()
      let userId: string | null = null
      for (let i = s.blocks.length - 1; i >= 0; i -= 1) {
        if (s.blocks[i].kind === 'user') {
          userId = s.blocks[i].id
          break
        }
      }
      return userId ? collectAssistantTextForTurn(s.blocks, userId, s.liveAssistant) : s.liveAssistant
    }

    // Apply every not-yet-applied complete block in `text`, advancing the cursor.
    // `frameOnFirst` gently brings the build area into view exactly once per turn
    // (the first batch), then leaves the camera alone so the live build is smooth.
    const applyFrom = (text: string, frameOnFirst: boolean): void => {
      const replay = designCanvasReplayContextForActiveTurn(
        useChatStore.getState(), targetThreadId, activeDesignTarget, 'assistant'
      )
      const { affectedIds, errors, totalBlocks } = replay
        ? applyDurableCanvasOpsSince(text, appliedCount, replay.replayKey, executeOptions)
        : applyCanvasOpsSince(text, appliedCount, executeOptions)
      if (totalBlocks <= appliedCount) return
      appliedCount = totalBlocks
      // Capture errors even when nothing applied — an all-failed block has errors
      // but no affected ids, and that's exactly what the agent must learn about.
      if (errors.length > 0) errorsThisTurn.push(...errors)
      if (affectedIds.length === 0) return
      for (const id of affectedIds) affectedThisTurn.add(id)
      useCanvasSelectionStore.getState().select([...affectedThisTurn])
      if (frameOnFirst && !framedThisTurn) {
        framedThisTurn = true
        // markAiAffected = glow + camera focus; do it once at the start so the
        // build area is in view, then stay put for the rest of the stream.
        useDesignAssistantStore.getState().markAiAffected(affectedIds)
      } else {
        // Glow the freshly-touched shapes without yanking the camera mid-build.
        useDesignAssistantStore.setState({
          lastAiAffectedIds: affectedIds,
          lastAiActionAt: Date.now()
        })
      }
    }

    const processStreaming = (): void => {
      lastRunAt = Date.now()
      if (!canvasDocumentReady() || !useChatStore.getState().currentTurnId) return
      applyFrom(assembledTurnText(), true)
    }

    const applySvgToolBlock = async (block: ToolBlock, allowLegacy = false): Promise<void> => {
      const onRequest = onSvgArtifactRequestedRef.current
      if (!onRequest) return
      const chatState = useChatStore.getState()
      const result = await applySvgArtifactToolBlock({
        block,
        allowLegacy,
        busy: Boolean(
          chatState.currentTurnId ||
          chatState.busy ||
          threadHasPendingRuntimeWork(chatState.blocks)
        ),
        blocks: chatState.blocks,
        artifacts: useDesignWorkspaceStore.getState().artifacts,
        appliedBlockIds: appliedToolBlockIds,
        processingBlockIds: processingSvgToolBlockIds,
        onDefer: (deferred) => {
          pendingSvgToolBlocks.set(deferred.id, deferred)
          scheduleSvgDrain()
        },
        onRequest
      })
      if (result.shapeIds.length > 0) {
        useCanvasSelectionStore.getState().select(result.shapeIds)
        useDesignAssistantStore.getState().markAiAffected(result.shapeIds)
        framedThisTurn = true
      }
    }

    const applyToolBlock = (
      block: ToolBlock,
      replay?: { blocks: readonly ChatBlock[]; replayKey: string }
    ): void => {
      if (appliedToolBlockIds.has(block.id)) return
      const detail = block.detail?.trim()
      if (!detail) return
      let parsed: unknown
      try {
        parsed = JSON.parse(detail)
      } catch {
        return
      }
      const pptCanvasProjection = resolvePptCanvasProjection(
        typeof block.meta?.toolName === 'string' ? block.meta.toolName : undefined,
        parsed,
        pptProjectionWorkflowId,
        pptProjectionChildId
      )
      if (!pptCanvasProjection && !shouldApplyDesignCanvasToolBlock(block)) return
      if (pptCanvasProjection) {
        if (pptCanvasProjection.kind === 'filtered') {
          appliedToolBlockIds.add(block.id)
          return
        }
        appliedToolBlockIds.add(block.id)
        if (projectPptCanvasBundle({
          blockId: block.id,
          projection: pptCanvasProjection,
          targetThreadId,
          executeOptions,
          affectedThisTurn,
          errorsThisTurn,
          onOpenRequested: onPptProjectionOpenRequestedRef.current
        })) framedThisTurn = true
        return
      }
      const chatState = useChatStore.getState()
      parsed = rewriteGeneratedImageUrlsForTurn(
        parsed,
        replay?.blocks ?? blocksForActiveCanvasTurn({
            activeThreadId: chatState.activeThreadId,
            currentTurnId: chatState.currentTurnId,
            currentTurnUserId: chatState.currentTurnUserId,
            blocks: chatState.blocks
          })
      )
      if (dispatchCanvasExportToolBlock(block, parsed, appliedToolBlockIds, onCanvasExportRequested)) return
      if (isDesignMotionRendererToolName(block.meta?.toolName)) {
        const motionOps = extractMotionOpsFromValue(parsed)
        const { affectedIds, errors } = executeMotionOps(
          motionOps,
          `tool:${block.id}`,
          { replayKey: block.id }
        )
        // Mark even invalid/rejected renderer output as consumed. Otherwise a
        // remount in the same turn would repeatedly surface the same bounded
        // error; successfully applied batches also have a durable journal guard.
        appliedToolBlockIds.add(block.id)
        if (errors.length > 0) errorsThisTurn.push(...errors)
        if (affectedIds.length === 0) return
        for (const id of affectedIds) affectedThisTurn.add(id)
        useCanvasSelectionStore.getState().select(
          [...affectedThisTurn].filter((id) => Boolean(useCanvasShapeStore.getState().document.objects[id]))
        )
        if (!framedThisTurn) {
          framedThisTurn = true
          useDesignAssistantStore.getState().markAiAffected(affectedIds)
        } else {
          useDesignAssistantStore.setState({
            lastAiAffectedIds: affectedIds,
            lastAiActionAt: Date.now()
          })
        }
        return
      }
      if (block.meta?.toolName === 'design_svg_create') {
        // A dedicated SVG turn must start only after the canvas turn becomes
        // idle. Otherwise sendMessage puts it into a process-global transient
        // queue that is discarded on thread switches. Stable-id results are
        // also replayed below after remount/restart when the artifact is absent
        // or still pending without a corresponding follow-up user turn.
        if (chatState.currentTurnId) pendingSvgToolBlocks.set(block.id, block)
        else void applySvgToolBlock(block, true)
        return
      }
      const revisionError = designSystemToolRevisionError(block.meta?.toolName, parsed)
      if (revisionError) {
        appliedToolBlockIds.add(block.id)
        errorsThisTurn.push(revisionError)
        return
      }
      const blocks = extractCanvasOpBlocksFromValue(parsed)
      if (blocks.length === 0) {
        return
      }
      const { affectedIds, errors } = applyCanvasOpBlocks(
        blocks,
        `tool:${block.id}`,
        replay ? { ...executeOptions, replayKey: replay.replayKey } : executeOptions
      )
      appliedToolBlockIds.add(block.id)
      if (errors.length > 0) errorsThisTurn.push(...errors)
      persistAppliedDesignSystemTool(block.meta?.toolName, errors)
      if (affectedIds.length === 0) return
      for (const id of affectedIds) affectedThisTurn.add(id)
      useCanvasSelectionStore.getState().select([...affectedThisTurn])
      if (!framedThisTurn) {
        framedThisTurn = true
        useDesignAssistantStore.getState().markAiAffected(affectedIds)
      } else {
        useDesignAssistantStore.setState({
          lastAiAffectedIds: affectedIds,
          lastAiActionAt: Date.now()
        })
      }
    }

    const scheduleStreaming = (): void => {
      const elapsed = Date.now() - lastRunAt
      if (elapsed >= STREAM_THROTTLE_MS) {
        processStreaming()
      } else if (!trailingTimer) {
        trailingTimer = setTimeout(() => {
          trailingTimer = null
          processStreaming()
        }, STREAM_THROTTLE_MS - elapsed)
      }
    }

    function scheduleScreenDrain(delay = 160): void {
      if (screenDrainTimer) return
      screenDrainTimer = setTimeout(() => {
        screenDrainTimer = null
        drainPendingScreens()
      }, delay)
    }

    function scheduleSvgDrain(delay = 120): void {
      if (svgDrainTimer) return
      svgDrainTimer = setTimeout(() => {
        svgDrainTimer = null
        drainPendingSvgBlocks()
      }, delay)
    }

    function drainPendingSvgBlocks(): void {
      if (pendingSvgToolBlocks.size === 0) return
      const chatState = useChatStore.getState()
      if (
        chatState.currentTurnId ||
        chatState.busy ||
        threadHasPendingRuntimeWork(chatState.blocks)
      ) {
        scheduleSvgDrain()
        return
      }
      const blocks = [...pendingSvgToolBlocks.values()]
      pendingSvgToolBlocks.clear()
      for (const block of blocks) void applySvgToolBlock(block, true)
    }

    // Kick off the next queued screen's HTML generation — but only while the
    // thread is fully idle, so the per-screen turns run strictly one at a time.
    // Turn completion and busy/currentTurnId clearing can land in separate store
    // ticks, so this function re-schedules itself instead of consuming too early.
    function drainPendingScreens(): void {
      if (pendingScreens.length === 0) return
      const chatState = useChatStore.getState()
      const pendingRuntimeWork = threadHasPendingRuntimeWork(chatState.blocks)
      const next = takeNextReadyScreenGeneration({
        pendingScreens,
        document: useCanvasShapeStore.getState().document,
        currentTurnId: chatState.currentTurnId,
        busy: chatState.busy,
        pendingRuntimeWork,
        htmlArtifactIds: new Set(
          useDesignWorkspaceStore.getState().artifacts
            .filter((artifact) => artifact.kind === 'html')
            .map((artifact) => artifact.id)
        )
      })
      if (!next) {
        if (pendingScreens.length > 0 && (chatState.currentTurnId || chatState.busy || pendingRuntimeWork)) {
          scheduleScreenDrain()
        }
        return
      }
      useCanvasSelectionStore.getState().select([next.shapeId])
      onScreenCreatedRef.current?.(next.shapeId, next.userPrompt, next.brief)
    }

    // Final pass once the turn completes: apply any block that finished exactly at
    // the end, then do a single camera fit + kick off screen-HTML generation.
    const finalizeTurn = (completedTurnId?: string): void => {
      if (trailingTimer) {
        clearTimeout(trailingTimer)
        trailingTimer = null
      }
      const s = useChatStore.getState()
      let userId: string | null = null
      for (let i = s.blocks.length - 1; i >= 0; i -= 1) {
        if (s.blocks[i].kind === 'user') {
          userId = s.blocks[i].id
          break
        }
      }
      if (userId) {
        const text = collectAssistantTextForTurn(s.blocks, userId, s.liveAssistant)
        applyFrom(text, false)
      }
      if (!generatedImageFallbackTarget && userId) {
        captureGeneratedImageFallbackTarget({
          activeThreadId: s.activeThreadId,
          currentTurnId: s.currentTurnId,
          currentTurnUserId: userId,
          blocks: s.blocks
        })
      }
      const turnBlocks = userId
        ? blocksForActiveCanvasTurn({
            activeThreadId: s.activeThreadId,
            currentTurnId: s.currentTurnId,
            currentTurnUserId: userId,
            blocks: s.blocks
          })
        : []
      const userBlock = userId ? s.blocks.find((block) => block.id === userId) : null
      const primaryImageLane = userBlockUsesPrimaryImageLane(userBlock)
      const replayThreadId = targetThreadId ?? s.activeThreadId
      const placementTarget = designImagePlacementTargetFromUserBlock(userBlock) ??
        (generatedImageFallbackTarget
        ? {
            id: generatedImageFallbackTarget.id,
            expectedImageUrl: generatedImageFallbackTarget.imageUrl
          }
        : generatedImagePlacementTargetId
          ? { id: generatedImagePlacementTargetId }
          : undefined)
      const placedImages = placeGeneratedImagesForTurn({
        blocks: turnBlocks,
        primaryImageLane,
        affectedIds: [...affectedThisTurn],
        ...(replayThreadId ? { threadId: replayThreadId } : {}),
        ...(completedTurnId ? { turnId: completedTurnId } : {}),
        ...(activeDesignTarget ? { target: activeDesignTarget } : {}),
        ...(placementTarget ? { placementTarget } : {})
      })
      for (const placed of placedImages) affectedThisTurn.add(placed)
      if (placedImages.length > 0) {
        errorsThisTurn.length = 0
      }
      const all = [...affectedThisTurn]
      if (all.length > 0) {
        useCanvasSelectionStore.getState().select(all)
        useDesignAssistantStore.getState().markAiAffected(all)
        if (onScreenCreatedRef.current) {
          const doc = useCanvasShapeStore.getState().document
          const userBlock = userId ? s.blocks.find((b) => b.id === userId) : null
          const userPrompt = userBlock?.kind === 'user' ? (userBlock.text ?? '') : ''
          // Queue EVERY newly created screen frame (not just the first) so a turn
          // that adds several screens generates HTML for all of them — the drain
          // below runs them sequentially.
          for (const id of all) {
            const shape = doc.objects[id]
            if (shape && isHtmlFrame(shape) && !screenGenSeen.has(id)) {
              screenGenSeen.add(id)
              const brief = takeScreenBrief(id)
              pendingScreens.push({ shapeId: id, userPrompt, ...(brief ? { brief } : {}) })
            }
          }
        }
      }
      // Hand this turn's op errors to the next canvas turn so the agent can fix
      // them. Always set (even []) so a clean turn clears stale errors.
      setLastCanvasOpErrors([...errorsThisTurn], errorKey)
      if (completedTurnId && activeDesignTarget && replayThreadId) {
        useCanvasShapeStore.getState().recordRendererReplayWatermark(completedTurnId)
      }
      resetTurn()
      // Let chat/runtime state settle before starting the follow-up HTML turn.
      scheduleScreenDrain(120)
      scheduleSvgDrain(120)
    }

    const replayIdle = (state: ReturnType<typeof useChatStore.getState>): void =>
      replayIdleDesignCanvas({
        state, threadId: targetThreadId, target: activeDesignTarget,
        ready: canvasDocumentReady(), executeOptions, errorKey,
        affectedIds: affectedThisTurn, errors: errorsThisTurn, resetTurn, applyToolBlock
      })

    // If this hook becomes enabled after a turn has already started (common for
    // the first Code-canvas send, where the thread id appears after sendMessage),
    // catch up with already-present tool blocks/live text before waiting for the
    // next store change.
    const initialState = useChatStore.getState()
    if (initialState.currentTurnId) captureGeneratedImageFallbackTarget(initialState)
    if (canvasDocumentReady()) {
      replayActiveCanvasTurn(
        initialState, applyToolBlock, processStreaming, targetThreadId, activeDesignTarget
      )
    }
    replayIdle(initialState)
    if (canvasDocumentReady() && !activeDesignTarget && !initialState.currentTurnId &&
      activeCanvasTurnMatchesThread(initialState, targetThreadId)) {
      replayIdleCanvasToolBlocks(
        initialState.blocks, applyToolBlock, (block) => void applySvgToolBlock(block)
      )
    }

    const unsubscribe = useChatStore.subscribe((state, prev) => {
      if (!activeCanvasTurnMatchesThread(state, targetThreadId)) return
      const turnStarted = !prev.currentTurnId && Boolean(state.currentTurnId)
      const turnEnded = Boolean(prev.currentTurnId) && !state.currentTurnId
      const replayState = canvasReplayStateForStoreUpdate(state, prev)
      if (replayState.currentTurnId &&
        !activeCanvasTurnMatchesDesignTarget(replayState, activeDesignTarget)) return
      if (!canvasDocumentReady()) return
      if (turnStarted) {
        resetTurn()
        captureGeneratedImageFallbackTarget(state)
      }
      if (replayState.currentTurnId && state.blocks !== prev.blocks) {
        for (const block of blocksForActiveCanvasTurn(replayState)) {
          if (block.kind === 'tool') applyToolBlock(
            block,
            designCanvasReplayContextForActiveTurn(
              replayState, targetThreadId, activeDesignTarget, `tool:${block.id}`
            ) ?? undefined
          )
        }
      }
      if (!state.currentTurnId && state.blocks !== prev.blocks) {
        replayIdle(state)
        if (!activeDesignTarget) replayIdleCanvasToolBlocks(
          state.blocks, applyToolBlock, (block) => void applySvgToolBlock(block)
        )
      }
      if (state.currentTurnId && state.liveAssistant !== prev.liveAssistant) {
        scheduleStreaming()
      }
      if (turnEnded) finalizeTurn(prev.currentTurnId ?? undefined)
      if (
        !state.currentTurnId &&
        !state.busy &&
        !threadHasPendingRuntimeWork(state.blocks) &&
        pendingScreens.length > 0
      ) {
        scheduleScreenDrain(0)
      }
      if (pendingSvgToolBlocks.size > 0) scheduleSvgDrain(0)
    })
    const unsubscribeCanvas = useCanvasShapeStore.subscribe((state, prev) => {
      if (state.documentLoadRevision === prev.documentLoadRevision || !canvasDocumentReady()) return
      appliedToolBlockIds.clear()
      processingSvgToolBlockIds.clear()
      const chatState = useChatStore.getState()
      if (chatState.currentTurnId) {
        replayActiveCanvasTurn(
          chatState, applyToolBlock, processStreaming, targetThreadId, activeDesignTarget
        )
      } else replayIdle(chatState)
    })

    return () => {
      if (trailingTimer) clearTimeout(trailingTimer)
      if (screenDrainTimer) clearTimeout(screenDrainTimer)
      if (svgDrainTimer) clearTimeout(svgDrainTimer)
      unsubscribe()
      unsubscribeCanvas()
    }
  }, [
    enabled,
    executeOptions,
    errorKey,
    targetThreadId,
    onCanvasExportRequested,
    designDocumentTarget?.documentId,
    designDocumentTarget?.boardArtifactId,
    expectedCanvasDocumentKey,
    pptProjectionWorkflowId,
    pptProjectionChildId
  ])
}
