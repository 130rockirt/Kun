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
      documentId: 'doc_1',
      surfaceKind: 'kun-design'
    })
  })

  it('replaces a previous target when another document is requested', () => {
    useCodeCanvasDesignSurface.getState().showDesignDocument('thr_1', '/root/a', 'doc_1')
    useCodeCanvasDesignSurface.getState().showDesignDocument('thr_2', '/root/b', 'doc_2')
    expect(useCodeCanvasDesignSurface.getState().surface).toEqual({
      threadId: 'thr_2',
      workspaceRoot: '/root/b',
      documentId: 'doc_2',
      surfaceKind: 'kun-design'
    })
  })

  it('keeps the pinned board and read-only flags when requested', () => {
    useCodeCanvasDesignSurface.getState().showDesignDocument('thr_1', '/root/a', 'doc_1', {
      boardArtifactId: 'board-a',
      readOnly: true,
      canonicalDocumentId: 'doc-canonical'
    })
    expect(useCodeCanvasDesignSurface.getState().surface).toEqual({
      threadId: 'thr_1',
      workspaceRoot: '/root/a',
      documentId: 'doc_1',
      surfaceKind: 'kun-design',
      boardArtifactId: 'board-a',
      readOnly: true,
      canonicalDocumentId: 'doc-canonical'
    })
  })

  it('clears the surface', () => {
    useCodeCanvasDesignSurface.getState().showDesignDocument('thr_1', '/root/a', 'doc_1')
    useCodeCanvasDesignSurface.getState().clearDesignSurface()
    expect(useCodeCanvasDesignSurface.getState().surface).toBeNull()
  })

  it('restores a previously captured target after a failed provisional send', () => {
    const previous = {
      threadId: 'thr_code',
      workspaceRoot: '/root/a',
      documentId: 'doc_code_canvas',
      surfaceKind: 'kun-design' as const
    }
    useCodeCanvasDesignSurface.getState().showDesignDocument('thr_code', '/root/a', 'doc_temp')
    useCodeCanvasDesignSurface.getState().restoreDesignSurface(previous)
    expect(useCodeCanvasDesignSurface.getState().surface).toEqual(previous)
  })

  it('restoring null clears the surface like an explicit clear', () => {
    useCodeCanvasDesignSurface.getState().showDesignDocument('thr_code', '/root/a', 'doc_temp')
    useCodeCanvasDesignSurface.getState().restoreDesignSurface(null)
    expect(useCodeCanvasDesignSurface.getState().surface).toBeNull()
  })
})
