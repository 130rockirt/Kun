import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CODE_CANVAS_OPEN_REQUEST_EVENT,
  canvasOpenRequestDetail,
  requestCodeCanvasPanelOpen,
  requestWorkCanvasOpen
} from './code-canvas-panel-event'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('requestCodeCanvasPanelOpen', () => {
  it('dispatches the shared workbench canvas-open request', () => {
    const dispatchEvent = vi.fn()
    vi.stubGlobal('window', { dispatchEvent })

    requestCodeCanvasPanelOpen()

    expect(dispatchEvent).toHaveBeenCalledTimes(1)
    expect(dispatchEvent.mock.calls[0]?.[0]).toMatchObject({
      type: CODE_CANVAS_OPEN_REQUEST_EVENT,
      detail: { target: 'code' }
    })
  })

  it('dispatches a target-bearing Work PPT whiteboard request', () => {
    const dispatchEvent = vi.fn()
    vi.stubGlobal('window', { dispatchEvent })

    requestWorkCanvasOpen({
      reason: 'ppt-direction',
      blockId: 'tool-1',
      workspaceRoot: '/work',
      threadId: 'thread-a',
      workflowId: 'workflow-a',
      childId: 'child-a',
      title: 'Pitch deck review'
    })

    const event = dispatchEvent.mock.calls[0]?.[0] as Event
    expect(canvasOpenRequestDetail(event)).toEqual({
      target: 'write',
      reason: 'ppt-direction',
      blockId: 'tool-1',
      workspaceRoot: '/work',
      threadId: 'thread-a',
      workflowId: 'workflow-a',
      childId: 'child-a',
      title: 'Pitch deck review'
    })
  })
})
