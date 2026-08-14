import { useEffect, useRef } from 'react'
import { create } from 'zustand'
import type { ChatBlock, ToolBlock } from '../../agent/types'
import { useChatStore } from '../../store/chat-store'
import { requestCodeCanvasPanelOpen } from '../../lib/code-canvas-panel-event'
import { focusViewportOnIds } from './canvas-focus'
import { useCanvasShapeStore } from './canvas-shape-store'
import { createDefaultShape } from './canvas-types'

/**
 * Renderer-side visibility for in-flight AI-image generation on a bound Design
 * whiteboard.
 *
 * When a `generate_image`-family tool enters running (pending), the whiteboard
 * creates an `aiImageHolder` placeholder at the recommended slot so the user
 * sees progress immediately and the slot survives reload/replay through
 * `canvas.json`. A successful tool result is placed by the existing live
 * placement machinery and the placeholder is removed; a failure or an aborted
 * turn turns the placeholder into a red error state carrying a retry action.
 *
 * Markers are embedded in the shape `name` (not a new shape field) so older
 * canvas documents, the layer panel, and the AI snapshot keep working, and a
 * remount can re-derive placeholder state from persisted shapes alone.
 */

export type ImageGenerationProgressEntry = {
  toolCallId: string
  shapeId: string
  status: 'generating' | 'failed'
  startedAt: number
  prompt?: string
  error?: string
  elapsedMs?: number
}

type ImageGenerationProgressState = {
  entries: Record<string, ImageGenerationProgressEntry>
  replaceEntries: (entries: Record<string, ImageGenerationProgressEntry>) => void
}

const GENERATING_MARKER = '⚙ 生成中'
const FAILED_MARKER = '⚠ 生成失败'

function isGenerateImageToolName(value: unknown): boolean {
  return typeof value === 'string' && (value === 'generate_image' || value.endsWith('__generate_image'))
}

function placeholderName(toolCallId: string, failed: boolean): string {
  return `${failed ? FAILED_MARKER : GENERATING_MARKER}:${toolCallId}`
}

function toolCallIdFromPlaceholderName(name: string): string | null {
  for (const marker of [GENERATING_MARKER, FAILED_MARKER]) {
    if (name.startsWith(`${marker}:`)) {
      const id = name.slice(marker.length + 1).trim()
      return id || null
    }
  }
  return null
}

function toolPromptFromDetail(detail: string | undefined): string | undefined {
  if (!detail) return undefined
  try {
    const parsed = JSON.parse(detail) as { prompt?: unknown }
    const prompt = typeof parsed.prompt === 'string' ? parsed.prompt.trim() : ''
    return prompt || undefined
  } catch {
    return undefined
  }
}

function nextPlaceholderPosition(): { x: number; y: number } {
  const { document } = useCanvasShapeStore.getState()
  let count = 0
  for (const shape of Object.values(document.objects)) {
    if (shape.name.startsWith(GENERATING_MARKER) || shape.name.startsWith(FAILED_MARKER)) count += 1
  }
  // Stack below the top-left build area so placeholders never cover the first
  // frame the agent draws.
  return { x: 48 + count * 24, y: 48 + count * 24 }
}

function createPlaceholderShape(toolCallId: string): string {
  const shape = createDefaultShape('rect', 0, 0, 'diagram')
  const position = nextPlaceholderPosition()
  useCanvasShapeStore.getState().addShape(
    {
      ...shape,
      id: `gen_${toolCallId.replace(/[^a-zA-Z0-9_-]/g, '_')}`,
      name: placeholderName(toolCallId, false),
      x: position.x,
      y: position.y,
      width: 200,
      height: 140,
      cornerRadius: 12,
      aiImageHolder: true,
      fills: [{ type: 'solid', color: '#eef2ff', opacity: 1 }],
      strokes: [{ color: '#6366f1', opacity: 0.6, width: 1.5, position: 'center' }]
    },
    undefined,
    { skipUndo: true }
  )
  const store = useCanvasShapeStore.getState()
  const placed = Object.values(store.document.objects).find(
    (candidate) => candidate.name === placeholderName(toolCallId, false)
  )
  const placedId = placed?.id ?? shape.id
  focusViewportOnIds([placedId])
  return placedId
}

