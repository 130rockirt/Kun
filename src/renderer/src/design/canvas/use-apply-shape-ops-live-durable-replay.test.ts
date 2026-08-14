import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { describe, expect, it } from 'vitest'
import type { ChatBlock } from '../../agent/types'
import { useChatStore } from '../../store/chat-store'
import { canvasDocumentKey } from './canvas-persistence'
import { useCanvasSelectionStore } from './canvas-selection-store'
import { useCanvasShapeStore } from './canvas-shape-store'
import { createDefaultShape, createEmptyDocument } from './canvas-types'
import { useApplyShapeOpsLive } from './use-apply-shape-ops-live'

const durableTarget = { documentId: 'doc-design', boardArtifactId: 'board-design' }
const durableDocumentKey = canvasDocumentKey(
  '/workspace', durableTarget.boardArtifactId, `.kun-design/${durableTarget.documentId}`
)

function DurableDesignReplayHarness(): null {
  useApplyShapeOpsLive(
    true, undefined, undefined, undefined, 'thread-design', undefined, undefined,
    durableTarget, durableDocumentKey
  )
  return null
}

describe('useApplyShapeOpsLive durable Design replay', () => {
  it('shares receipts between live application and idle remount replay', async () => {
    const previous = useChatStore.getState()
    const blocks: ChatBlock[] = [
      {
        kind: 'user', id: 'user-live', turnId: 'turn-live', text: 'Build live',
        meta: { designDocumentTarget: durableTarget }
      },
      {
        kind: 'assistant', id: 'assistant-live', turnId: 'turn-live',
        text: '```shapeops\n[{"op":"add","shape":{"type":"rect","name":"Live card","x":10,"y":10,"width":100,"height":60}}]\n```'
      }
    ]
    useCanvasShapeStore.getState().loadDocument(createEmptyDocument(), durableDocumentKey)
    useChatStore.setState({
      activeThreadId: 'thread-design', currentTurnId: 'turn-live',
      currentTurnUserId: 'user-live', busy: true, blocks, liveAssistant: ''
    })

    let renderer: ReturnType<typeof create> | undefined
    await act(async () => { renderer = create(createElement(DurableDesignReplayHarness)) })
    const visibleShapes = () => Object.values(useCanvasShapeStore.getState().document.objects)
      .filter((shape) => shape.id !== useCanvasShapeStore.getState().document.rootId)
    expect(visibleShapes()).toHaveLength(1)
    expect(useCanvasShapeStore.getState().document.rendererReplayKeys).toHaveLength(1)

    await act(async () => {
      useChatStore.setState({ currentTurnId: null, currentTurnUserId: null, busy: false })
      const materialized = useCanvasShapeStore.getState().document
      expect(materialized.rendererReplayWatermarkTurnId).toBe('turn-live')
      useCanvasShapeStore.getState().loadDocument({
        ...materialized,
        rendererReplayKeys: Array.from({ length: 4096 }, (_, index) => `evicted:${index}`)
      }, durableDocumentKey)
      renderer?.unmount()
      renderer = create(createElement(DurableDesignReplayHarness))
    })
    expect(visibleShapes()).toHaveLength(1)

    await act(async () => renderer?.unmount())
    useCanvasShapeStore.getState().resetDocument()
    useCanvasSelectionStore.getState().clearSelection()
    useChatStore.setState({
      activeThreadId: previous.activeThreadId, currentTurnId: previous.currentTurnId,
      currentTurnUserId: previous.currentTurnUserId, busy: previous.busy,
      blocks: previous.blocks, liveAssistant: previous.liveAssistant
    })
  })

  it('replays missed ShapeOps and generated images after remount and reload', async () => {
    const previous = useChatStore.getState()
    const blocks: ChatBlock[] = [
      {
        kind: 'user', id: 'user-shapes', turnId: 'turn-shapes', text: 'Build the board',
        meta: { designDocumentTarget: durableTarget }
      },
      {
        kind: 'assistant', id: 'assistant-shapes', turnId: 'turn-shapes',
        text: '```design_canvas\n{"action":"update_shapes","ops":[{"op":"add","shape":{"type":"text","name":"Title","textContent":"Dashboard","x":20,"y":20,"width":200,"height":40}}]}\n```'
      },
      {
        kind: 'tool', id: 'tool-shapes', turnId: 'turn-shapes', summary: 'Add card', status: 'success',
        meta: { toolName: 'design_update_shapes', sourceItemKind: 'tool_result' },
        detail: '{"ops":[{"op":"add","shape":{"type":"rect","name":"Card","x":20,"y":80,"width":240,"height":120}}]}'
      },
      {
        kind: 'user', id: 'user-image', turnId: 'turn-image', text: 'Create the hero image',
        meta: { designDocumentTarget: durableTarget }
      },
      {
        kind: 'tool', id: 'tool-image', turnId: 'turn-image', summary: 'Generated image', status: 'success',
        detail: '{}',
        meta: {
          toolName: 'generate_image', sourceItemKind: 'tool_result',
          generatedFiles: [{ relativePath: '.kun/images/hero.png', absolutePath: '/workspace/.kun/images/hero.png' }]
        }
      }
    ]
    useCanvasShapeStore.getState().loadDocument(createEmptyDocument(), durableDocumentKey)
    useChatStore.setState({
      activeThreadId: 'thread-design', currentTurnId: null, currentTurnUserId: null,
      busy: false, blocks, liveAssistant: ''
    })

    let renderer: ReturnType<typeof create> | undefined
    await act(async () => { renderer = create(createElement(DurableDesignReplayHarness)) })
    const visibleShapes = () => Object.values(useCanvasShapeStore.getState().document.objects)
      .filter((shape) => shape.id !== useCanvasShapeStore.getState().document.rootId)
    expect(visibleShapes().map((shape) => shape.type).sort()).toEqual(['image', 'rect', 'text'])

    await act(async () => renderer?.unmount())
    await act(async () => { renderer = create(createElement(DurableDesignReplayHarness)) })
    expect(visibleShapes()).toHaveLength(3)

    await act(async () => {
      useCanvasShapeStore.getState().loadDocument(createEmptyDocument(), durableDocumentKey)
    })
    expect(visibleShapes().map((shape) => shape.type).sort()).toEqual(['image', 'rect', 'text'])

    await act(async () => renderer?.unmount())
    useCanvasShapeStore.getState().resetDocument()
    useCanvasSelectionStore.getState().clearSelection()
    useChatStore.setState({
      activeThreadId: previous.activeThreadId, currentTurnId: previous.currentTurnId,
      currentTurnUserId: previous.currentTurnUserId, busy: previous.busy,
      blocks: previous.blocks, liveAssistant: previous.liveAssistant
    })
  })

  it('places a primary AI-image result even when the same turn applies ShapeOps', async () => {
    const previous = useChatStore.getState()
    const blocks: ChatBlock[] = [
      {
        kind: 'user', id: 'user-image-and-shape', turnId: 'turn-image-and-shape',
        text: 'Create the campaign visual',
        meta: {
          designDocumentTarget: durableTarget,
          designProfile: {
            version: 1,
            documentTarget: durableTarget,
            outputMedium: 'image',
            target: 'web',
            preset: 'none',
            context: { tone: [] }
          }
        }
      },
      {
        kind: 'assistant', id: 'assistant-image-and-shape', turnId: 'turn-image-and-shape',
        text: '```shapeops\n[{"op":"add","shape":{"type":"rect","name":"Backdrop","x":10,"y":10,"width":320,"height":240}}]\n```'
      },
      {
        kind: 'tool', id: 'tool-image-and-shape', turnId: 'turn-image-and-shape',
        summary: 'Generated image', status: 'success', detail: '{}',
        meta: {
          toolName: 'generate_image', sourceItemKind: 'tool_result',
          generatedFiles: [{
            relativePath: '.kun/images/campaign.png',
            absolutePath: '/workspace/.kun/images/campaign.png',
            completionIdentity: 'image-completion-1'
          }]
        }
      }
    ]
    useCanvasShapeStore.getState().loadDocument(createEmptyDocument(), durableDocumentKey)
    useChatStore.setState({
      activeThreadId: 'thread-design', currentTurnId: null, currentTurnUserId: null,
      busy: false, blocks, liveAssistant: ''
    })

    let renderer: ReturnType<typeof create> | undefined
    await act(async () => { renderer = create(createElement(DurableDesignReplayHarness)) })
    const visibleShapes = () => Object.values(useCanvasShapeStore.getState().document.objects)
      .filter((shape) => shape.id !== useCanvasShapeStore.getState().document.rootId)
    expect(visibleShapes().map((shape) => shape.type).sort()).toEqual(['image', 'rect'])
    expect(useCanvasShapeStore.getState().document.rendererReplayKeys)
      .toEqual(expect.arrayContaining([expect.stringContaining('image:image-completion-1')]))

    await act(async () => {
      renderer?.unmount()
      renderer = create(createElement(DurableDesignReplayHarness))
    })
    expect(visibleShapes().map((shape) => shape.type).sort()).toEqual(['image', 'rect'])

    await act(async () => renderer?.unmount())
    useCanvasShapeStore.getState().resetDocument()
    useCanvasSelectionStore.getState().clearSelection()
    useChatStore.setState({
      activeThreadId: previous.activeThreadId, currentTurnId: previous.currentTurnId,
      currentTurnUserId: previous.currentTurnUserId, busy: previous.busy,
      blocks: previous.blocks, liveAssistant: previous.liveAssistant
    })
  })

  it('restores an original image-holder placement after app restart', async () => {
    const previous = useChatStore.getState()
    useCanvasShapeStore.getState().loadDocument(createEmptyDocument(), durableDocumentKey)
    const holder = createDefaultShape('rect', 72, 96)
    holder.width = 480
    holder.height = 270
    useCanvasShapeStore.getState().addShape(holder)
    const persistedBeforeCompletion = structuredClone(useCanvasShapeStore.getState().document)
    useCanvasSelectionStore.getState().clearSelection()
    useCanvasShapeStore.getState().loadDocument(persistedBeforeCompletion, durableDocumentKey)
    const blocks: ChatBlock[] = [
      {
        kind: 'user', id: 'user-restart-image', turnId: 'turn-restart-image',
        text: 'Generate the hero',
        meta: {
          designDocumentTarget: durableTarget,
          designProfile: {
            version: 1, documentTarget: durableTarget, outputMedium: 'image',
            target: 'web', preset: 'none', context: { tone: [] }
          },
          designImagePlacementTarget: {
            shapeId: holder.id, expectedHolderKind: 'implicit-rect'
          }
        }
      },
      {
        kind: 'tool', id: 'tool-restart-image', turnId: 'turn-restart-image',
        summary: 'Generated image', status: 'success', detail: '{}',
        meta: {
          toolName: 'generate_image', sourceItemKind: 'tool_result',
          generatedFiles: [{
            absolutePath: '/workspace/.kun/images/restarted.png',
            completionIdentity: 'restart-completion'
          }]
        }
      }
    ]
    useChatStore.setState({
      activeThreadId: 'thread-design', currentTurnId: null,
      currentTurnUserId: null, busy: false, blocks, liveAssistant: ''
    })

    let renderer: ReturnType<typeof create> | undefined
    await act(async () => { renderer = create(createElement(DurableDesignReplayHarness)) })
    expect(useCanvasShapeStore.getState().document.objects[holder.id]).toMatchObject({
      id: holder.id, type: 'image', imageUrl: '/workspace/.kun/images/restarted.png',
      x: 72, y: 96, width: 480, height: 270
    })
    expect(Object.values(useCanvasShapeStore.getState().document.objects)
      .filter((shape) => shape.type === 'image')).toHaveLength(1)

    await act(async () => renderer?.unmount())
    useCanvasShapeStore.getState().resetDocument()
    useCanvasSelectionStore.getState().clearSelection()
    useChatStore.setState({
      activeThreadId: previous.activeThreadId, currentTurnId: previous.currentTurnId,
      currentTurnUserId: previous.currentTurnUserId, busy: previous.busy,
      blocks: previous.blocks, liveAssistant: previous.liveAssistant
    })
  })
})
