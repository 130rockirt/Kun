import { beforeEach, describe, expect, it } from 'vitest'
import type { ChatBlock, ToolBlock } from '../../agent/types'
import { useCanvasShapeStore } from './canvas-shape-store'
import {
  imageGenerationEntriesFromShapes,
  reconcileImageGenerationProgress,
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

beforeEach(() => {
  useCanvasShapeStore.getState().resetDocument()
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
})
