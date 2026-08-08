import { beforeEach, describe, expect, it } from 'vitest'
import { useCodeCanvasDesignSurface } from './code-canvas-design-surface'

describe('code canvas design surface', () => {
  beforeEach(() => {
    useCodeCanvasDesignSurface.getState().clearDesignSurface()
  })

  it('starts empty', () => {
    expect(useCodeCanvasDesignSurface.getState().surface).toBeNull()
  })

  it('records the requested design document with thread scope', () => {
    useCodeCanvasDesignSurface.getState().showDesignDocument('thr_1', '/root/a', 'doc_1')
    expect(useCodeCanvasDesignSurface.getState().surface).toEqual({
      threadId: 'thr_1',
      workspaceRoot: '/root/a',
      documentId: 'doc_1'
    })
  })

  it('replaces a previous target when another document is requested', () => {
    useCodeCanvasDesignSurface.getState().showDesignDocument('thr_1', '/root/a', 'doc_1')
    useCodeCanvasDesignSurface.getState().showDesignDocument('thr_2', '/root/b', 'doc_2')
    expect(useCodeCanvasDesignSurface.getState().surface).toEqual({
      threadId: 'thr_2',
      workspaceRoot: '/root/b',
      documentId: 'doc_2'
    })
  })

  it('clears the surface', () => {
    useCodeCanvasDesignSurface.getState().showDesignDocument('thr_1', '/root/a', 'doc_1')
    useCodeCanvasDesignSurface.getState().clearDesignSurface()
    expect(useCodeCanvasDesignSurface.getState().surface).toBeNull()
  })
})
