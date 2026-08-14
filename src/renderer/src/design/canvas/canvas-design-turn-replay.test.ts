import { afterEach, describe, expect, it } from 'vitest'
import type { ChatBlock } from '../../agent/types'
import { useCanvasSelectionStore } from './canvas-selection-store'
import { useCanvasShapeStore } from './canvas-shape-store'
import {
  activeCanvasTurnMatchesDesignTarget,
  designCanvasReplayKey,
  durableDesignCanvasTurns,
  ensureGeneratedImageOnCanvas,
  replayDurableDesignCanvasTurns,
  toolBlockMatchesDesignTarget
} from './canvas-design-turn-replay'
import { createDefaultShape, createEmptyDocument } from './canvas-types'
import { useCanvasViewportStore } from './canvas-viewport-store'
import { parseProjectDesignMd } from '../design-md/design-md-adapter'
import { useProjectDesignSystemStore } from './project-design-system-store'
import { resetDesignSystemBoardLayoutForTests, setDesignSystemBoardRect } from './design-system-board-layout'

const target = { documentId: 'doc_design', boardArtifactId: 'board_design' }

function userBlock(id: string, submittedTarget?: typeof target): ChatBlock {
  return {
    kind: 'user',
    id,
    text: 'Create a visual',
    ...(submittedTarget ? { meta: { designDocumentTarget: submittedTarget } } : {})
  }
}

describe('Design canvas turn target matching', () => {
  it('matches only the active user turn bound to the visible Design document', () => {
    const blocks = [
      userBlock('user_previous', target),
      userBlock('user_current', { documentId: 'doc_other', boardArtifactId: 'board_other' })
    ]

    expect(activeCanvasTurnMatchesDesignTarget({
      currentTurnUserId: 'user_previous',
      blocks
    }, target)).toBe(true)
    expect(activeCanvasTurnMatchesDesignTarget({
      currentTurnUserId: 'user_current',
      blocks
    }, target)).toBe(false)
    expect(activeCanvasTurnMatchesDesignTarget({
      currentTurnUserId: 'missing',
      blocks
    }, target)).toBe(false)
  })

  it('associates each tool result with the nearest preceding user target', () => {
    const blocks: ChatBlock[] = [
      userBlock('user_design', target),
      { kind: 'tool', id: 'tool_design', summary: 'generate', status: 'success' },
      userBlock('user_other', { documentId: 'doc_other', boardArtifactId: 'board_other' }),
      { kind: 'tool', id: 'tool_other', summary: 'generate', status: 'success' }
    ]

    expect(toolBlockMatchesDesignTarget(blocks, 1, target)).toBe(true)
    expect(toolBlockMatchesDesignTarget(blocks, 3, target)).toBe(false)
  })

  it('enumerates only turns for the bound document and keys replay by thread, turn, and board', () => {
    const blocks: ChatBlock[] = [
      { ...userBlock('user_design', target), turnId: 'turn_design' },
      { kind: 'assistant', id: 'assistant_design', turnId: 'turn_design', text: 'done' },
      userBlock('user_other', { documentId: 'doc_other', boardArtifactId: 'board_other' }),
      { kind: 'assistant', id: 'assistant_other', text: 'other' }
    ]

    expect(durableDesignCanvasTurns(blocks, target)).toEqual([{
      userBlockId: 'user_design',
      turnId: 'turn_design',
      blocks: blocks.slice(0, 2)
    }])
    expect(designCanvasReplayKey({
      threadId: 'thread_design', turnId: 'turn_design', target, source: 'tool:shape'
    })).toBe('thread_design\0turn_design\0doc_design\0board_design\0tool:shape')
  })

  it('leaves durable watermark commit to the async follow-up coordinator', () => {
    useCanvasShapeStore.getState().resetDocument()
    const blocks: ChatBlock[] = [
      { ...userBlock('user_design', target), turnId: 'turn_design' },
      { kind: 'assistant', id: 'assistant_design', turnId: 'turn_design', text: 'done' }
    ]

    replayDurableDesignCanvasTurns({
      threadId: 'thread_design',
      blocks,
      target,
      onTurnStart: () => undefined,
      onAssistantText: () => undefined,
      onToolBlock: () => undefined,
      onTurnComplete: () => undefined
    })

    expect(useCanvasShapeStore.getState().document.rendererReplayWatermarkTurnId).toBeUndefined()
  })
})