function markPlaceholderFailed(shapeId: string, toolCallId: string): void {
  useCanvasShapeStore.getState().updateShape(
    shapeId,
    {
      name: placeholderName(toolCallId, true),
      aiImageHolder: false,
      fills: [{ type: 'solid', color: '#fef2f2', opacity: 1 }],
      strokes: [{ color: '#dc2626', opacity: 0.7, width: 1.5, position: 'center' }]
    },
    true
  )
}

function removePlaceholderShape(shapeId: string): void {
  const { document } = useCanvasShapeStore.getState()
  if (document.objects[shapeId]) {
    useCanvasShapeStore.getState().deleteShape(shapeId, { skipUndo: true })
  }
}

function entryForShape(toolCallId: string, failed: boolean): ImageGenerationProgressEntry {
  const shape = Object.values(useCanvasShapeStore.getState().document.objects).find(
    (candidate) => candidate.name === placeholderName(toolCallId, failed)
  )
  return {
    toolCallId,
    shapeId: shape?.id ?? '',
    status: failed ? 'failed' : 'generating',
    startedAt: Date.now()
  }
}

/**
 * Reconcile placeholder entries against the live chat tool stream. Returns the
 * entries that changed so the hook can persist and react (auto-open, first
 * fit-to-content) exactly once per transition.
 */
export function reconcileImageGenerationProgress(
  blocks: readonly ChatBlock[]
): { entries: Record<string, ImageGenerationProgressEntry>; opened: boolean; succeeded: boolean } {
  const state = useImageGenerationProgressStore.getState()
  const next: Record<string, ImageGenerationProgressEntry> = {}
  const inFlightToolIds = new Set<string>()
  const resolvedToolIds = new Set<string>()
  let opened = false
  let succeeded = false

  for (const block of blocks) {
    if (block.kind !== 'tool' || !isGenerateImageToolName(block.meta?.toolName)) continue
    const tool = block as ToolBlock
    const id = tool.id
    const previous = state.entries[id]
    if (tool.status === 'success') {
      resolvedToolIds.add(id)
      if (previous) {
        removePlaceholderShape(previous.shapeId)
        succeeded = true
      }
      continue
    }
    if (tool.status === 'error') {
      resolvedToolIds.add(id)
      const shapeId = previous?.shapeId ?? ''
      if (shapeId) markPlaceholderFailed(shapeId, id)
      next[id] = {
        toolCallId: id,
        shapeId,
        status: 'failed',
        startedAt: previous?.startedAt ?? Date.now(),
        prompt: previous?.prompt ?? toolPromptFromDetail(tool.detail),
        error: 'image_generation_failed',
        elapsedMs: Date.now() - (previous?.startedAt ?? Date.now())
      }
      continue
    }
    // running/pending: ensure a placeholder exists.
    inFlightToolIds.add(id)
    const shapeId = previous?.shapeId && useCanvasShapeStore.getState().document.objects[previous.shapeId]
      ? previous.shapeId
      : createPlaceholderShape(id)
    if (!previous && !opened) opened = true
    next[id] = {
      toolCallId: id,
      shapeId,
      status: 'generating',
      startedAt: previous?.startedAt ?? Date.now(),
      prompt: previous?.prompt ?? toolPromptFromDetail(tool.detail)
    }
  }

  // Placeholders no longer backed by an in-flight tool (turn aborted, block
  // removed, or a reload with no live stream) become actionable failures.
  for (const [toolCallId, entry] of Object.entries(state.entries)) {
    if (inFlightToolIds.has(toolCallId) || resolvedToolIds.has(toolCallId)) continue
    if (entry.shapeId && useCanvasShapeStore.getState().document.objects[entry.shapeId]) {
      markPlaceholderFailed(entry.shapeId, toolCallId)
    }
    next[toolCallId] = {
      ...entry,
      status: 'failed',
      error: entry.error ?? 'image_generation_interrupted',
      elapsedMs: Date.now() - entry.startedAt
    }
  }

  return { entries: next, opened, succeeded }
}

