import type { ChatBlock, ToolBlock } from '../../agent/types'
import {
  generatedImageResultsForTurn,
  latestGeneratedImageUrlForTurn,
  type GeneratedImageResult
} from './canvas-generated-image-replay'
import { canvasReplayResult } from './canvas-replay-receipt'
import { currentCanvasOccupiedRects } from './canvas-occupied-regions'
import { placeRectInViewportAvoiding } from './canvas-placement'
import { useCanvasSelectionStore } from './canvas-selection-store'
import { useCanvasShapeStore } from './canvas-shape-store'
import { createDefaultShape, isImplicitImageSlot } from './canvas-types'
import { useCanvasViewportStore } from './canvas-viewport-store'

export type CanvasDesignDocumentTarget = {
  documentId: string
  boardArtifactId: string
}

export type DurableDesignCanvasTurn = {
  userBlockId: string
  turnId: string
  blocks: readonly ChatBlock[]
}

export type CanvasDesignReplayContext = {
  blocks: readonly ChatBlock[]
  replayKey: string
  turnId: string
}

export type CanvasTurnReplayState = {
  activeThreadId?: string | null
  currentTurnId: string | null
  currentTurnUserId?: string | null
  blocks: readonly ChatBlock[]
}

export type DurableDesignCanvasTurnCompletion = {
  turnId: string
  blocks: readonly ChatBlock[]
  primaryAiImage: boolean
  generatedImages: GeneratedImageResult[]
  legacyGeneratedImageUrl: string | null
  placementTarget?: CanvasGeneratedImagePlacementTarget
  replayKeyForImage: (completionIdentity: string) => string
}