describe('generated Design image canvas placement', () => {
  afterEach(() => {
    useCanvasShapeStore.getState().resetDocument()
    useCanvasSelectionStore.getState().clearSelection()
    useCanvasViewportStore.getState().resetView()
    resetDesignSystemBoardLayoutForTests()
    useProjectDesignSystemStore.getState().setMissing()
  })

  it('centers a deterministic square in the viewport and is idempotent by image URL', () => {
    useCanvasShapeStore.getState().resetDocument()
    useCanvasViewportStore.getState().setVbox({ x: 100, y: 200, width: 1000, height: 600 })

    const firstId = ensureGeneratedImageOnCanvas('/workspace/.kun/images/hero.png')
    const secondId = ensureGeneratedImageOnCanvas('/workspace/.kun/images/hero.png')
    const images = Object.values(useCanvasShapeStore.getState().document.objects)
      .filter((shape) => shape.type === 'image')

    expect(secondId).toBe(firstId)
    expect(images).toHaveLength(1)
    expect(images[0]).toMatchObject({
      id: firstId,
      name: 'AI image',
      imageUrl: '/workspace/.kun/images/hero.png',
      x: 384,
      y: 284,
      width: 432,
      height: 432
    })
  })

  it('fills one selected empty image placeholder without creating a duplicate', () => {
    useCanvasShapeStore.getState().resetDocument()
    const placeholder = createDefaultShape('image', 20, 30)
    useCanvasShapeStore.getState().addShape(placeholder)
    useCanvasSelectionStore.getState().select([placeholder.id])

    const placedId = ensureGeneratedImageOnCanvas('/workspace/.kun/images/product.png')
    const images = Object.values(useCanvasShapeStore.getState().document.objects)
      .filter((shape) => shape.type === 'image')

    expect(placedId).toBe(placeholder.id)
    expect(images).toHaveLength(1)
    expect(images[0]?.imageUrl).toBe('/workspace/.kun/images/product.png')
  })

  it('places a new generated image outside the design-system board', () => {
    const documentKey = '/workspace\0.kun-design/document/board/canvas.json'
    useCanvasShapeStore.getState().loadDocument(createEmptyDocument(), documentKey)
    useCanvasViewportStore.getState().setVbox({ x: 0, y: 0, width: 1600, height: 1000 })
    useProjectDesignSystemStore.getState().activateWorkspace('/workspace')
    useProjectDesignSystemStore.getState().setReady(parseProjectDesignMd(`---
name: Placement test
colors:
  primary: '#3366ff'
---
# Design
`).document!)
    const board = { x: 160, y: 100, width: 1240, height: 700 }
    setDesignSystemBoardRect(documentKey, board, { persist: false })

    const placedId = ensureGeneratedImageOnCanvas('/workspace/.kun/images/clear.png')
    const image = useCanvasShapeStore.getState().document.objects[placedId ?? '']!
    const overlaps = !(
      image.x + image.width <= board.x ||
      board.x + board.width <= image.x ||
      image.y + image.height <= board.y ||
      board.y + board.height <= image.y
    )

    expect(overlaps).toBe(false)
  })

  it('fills a selected empty holder without changing its bounds', () => {
    useCanvasShapeStore.getState().resetDocument()
    const holder = createDefaultShape('rect', 24, 36)
    holder.width = 360
    holder.height = 220
    holder.aiImageHolder = true
    useCanvasShapeStore.getState().addShape(holder)
    useCanvasSelectionStore.getState().select([holder.id])

    const placedId = ensureGeneratedImageOnCanvas('/workspace/.kun/images/holder.png')
    expect(useCanvasShapeStore.getState().document.objects[placedId ?? '']).toMatchObject({
      id: holder.id,
      type: 'image',
      imageUrl: '/workspace/.kun/images/holder.png',
      x: 24,
      y: 36,
      width: 360,
      height: 220
    })
  })

  it('reuses an image added by ShapeOps before recording the generated-image receipt', () => {
    const imageUrl = '/workspace/.kun/images/tool-placed.png'
    const toolPlaced = createDefaultShape('image', 12, 24)
    toolPlaced.imageUrl = imageUrl
    useCanvasShapeStore.getState().addShape(toolPlaced)

    const placedId = ensureGeneratedImageOnCanvas(imageUrl, {
      replayKey: 'thread\0turn\0doc\0board\0image:completion-tool',
      preferredShapeIds: [toolPlaced.id]
    })

    expect(placedId).toBe(toolPlaced.id)
    expect(Object.values(useCanvasShapeStore.getState().document.objects)
      .filter((shape) => shape.type === 'image')).toHaveLength(1)
  })

  it('uses a durable completion receipt and does not resurrect a deleted placement', () => {
    useCanvasShapeStore.getState().resetDocument()
    const replayKey = 'thread\0turn\0doc\0board\0image:completion-1'
    const placedId = ensureGeneratedImageOnCanvas('/workspace/.kun/images/receipt.png', {
      replayKey
    })
    expect(placedId).toBeTruthy()
    useCanvasShapeStore.getState().deleteShape(placedId!)

    expect(ensureGeneratedImageOnCanvas('/workspace/.kun/images/receipt.png', {
      replayKey
    })).toBeNull()
    expect(Object.values(useCanvasShapeStore.getState().document.objects)
      .filter((shape) => shape.type === 'image')).toHaveLength(0)
  })

  it('places distinct completion identities even when they reuse one image URL', () => {
    const imageUrl = '/workspace/.kun/images/stable-output.png'
    const firstKey = 'thread\0turn\0doc\0board\0image:completion-a'
    const secondKey = 'thread\0turn\0doc\0board\0image:completion-b'

    const firstId = ensureGeneratedImageOnCanvas(imageUrl, { replayKey: firstKey })
    const secondId = ensureGeneratedImageOnCanvas(imageUrl, { replayKey: secondKey })

    expect(secondId).not.toBe(firstId)
    expect(ensureGeneratedImageOnCanvas(imageUrl, { replayKey: firstKey })).toBeNull()
    expect(Object.values(useCanvasShapeStore.getState().document.objects)
      .filter((shape) => shape.type === 'image')).toHaveLength(2)
  })
})