/** Rebuild entries from persisted placeholder shapes (reload resilience). */
export function imageGenerationEntriesFromShapes(): Record<string, ImageGenerationProgressEntry> {
  const entries: Record<string, ImageGenerationProgressEntry> = {}
  for (const shape of Object.values(useCanvasShapeStore.getState().document.objects)) {
    const toolCallId = toolCallIdFromPlaceholderName(shape.name)
    if (!toolCallId) continue
    const failed = shape.name.startsWith(FAILED_MARKER)
    entries[toolCallId] = {
      toolCallId,
      shapeId: shape.id,
      status: failed ? 'failed' : 'generating',
      startedAt: Date.now(),
      error: failed ? 'image_generation_interrupted' : undefined
    }
  }
  return entries
}

export const useImageGenerationProgressStore = create<ImageGenerationProgressState>((set) => ({
  entries: {},
  replaceEntries: (entries) => set({ entries })
}))

/**
 * Mount inside a whiteboard host (CodeCanvasPanel / DesignCanvas). Watches the
 * chat tool stream for `generate_image` and mirrors its lifecycle as
 * placeholder shapes.
 *
 * `onRetry(prompt)` re-drives a failed placeholder's original brief through
 * the host's design-prompt sender; `onFirstSuccess` fires once per successful
 * generation so the host can fit-to-content exactly once.
 */
export function useCanvasImageGenerationProgress(
  enabled: boolean,
  callbacks?: {
    expectedCanvasDocumentKey?: string
    onRetry?: (prompt: string) => void
    onFirstSuccess?: () => void
  }
): void {
  const callbacksRef = useRef(callbacks)
  callbacksRef.current = callbacks
  const expectedCanvasDocumentKey = callbacks?.expectedCanvasDocumentKey
  useEffect(() => {
    if (!enabled) return
    const canvasDocumentReady = (): boolean => (
      !expectedCanvasDocumentKey ||
      useCanvasShapeStore.getState().documentKey === expectedCanvasDocumentKey
    )
    const apply = (): void => {
      if (!canvasDocumentReady()) return
      const result = reconcileImageGenerationProgress(useChatStore.getState().blocks)
      useImageGenerationProgressStore.getState().replaceEntries(result.entries)
      if (result.opened) requestCodeCanvasPanelOpen()
      if (result.succeeded) callbacksRef.current?.onFirstSuccess?.()
    }
    const seedAndApply = (): void => {
      if (!canvasDocumentReady()) return
      useImageGenerationProgressStore.setState({
        entries: imageGenerationEntriesFromShapes()
      })
      apply()
    }
    seedAndApply()
    const unsubscribeChat = useChatStore.subscribe(apply)
    const unsubscribeCanvas = useCanvasShapeStore.subscribe((state, previous) => {
      if (state.documentLoadRevision === previous.documentLoadRevision) return
      seedAndApply()
    })
    return () => {
      unsubscribeChat()
      unsubscribeCanvas()
      useImageGenerationProgressStore.setState({ entries: {} })
    }
  }, [enabled, expectedCanvasDocumentKey])
}

/** Failed placeholder entries for a host-rendered retry chip. */
export function failedImageGenerationEntries(): ImageGenerationProgressEntry[] {
  return Object.values(useImageGenerationProgressStore.getState().entries)
    .filter((entry) => entry.status === 'failed')
    .sort((a, b) => a.startedAt - b.startedAt)
}
