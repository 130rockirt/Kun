import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceOfficePreviewSuccess } from '@shared/office-document'
import { WorkspaceOfficePreview } from './WorkspaceOfficePreview'

vi.mock('./WorkspaceDocxPreview', () => ({
  WorkspaceDocxPreview: (props: unknown) => createElement('article', {
    ...(props as object), 'data-local-word-mock': 'true'
  })
}))
vi.mock('./WorkspacePptxPreview', () => ({ WorkspacePptxPreview: () => createElement('aside') }))
vi.mock('./WorkspaceSpreadsheetPreview', () => ({ WorkspaceSpreadsheetPreview: () => createElement('section') }))
vi.mock('./WpsOfficeEditor', () => ({
  WpsOfficeEditor: (props: unknown) => createElement('div', {
    ...(props as object), 'data-wps-office-editor-mock': 'true'
  })
}))

function preview(viewer: WorkspaceOfficePreviewSuccess['viewer']): WorkspaceOfficePreviewSuccess {
  const renderFormat = viewer === 'word' ? 'docx' : viewer === 'presentation' ? 'pptx' : 'xlsx'
  return {
    ok: true, path: `/repo/fixture.${renderFormat}`, name: `fixture.${renderFormat}`,
    sourceFormat: renderFormat, renderFormat, viewer, size: 3, mtimeMs: 1,
    sourceSha256: 'a'.repeat(64), data: new Uint8Array([1, 2, 3])
  }
}

describe('WorkspaceOfficePreview provider boundary', () => {
  let renderer: ReactTestRenderer

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })
  afterEach(async () => {
    if (renderer) await act(async () => renderer.unmount())
  })

  for (const viewer of ['word', 'presentation', 'spreadsheet'] as const) {
    it(`routes explicit WPS ${viewer} mode to the shared WPS editor`, async () => {
      const result = preview(viewer)
      await act(async () => {
        renderer = create(createElement(WorkspaceOfficePreview, {
          result, providerMode: 'wps', loading: true,
          refreshError: 'WPS session unavailable'
        }))
      })
      const props = renderer.root.findByProps({ 'data-wps-office-editor-mock': 'true' }).props
      expect(props).toMatchObject({
        result, loading: true, error: 'WPS session unavailable', readOnly: true
      })
    })
  }

  it('keeps the current local renderer until WPS mode is explicitly selected', async () => {
    const result = preview('word')
    await act(async () => {
      renderer = create(createElement(WorkspaceOfficePreview, { result, loading: false }))
    })
    expect(renderer.root.findByProps({ 'data-local-word-mock': 'true' }).props.result).toEqual(result)
    expect(renderer.root.findAllByProps({ 'data-wps-office-editor-mock': 'true' })).toHaveLength(0)
  })
})
