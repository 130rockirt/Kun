import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatBlock } from '../../agent/types'
import { useChatStore } from '../../store/chat-store'
import { WORK_WHITEBOARD_DIR } from '../../write/work-whiteboard'
import { canvasDocumentKey } from './canvas-persistence'
import { useCanvasSelectionStore } from './canvas-selection-store'
import { useCanvasShapeStore } from './canvas-shape-store'
import { createDefaultShape, createEmptyDocument } from './canvas-types'
import { useApplyShapeOpsLive } from './use-apply-shape-ops-live'

const mocks = vi.hoisted(() => ({ sendReceipt: vi.fn() }))

vi.mock('./canvas-receipt-sender', () => ({
  sendCanvasTurnReceipt: (...args: unknown[]) => mocks.sendReceipt(...args)
}))

const threadId = 'thread-work'
const documentKey = canvasDocumentKey('/work', 'board-1', WORK_WHITEBOARD_DIR)

function WorkReplayHarness(): null {
  useApplyShapeOpsLive(
    true, undefined, { screenFallback: 'plain-frame', shapePreset: 'diagram' },
    'work-canvas:board-1', threadId, undefined, undefined, undefined,
    documentKey, undefined, 'work'
  )
  return null
}

function completedTextUpdateTurn(): ChatBlock[] {
  return [
    {
      kind: 'user', id: 'user-translate', turnId: 'turn-translate',
      text: 'Translate every visible whiteboard label to English.',
      meta: { guiDesignCanvas: true }
    },
    {
      kind: 'tool', id: 'tool-translate', turnId: 'turn-translate',
      summary: 'Design update shapes', status: 'success',
      meta: { toolName: 'design_update_shapes', sourceItemKind: 'tool_result' },
      detail: JSON.stringify({
        ok: true,
        tool: 'design_update_shapes',
        action: 'update_shapes',
        ops: [{
          op: 'update', id: 'label-service',
          patch: { textContent: 'Business Rules' }
        }]
      })
    }
  ]
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  mocks.sendReceipt.mockClear()
  const document = createEmptyDocument()
  const label = createDefaultShape('text', 40, 40)
  label.id = 'label-service'
  label.parentId = document.rootId
  label.textContent = '业务规则'
  document.objects[label.id] = label
  document.objects[document.rootId]!.children.push(label.id)
  useCanvasShapeStore.getState().loadDocument(document, documentKey)
  useChatStore.setState({
    activeThreadId: threadId,
    currentTurnId: null,
    currentTurnUserId: null,
    busy: false,
    blocks: completedTextUpdateTurn(),
    liveAssistant: ''
  })
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

describe('useApplyShapeOpsLive Work replay', () => {
  it('applies a completed Work canvas result after the turn is already idle exactly once', async () => {
    let renderer: ReturnType<typeof create> | undefined
    await act(async () => { renderer = create(createElement(WorkReplayHarness)) })

    const label = () => useCanvasShapeStore.getState().document.objects['label-service']
    expect(label()?.textContent).toBe('Business Rules')
    expect(useCanvasShapeStore.getState().document.rendererReplayKeys).toContain(
      'thread-work\0turn-translate\0code-canvas\0tool:tool-translate'
    )

    await act(async () => {
      renderer?.unmount()
      renderer = create(createElement(WorkReplayHarness))
    })
    expect(label()?.textContent).toBe('Business Rules')

    await act(async () => renderer?.unmount())
  })

  it('applies existing text and acknowledges its tool before the turn ends', async () => {
    useChatStore.setState({
      currentTurnId: 'turn-translate',
      currentTurnUserId: 'user-translate',
      busy: true,
      blocks: completedTextUpdateTurn().map((block) => block.kind === 'tool'
        ? {
            ...block,
            detail: JSON.stringify({
              ok: true,
              tool: 'design_update_shapes',
              action: 'update_shapes',
              status: 'accepted',
              receiptKey: 'design-receipt-text',
              ops: [{
                op: 'update', id: 'label-service',
                patch: { textContent: 'Business Rules' }
              }]
            })
          }
        : block)
    })

    let renderer: ReturnType<typeof create> | undefined
    await act(async () => { renderer = create(createElement(WorkReplayHarness)) })

    expect(useCanvasShapeStore.getState().document.objects['label-service']?.textContent)
      .toBe('Business Rules')
    expect(useChatStore.getState().currentTurnId).toBe('turn-translate')
    expect(mocks.sendReceipt).toHaveBeenCalledWith({
      threadId: 'thread-work',
      turnId: 'turn-translate',
      receiptKey: 'design-receipt-text',
      affectedIds: ['label-service'],
      errors: []
    })

    await act(async () => renderer?.unmount())
  })
})