export type CanvasGeneratedImagePlacementTarget = {
  id: string
  expectedImageUrl?: string
  expectedHolderKind?: 'explicit' | 'implicit-image' | 'implicit-frame' | 'implicit-rect'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function designTargetFromUserBlock(block: ChatBlock | undefined): CanvasDesignDocumentTarget | null {
  if (block?.kind !== 'user') return null
  const value = (block.meta as Record<string, unknown> | undefined)?.designDocumentTarget
  if (!isRecord(value)) return null
  const documentId = typeof value.documentId === 'string' ? value.documentId.trim() : ''
  const boardArtifactId = typeof value.boardArtifactId === 'string'
    ? value.boardArtifactId.trim()
    : ''
  return documentId && boardArtifactId ? { documentId, boardArtifactId } : null
}

export function userBlockHasDesignDocumentTarget(block: ChatBlock | undefined): boolean {
  return Boolean(designTargetFromUserBlock(block))
}

function isPrimaryAiImageTurn(blocks: readonly ChatBlock[]): boolean {
  const user = blocks.find((block) => block.kind === 'user')
  if (user?.kind !== 'user') return false
  const profile = (user.meta as Record<string, unknown> | undefined)?.designProfile
  return isRecord(profile) && profile.outputMedium === 'image'
}

export function designImagePlacementTargetFromUserBlock(
  block: ChatBlock | null | undefined
): CanvasGeneratedImagePlacementTarget | undefined {
  if (block?.kind !== 'user') return undefined
  const value = block.meta?.designImagePlacementTarget
  if (!isRecord(value)) return undefined
  const id = typeof value.shapeId === 'string' ? value.shapeId.trim() : ''
  const expectedImageUrl = typeof value.expectedImageUrl === 'string'
    ? value.expectedImageUrl.trim()
    : ''
  const expectedHolderKind = value.expectedHolderKind === 'explicit' ||
    value.expectedHolderKind === 'implicit-image' ||
    value.expectedHolderKind === 'implicit-frame' ||
    value.expectedHolderKind === 'implicit-rect'
    ? value.expectedHolderKind
    : undefined
  if (!id || id.length > 256 || expectedImageUrl.length > 8_192 ||
    Boolean(expectedImageUrl) === Boolean(expectedHolderKind)) return undefined
  return {
    id,
    ...(expectedImageUrl ? { expectedImageUrl } : { expectedHolderKind })
  }
}

function sameDesignTarget(
  left: CanvasDesignDocumentTarget,
  right: CanvasDesignDocumentTarget
): boolean {
  return left.documentId === right.documentId && left.boardArtifactId === right.boardArtifactId
}

function activeUserBlock(state: Pick<CanvasTurnReplayState, 'currentTurnUserId' | 'blocks'>): ChatBlock | undefined {
  if (state.currentTurnUserId) {
    const current = state.blocks.find((block) => block.id === state.currentTurnUserId)
    if (current?.kind === 'user') return current
  }
  for (let index = state.blocks.length - 1; index >= 0; index -= 1) {
    if (state.blocks[index]?.kind === 'user') return state.blocks[index]
  }
  return undefined
}

function designCanvasTurnId(
  user: ChatBlock,
  blocks: readonly ChatBlock[],
  activeTurnId?: string | null
): string {
  return user.turnId?.trim() || blocks.find((block) => block.turnId?.trim())?.turnId ||
    activeTurnId?.trim() || user.id
}

export function activeCanvasTurnMatchesDesignTarget(
  state: Pick<CanvasTurnReplayState, 'currentTurnUserId' | 'blocks'>,
  target?: CanvasDesignDocumentTarget,
  unboundTargetPolicy: 'any' | 'untargeted' = 'any'
): boolean {
  const submittedTarget = designTargetFromUserBlock(activeUserBlock(state))
  if (!target) return unboundTargetPolicy === 'any' || !submittedTarget
  return Boolean(submittedTarget && sameDesignTarget(submittedTarget, target))
}

export function activeCanvasTurnMatchesThread(
  state: Pick<CanvasTurnReplayState, 'activeThreadId'>,
  targetThreadId?: string | null
): boolean {
  return !targetThreadId || state.activeThreadId === targetThreadId
}

export function blocksForActiveCanvasTurn(state: CanvasTurnReplayState): readonly ChatBlock[] {
  const startIndex = state.currentTurnUserId
    ? state.blocks.findIndex((block) => block.kind === 'user' && block.id === state.currentTurnUserId)
    : -1
  if (startIndex < 0) return state.blocks
  const endIndex = state.blocks.findIndex((block, index) => index > startIndex && block.kind === 'user')
  return state.blocks.slice(startIndex + 1, endIndex >= 0 ? endIndex : undefined)
}

export function replayActiveCanvasTurn(
  state: CanvasTurnReplayState,
  applyToolBlock: (block: ToolBlock, replay?: CanvasDesignReplayContext) => void,
  processStreaming: () => void,
  targetThreadId?: string | null,
  designDocumentTarget?: CanvasDesignDocumentTarget,
  unboundTargetPolicy: 'any' | 'untargeted' = 'any'
): void {
  if (!activeCanvasTurnMatchesThread(state, targetThreadId)) return
  if (!activeCanvasTurnMatchesDesignTarget(
    state,
    designDocumentTarget,
    unboundTargetPolicy
  )) return
  if (!state.currentTurnId) return
  for (const block of blocksForActiveCanvasTurn(state)) {
    if (block.kind !== 'tool') continue
    const replay = canvasReplayContextForActiveTurn(
      state, targetThreadId, designDocumentTarget, `tool:${block.id}`
    )
    if (replay) applyToolBlock(block, replay)
    else applyToolBlock(block)
  }
  processStreaming()
}

export function canvasReplayStateForStoreUpdate(
  state: CanvasTurnReplayState,
  prev?: Pick<CanvasTurnReplayState, 'currentTurnId' | 'currentTurnUserId'>
): CanvasTurnReplayState {
  return {
    ...state,
    currentTurnId: state.currentTurnId ?? prev?.currentTurnId ?? null,
    currentTurnUserId: state.currentTurnUserId ?? prev?.currentTurnUserId ?? null
  }
}

export function toolBlockMatchesDesignTarget(
  blocks: readonly ChatBlock[],
  index: number,
  target: CanvasDesignDocumentTarget
): boolean {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const block = blocks[cursor]
    if (block.kind !== 'user') continue
    const submittedTarget = designTargetFromUserBlock(block)
    return Boolean(submittedTarget && sameDesignTarget(submittedTarget, target))
  }
  return false
}

