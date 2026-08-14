import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatBlock } from '../../agent/types'
import { useChatStore } from '../../store/chat-store'
import { CODE_CANVAS_DIR, codeCanvasArtifactId } from './code-canvas'
import { canvasDocumentKey } from './canvas-persistence'
import { useCanvasSelectionStore } from './canvas-selection-store'
import { useCanvasShapeStore } from './canvas-shape-store'
import { createEmptyDocument } from './canvas-types'
import { useApplyShapeOpsLive } from './use-apply-shape-ops-live'

const threadId = 'thread-code'
const documentKey = canvasDocumentKey(
  '/workspace', codeCanvasArtifactId(threadId), CODE_CANVAS_DIR
)

function CodeReplayHarness(): null {
  useApplyShapeOpsLive(
    true, undefined, undefined, undefined, threadId, undefined, undefined,
    undefined, documentKey, undefined, 'code'
  )
  return null
}

const blocks: ChatBlock[] = [
  {
    kind: 'user', id: 'user-place-image', turnId: 'turn-place-image',
    text: 'Put the generated image on the whiteboard.'
  },
  {
    kind: 'tool', id: 'tool-place-image', turnId: 'turn-place-image',
    summary: 'Design update shapes', status: 'success',
    meta: { toolName: 'design_update_shapes', sourceItemKind: 'tool_result' },
    detail: JSON.stringify({
      ok: true,
      tool: 'design_update_shapes',
      action: 'update_shapes',
      ops: [{
        op: 'add',
        shape: {
          type: 'image',
          name: 'Session History User Assistant Button',
          x: -640,
          y: -400,
          width: 1280,
          height: 800,
          imageUrl: '.kun/images/session-history-user-assistant.png'
        }
      }]
    })
  }
]

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
})

afterEach(() => {
  useCanvasShapeStore.getState().resetDocument()
  useCanvasSelectionStore.getState().clearSelection()
  useChatStore.setState({
    activeThreadId: null,
    currentTurnId: null,
    currentTurnUserId: null,
    busy: false,
    blocks: [],
    liveAssistant: ''
  })
  vi.unstubAllGlobals()
})

describe('useApplyShapeOpsLive Code replay', () => {
  it('leaves a Design-targeted result for the bound Design whiteboard', async () => {
    const designBlocks: ChatBlock[] = [
      {
        kind: 'user', id: 'user-design-image', turnId: 'turn-design-image',
        text: 'Put the generated image on the Design whiteboard.',
        meta: {
          designDocumentTarget: {
            documentId: 'doc-design',
            boardArtifactId: 'board-design'
          }
        }
      },
      {
        ...blocks[1],
        id: 'tool-design-image',
        turnId: 'turn-design-image'
      }
    ]
    useCanvasShapeStore.getState().loadDocument(createEmptyDocument(), documentKey)
    useChatStore.setState({
      activeThreadId: threadId,
      currentTurnId: null,
      currentTurnUserId: null,
      busy: false,
      blocks: designBlocks,
      liveAssistant: ''
    })

    let renderer: ReturnType<typeof create> | undefined
    await act(async () => { renderer = create(createElement(CodeReplayHarness)) })

    expect(Object.values(useCanvasShapeStore.getState().document.objects)
      .filter((shape) => shape.type === 'image')).toHaveLength(0)
    expect(useCanvasShapeStore.getState().document.rendererReplayKeys ?? []).toEqual([])

    await act(async () => renderer?.unmount())
  })

  it('delivers a completed result after the matching Code canvas becomes ready once', async () => {
    useCanvasShapeStore.getState().loadDocument(createEmptyDocument(), null)
    useChatStore.setState({
      activeThreadId: threadId,
      currentTurnId: null,
      currentTurnUserId: null,
      busy: false,
      blocks,
      liveAssistant: ''
    })

    let renderer: ReturnType<typeof create> | undefined
    await act(async () => { renderer = create(createElement(CodeReplayHarness)) })
    expect(Object.values(useCanvasShapeStore.getState().document.objects)
      .filter((shape) => shape.type === 'image')).toHaveLength(0)

    await act(async () => {
      useCanvasShapeStore.getState().loadDocument(createEmptyDocument(), documentKey)
    })
    const images = () => Object.values(useCanvasShapeStore.getState().document.objects)
      .filter((shape) => shape.type === 'image')
    expect(images()).toHaveLength(1)
    expect(images()[0]).toMatchObject({
      imageUrl: '.kun/images/session-history-user-assistant.png',
      x: -640,
      y: -400,
      width: 1280,
      height: 800
    })
    expect(useCanvasShapeStore.getState().document.rendererReplayKeys).toContain(
      'thread-code\0turn-place-image\0code-canvas\0tool:tool-place-image'
    )

    await act(async () => {
      renderer?.unmount()
      renderer = create(createElement(CodeReplayHarness))
    })
    expect(images()).toHaveLength(1)

    await act(async () => renderer?.unmount())
  })
})
