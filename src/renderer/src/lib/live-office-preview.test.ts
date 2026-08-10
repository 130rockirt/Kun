import { describe, expect, it, vi } from 'vitest'
import {
  isOfficePreviewPath,
  LIVE_OFFICE_PREVIEW_EVENT,
  latestLiveOfficePreview,
  normalizeLiveOfficePreviewPath,
  publishLiveOfficePreview
} from './live-office-preview'

describe('live Office preview event', () => {
  it('recognizes supported Office paths without treating unrelated files as Office documents', () => {
    expect(isOfficePreviewPath('/workspace/brief.DOCX')).toBe(true)
    expect(isOfficePreviewPath('sheets/budget.xls')).toBe(true)
    expect(isOfficePreviewPath('slides/demo.pptx')).toBe(true)
    expect(isOfficePreviewPath('notes/brief.pdf')).toBe(false)
    expect(isOfficePreviewPath('')).toBe(false)
  })

  it('publishes the typed browser event when a renderer window is available', () => {
    const dispatchEvent = vi.fn()
    class PreviewEvent<T> {
      constructor(readonly type: string, readonly init: { detail: T }) {}

      get detail(): T {
        return this.init.detail
      }
    }
    vi.stubGlobal('window', { dispatchEvent })
    vi.stubGlobal('CustomEvent', PreviewEvent)

    publishLiveOfficePreview({
      path: 'reports/brief.docx',
      workspaceRoot: '/workspace/project',
      turnId: 'turn_1',
      phase: 'committed',
      expectedSha256: 'a'.repeat(64)
    })

    expect(dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: LIVE_OFFICE_PREVIEW_EVENT,
      detail: {
        path: 'reports/brief.docx',
        workspaceRoot: '/workspace/project',
        turnId: 'turn_1',
        phase: 'committed',
        expectedSha256: 'a'.repeat(64)
      }
    }))
    vi.unstubAllGlobals()
  })

  it('uses one workspace-relative identity for relative calls and absolute results', () => {
    const dispatchEvent = vi.fn()
    class PreviewEvent<T> {
      constructor(readonly type: string, readonly init: { detail: T }) {}

      get detail(): T {
        return this.init.detail
      }
    }
    vi.stubGlobal('window', { dispatchEvent })
    vi.stubGlobal('CustomEvent', PreviewEvent)

    publishLiveOfficePreview({
      path: 'reports/brief.docx',
      workspaceRoot: '/workspace/project',
      turnId: 'turn_1',
      phase: 'editing'
    })
    publishLiveOfficePreview({
      path: '/workspace/project/reports/brief.docx',
      workspaceRoot: '/workspace/project',
      turnId: 'turn_1',
      phase: 'committed',
      expectedSha256: 'b'.repeat(64)
    })

    expect(normalizeLiveOfficePreviewPath('/workspace/project/reports/brief.docx', '/workspace/project'))
      .toBe('reports/brief.docx')
    expect(normalizeLiveOfficePreviewPath(
      'C:\\Project\\Reports\\brief.docx',
      'c:\\project'
    )).toBe('Reports/brief.docx')
    expect(normalizeLiveOfficePreviewPath(
      '\\\\server\\share\\Reports\\brief.docx',
      '\\\\server\\share'
    )).toBe('Reports/brief.docx')
    expect(latestLiveOfficePreview('reports/brief.docx', '/workspace/project')).toMatchObject({
      path: 'reports/brief.docx',
      phase: 'committed',
      expectedSha256: 'b'.repeat(64)
    })
    expect(dispatchEvent).toHaveBeenLastCalledWith(expect.objectContaining({
      detail: expect.objectContaining({ path: 'reports/brief.docx' })
    }))
    vi.unstubAllGlobals()
  })
})