/** Completed Design turns whose immutable target belongs to the visible board. */
export function durableDesignCanvasTurns(
  blocks: readonly ChatBlock[],
  target: CanvasDesignDocumentTarget
): DurableDesignCanvasTurn[] {
  const turns: DurableDesignCanvasTurn[] = []
  for (let index = 0; index < blocks.length; index += 1) {
    const user = blocks[index]
    if (user.kind !== 'user') continue
    const submittedTarget = designTargetFromUserBlock(user)
    if (!submittedTarget || !sameDesignTarget(submittedTarget, target)) continue
    let end = index + 1
    while (end < blocks.length && blocks[end].kind !== 'user') end += 1
    const turnBlocks = blocks.slice(index, end)
    const turnId = designCanvasTurnId(user, turnBlocks)
    turns.push({ userBlockId: user.id, turnId, blocks: turnBlocks })
    index = end - 1
  }
  return turns
}

export function designCanvasReplayKey(options: {
  threadId: string
  turnId: string
  target: CanvasDesignDocumentTarget
  source: string
}): string {
  return [
    options.threadId,
    options.turnId,
    options.target.documentId,
    options.target.boardArtifactId,
    options.source
  ].join('\0')
}

export function codeCanvasReplayKey(options: {
  threadId: string
  turnId: string
  source: string
}): string {
  return [options.threadId, options.turnId, 'code-canvas', options.source].join('\0')
}

export function placeGeneratedImagesForTurn(options: {
  blocks: readonly ChatBlock[]
  primaryImageLane: boolean
  affectedIds: readonly string[]
  threadId?: string | null
  turnId?: string | null
  target?: CanvasDesignDocumentTarget
  placementTarget?: CanvasGeneratedImagePlacementTarget
}): string[] {
  const placedIds: string[] = []
  const place = (imageUrl: string, completionIdentity?: string): void => {
    const replayKey = completionIdentity && options.threadId && options.turnId && options.target
      ? designCanvasReplayKey({
          threadId: options.threadId,
          turnId: options.turnId,
          target: options.target,
          source: `image:${completionIdentity}`
        })
      : undefined
    const placed = ensureGeneratedImageOnCanvas(imageUrl, {
      ...(replayKey ? { replayKey } : {}),
      ...(options.placementTarget ? { target: options.placementTarget } : {}),
      preferredShapeIds: options.affectedIds
    })
    if (placed) placedIds.push(placed)
  }
  if (options.primaryImageLane) {
    const results = generatedImageResultsForTurn(options.blocks)
    results.forEach((result) => place(result.imageUrl, result.completionIdentity))
    if (results.length === 0) {
      const legacy = latestGeneratedImageUrlForTurn(options.blocks)
      if (legacy) place(legacy)
    }
  } else if (options.affectedIds.length === 0) {
    const legacy = latestGeneratedImageUrlForTurn(options.blocks)
    if (legacy) place(legacy)
  }
  return placedIds
}

export function designCanvasReplayContextForActiveTurn(
  state: CanvasTurnReplayState,
  threadId: string | null | undefined,
  target: CanvasDesignDocumentTarget | undefined,
  source: string
): CanvasDesignReplayContext | null {
  if (!threadId || !target) return null
  const user = activeUserBlock(state)
  if (!user || user.kind !== 'user') return null
  const submittedTarget = designTargetFromUserBlock(user)
  if (!submittedTarget || !sameDesignTarget(submittedTarget, target)) return null
  const start = state.blocks.indexOf(user)
  if (start < 0) return null
  let end = start + 1
  while (end < state.blocks.length && state.blocks[end].kind !== 'user') end += 1
  const blocks = state.blocks.slice(start, end)
  return {
    blocks,
    turnId: designCanvasTurnId(user, blocks, state.currentTurnId),
    replayKey: designCanvasReplayKey({
      threadId,
      turnId: designCanvasTurnId(user, blocks, state.currentTurnId),
      target,
      source
    })
  }
}

