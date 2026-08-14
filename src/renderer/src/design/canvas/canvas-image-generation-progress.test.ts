import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { beforeEach, describe, expect, it } from 'vitest'
import type { ChatBlock, ToolBlock } from '../../agent/types'
import { useChatStore } from '../../store/chat-store'
import { useCanvasShapeStore } from './canvas-shape-store'
import { useCanvasViewportStore } from './canvas-viewport-store'
import { createEmptyDocument } from './canvas-types'
import {
  imageGenerationEntriesFromShapes,
  reconcileImageGenerationProgress,
  useCanvasImageGenerationProgress,
  useImageGenerationProgressStore
} from './canvas-image-generation-progress'

function toolBlock(id: string, status: ToolBlock['status'], extra?: Record<string, unknown>): ChatBlock {
  return {
    kind: 'tool',
    id,
    summary: 'generate_image: skyline',
    status,
    meta: {
      toolName: 'generate_image',
      ...(extra ?? {})
    }
  }
}

function ImageGenerationProgressHarness({ expectedDocumentKey }: { expectedDocumentKey: string }): null {
  useCanvasImageGenerationProgress(true, { expectedCanvasDocumentKey: expectedDocumentKey })
  return null
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  useCanvasShapeStore.getState().resetDocument()
  useCanvasViewportStore.setState({
    containerWidth: 800,
    containerHeight: 600,
    vbox: { x: -400, y: -300, width: 800, height: 600 }
  })
  useImageGenerationProgressStore.setState({ entries: {} })
})

describe('canvas image generation progress', () => {
  it('creates a persisted generating placeholder while the tool runs', () => {
    const result = reconcileImageGenerationProgress([toolBlock('tool_img_1', 'running')])
    useImageGenerationProgressStore.getState().replaceEntries(result.entries)

    expect(result.opened).toBe(true)
    expect(result.entries['tool_img_1']).toMatchObject({ status: 'generating' })
    const shape = useCanvasShapeStore.getState().document.objects[result.entries['tool_img_1']!.shapeId]
    expect(shape).toBeTruthy()
    expect(shape!.aiImageHolder).toBe(true)
    expect(shape!.name).toContain('生成中')
  })

  it('brings a generating placeholder into view when the saved camera is off-canvas', () => {
    useCanvasViewportStore.getState().setVbox({ x: 2_000, y: 2_000, width: 800, height: 600 })

    const result = reconcileImageGenerationProgress([toolBlock('tool_img_1', 'running')])
    const shape = useCanvasShapeStore.getState().document.objects[result.entries['tool_img_1']!.shapeId]!
    const view = useCanvasViewportStore.getState().vbox

    expect(shape.x).toBeGreaterThanOrEqual(view.x)
    expect(shape.y).toBeGreaterThanOrEqual(view.y)
    expect(shape.x + shape.width).toBeLessThanOrEqual(view.x + view.width)
    expect(shape.y + shape.height).toBeLessThanOrEqual(view.y + view.height)
    expect(view.width).toBe(800)
  })

  it('removes the placeholder once the tool succeeds', () => {
    const first = reconcileImageGenerationProgress([toolBlock('tool_img_1', 'running')])
    useImageGenerationProgressStore.getState().replaceEntries(first.entries)
    const shapeId = first.entries['tool_img_1']!.shapeId

    const second = reconcileImageGenerationProgress([toolBlock('tool_img_1', 'success')])

    expect(second.entries['tool_img_1']).toBeUndefined()
    expect(second.succeeded).toBe(true)
    expect(useCanvasShapeStore.getState().document.objects[shapeId]).toBeUndefined()
  })

  it('turns the placeholder into an actionable failure on tool error', () => {
    const first = reconcileImageGenerationProgress([toolBlock('tool_img_1', 'running')])
    useImageGenerationProgressStore.getState().replaceEntries(first.entries)
    const shapeId = first.entries['tool_img_1']!.shapeId

    const second = reconcileImageGenerationProgress([toolBlock('tool_img_1', 'error')])
    useImageGenerationProgressStore.getState().replaceEntries(second.entries)

    expect(second.entries['tool_img_1']).toMatchObject({
      status: 'failed',
      error: 'image_generation_failed'
    })
    expect(useCanvasShapeStore.getState().document.objects[shapeId]!.name).toContain('生成失败')
  })

  it('marks an interrupted generation as failed after reload from shapes', () => {
    const first = reconcileImageGenerationProgress([toolBlock('tool_img_1', 'running')])
    useImageGenerationProgressStore.getState().replaceEntries(first.entries)
    // Simulate a reload: only the persisted shapes survive, no live tool block.
    useImageGenerationProgressStore.setState({ entries: {} })

    const rebuilt = imageGenerationEntriesFromShapes()
    expect(rebuilt['tool_img_1']).toMatchObject({ status: 'generating' })
    // The hook re-seeds the store from shapes before reconciling the live stream.
    useImageGenerationProgressStore.getState().replaceEntries(rebuilt)

    const reconciled = reconcileImageGenerationProgress([])
    expect(reconciled.entries['tool_img_1']).toMatchObject({
      status: 'failed',
      error: 'image_generation_interrupted'
    })
  })

  it('replays a running placeholder after the target canvas document mounts or reloads', async () => {
    const previousChat = useChatStore.getState()
    const targetDocumentKey = 'canvas:/workspace/target-board'
    useCanvasShapeStore.getState().loadDocument(createEmptyDocument(), 'canvas:/workspace/stale-board')
    useChatStore.setState({ blocks: [toolBlock('tool_img_target', 'running')] })
    let renderer: ReturnType<typeof create> | undefined

    try {
      await act(async () => {
        renderer = create(createElement(ImageGenerationProgressHarness, { expectedDocumentKey: targetDocumentKey }))
      })
      expect(Object.values(useCanvasShapeStore.getState().document.objects)
        .some((shape) => shape.aiImageHolder)).toBe(false)

      await act(async () => {
        useCanvasShapeStore.getState().loadDocument(createEmptyDocument(), targetDocumentKey)
      })
      expect(Object.values(useCanvasShapeStore.getState().document.objects)
        .filter((shape) => shape.aiImageHolder)).toHaveLength(1)

      await act(async () => {
        useCanvasShapeStore.getState().loadDocument(createEmptyDocument(), targetDocumentKey)
      })
      const reloadedHolders = Object.values(useCanvasShapeStore.getState().document.objects)
        .filter((shape) => shape.aiImageHolder)
      expect(reloadedHolders).toHaveLength(1)
      expect(reloadedHolders[0]?.name).toContain('生成中')
    } finally {
      await act(async () => renderer?.unmount())
      useChatStore.setState({ blocks: previousChat.blocks })
    }
  })
})