export function codeCanvasReplayContextForActiveTurn(
  state: CanvasTurnReplayState,
  threadId: string | null | undefined,
  source: string
): CanvasDesignReplayContext | null {
  if (!threadId) return null
  const user = activeUserBlock(state)
  if (!user || user.kind !== 'user') return null
  // A turn with an immutable Design document target belongs exclusively to
  // that full Design host. Giving it a Code replay key would let a transient
  // lightweight canvas consume the result while the Design surface hydrates.
  if (designTargetFromUserBlock(user)) return null
  const start = state.blocks.indexOf(user)
  if (start < 0) return null
  let end = start + 1
  while (end < state.blocks.length && state.blocks[end].kind !== 'user') end += 1
  const blocks = state.blocks.slice(start, end)
  const turnId = designCanvasTurnId(user, blocks, state.currentTurnId)
  return {
    blocks,
    turnId,
    replayKey: codeCanvasReplayKey({ threadId, turnId, source })
  }
}

export function canvasReplayContextForActiveTurn(
  state: CanvasTurnReplayState,
  threadId: string | null | undefined,
  target: CanvasDesignDocumentTarget | undefined,
  source: string
): CanvasDesignReplayContext | null {
  return target
    ? designCanvasReplayContextForActiveTurn(state, threadId, target, source)
    : codeCanvasReplayContextForActiveTurn(state, threadId, source)
}

export function replayDurableDesignCanvasTurns(options: {
  threadId: string
  blocks: readonly ChatBlock[]
  target: CanvasDesignDocumentTarget
  onTurnStart: () => void
  onAssistantText: (text: string, replayKey: string) => void
  onToolBlock: (
    block: ToolBlock,
    turnBlocks: readonly ChatBlock[],
    replayKey: string,
    turnId: string
  ) => void
  onTurnComplete: (completion: DurableDesignCanvasTurnCompletion) => void
}): void {
  const durableTurns = durableDesignCanvasTurns(options.blocks, options.target)
  const watermark = useCanvasShapeStore.getState().document.rendererReplayWatermarkTurnId
  const watermarkIndex = watermark
    ? durableTurns.findIndex((turn) => turn.turnId === watermark)
    : -1
  const turns = watermarkIndex >= 0 ? durableTurns.slice(watermarkIndex + 1) : durableTurns
  for (const turn of turns) {
    options.onTurnStart()
    const key = (source: string) => designCanvasReplayKey({
      threadId: options.threadId,
      turnId: turn.turnId,
      target: options.target,
      source
    })
    const assistantText = turn.blocks
      .filter((block) => block.kind === 'assistant')
      .map((block) => block.text)
      .join('\n')
    if (assistantText) options.onAssistantText(assistantText, key('assistant'))
    for (const block of turn.blocks) {
      if (block.kind === 'tool') {
        options.onToolBlock(block, turn.blocks, key(`tool:${block.id}`), turn.turnId)
      }
    }
    const placementTarget = designImagePlacementTargetFromUserBlock(
      turn.blocks.find((block) => block.kind === 'user')
    )
    options.onTurnComplete({
      turnId: turn.turnId,
      blocks: turn.blocks,
      primaryAiImage: isPrimaryAiImageTurn(turn.blocks),
      generatedImages: generatedImageResultsForTurn(turn.blocks),
      legacyGeneratedImageUrl: latestGeneratedImageUrlForTurn(turn.blocks),
      ...(placementTarget ? { placementTarget } : {}),
      replayKeyForImage: (completionIdentity) => key(`image:${completionIdentity}`)
    })
  }
}

/** Idempotently place a generated main-lane image in the visible whiteboard. */
export function ensureGeneratedImageOnCanvas(imageUrl: string, options?: {
  replayKey?: string
  target?: CanvasGeneratedImagePlacementTarget
  preferredShapeIds?: readonly string[]
}): string | null {
  const shapeStore = useCanvasShapeStore.getState()
  if (options?.replayKey) {
    const replayed = canvasReplayResult(shapeStore.document, options.replayKey)
    if (replayed) {
      return replayed.affectedIds.find((id) => Boolean(shapeStore.document.objects[id])) ?? null
    }
  }
  const recordReceipt = (shapeId: string): string => {
    if (options?.replayKey) {
      useCanvasShapeStore.getState().recordRendererReplayKey(options.replayKey)
    }
    return shapeId
  }
  const preferredImage = (options?.preferredShapeIds ?? [])
    .map((id) => shapeStore.document.objects[id])
    .find((shape) => shape?.type === 'image' && shape.imageUrl === imageUrl)
  if (preferredImage) return recordReceipt(preferredImage.id)
  const existing = options?.replayKey ? undefined : Object.values(shapeStore.document.objects)
    .find((shape) => shape?.type === 'image' && shape.imageUrl === imageUrl)
  if (existing) return recordReceipt(existing.id)

  const targeted = options?.target
    ? shapeStore.document.objects[options.target.id]
    : undefined
  const expectedHolderKind = options?.target?.expectedHolderKind
  const matchesExpectedHolder = targeted && (
    (expectedHolderKind === 'explicit' && targeted.aiImageHolder && !targeted.imageUrl) ||
    (expectedHolderKind === 'implicit-image' && targeted.type === 'image' && isImplicitImageSlot(targeted)) ||
    (expectedHolderKind === 'implicit-frame' && targeted.type === 'frame' && isImplicitImageSlot(targeted)) ||
    (expectedHolderKind === 'implicit-rect' && targeted.type === 'rect' && isImplicitImageSlot(targeted))
  )
  const validTarget = targeted && (
    (options?.target?.expectedImageUrl !== undefined &&
      targeted.type === 'image' && targeted.imageUrl === options.target.expectedImageUrl) ||
    matchesExpectedHolder ||
    (options?.target?.expectedImageUrl === undefined && !expectedHolderKind &&
      (targeted.aiImageHolder || isImplicitImageSlot(targeted)))
  ) ? targeted : undefined
  const explicitHolder = (options?.preferredShapeIds ?? [])
    .map((id) => shapeStore.document.objects[id])
    .find((shape) => Boolean(shape?.aiImageHolder && !shape.imageUrl))
  const selectedIds = useCanvasSelectionStore.getState().selectedIds
  const selectedByUser = options?.preferredShapeIds === undefined && selectedIds.size === 1
    ? shapeStore.document.objects[[...selectedIds][0]]
    : undefined
  const selected = validTarget ?? explicitHolder ?? (
    selectedByUser && (selectedByUser.aiImageHolder || isImplicitImageSlot(selectedByUser))
      ? selectedByUser
      : undefined
  )
  if (selected) {
    shapeStore.updateShape(selected.id, { type: 'image', imageUrl })
    return recordReceipt(selected.id)
  }

  const viewBox = useCanvasViewportStore.getState().vbox
  const size = Math.max(240, Math.min(640, viewBox.width * 0.62, viewBox.height * 0.72))
  const placement = placeRectInViewportAvoiding(
    { width: size, height: size },
    viewBox,
    currentCanvasOccupiedRects()
  )
  const shape = createDefaultShape(
    'image',
    placement.x,
    placement.y
  )
  shape.name = 'AI image'
  shape.width = size
  shape.height = size
  shape.imageUrl = imageUrl
  shapeStore.addShape(shape)
  return recordReceipt(shape.id)
}
