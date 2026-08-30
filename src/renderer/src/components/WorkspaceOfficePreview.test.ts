import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceOfficePreviewSuccess } from '@shared/office-document'
import { WorkspaceOfficePreview } from './WorkspaceOfficePreview'

vi.mock('./WorkspaceDocxPreview', () => ({
  WorkspaceDocxPreview: (props: unknown) => createElement('article', props as object)
}))
vi.mock('./WorkspacePptxPreview', () => ({
  WorkspacePptxPreview: (props: unknown) => createElement('aside', props as object)
}))
vi.mock('./WorkspaceSpreadsheetPreview', () => ({
  WorkspaceSpreadsheetPreview: (props: unknown) => createElement('section', props as object)
}))

function preview(viewer: WorkspaceOfficePreviewSuccess['viewer']): WorkspaceOfficePreviewSuccess {
  const renderFormat = viewer === 'word' ? 'docx' : viewer === 'presentation' ? 'pptx' : 'xlsx'
  return {
    ok: true,
    path: `/repo/fixture.${renderFormat}`,
    name: `fixture.${renderFormat}`,
    sourceFormat: renderFormat,
    renderFormat,
    viewer,
    size: 3,
    mtimeMs: 1,
    sourceSha256: 'a'.repeat(64),
    data: new Uint8Array([1, 2, 3])
  }
}

describe('WorkspaceOfficePreview', () => {
  let renderer: ReactTestRenderer

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(async () => {
    if (renderer) await act(async () => renderer.unmount())
  })

  for (const [viewer, element] of [
    ['word', 'article'],
    ['presentation', 'aside'],
    ['spreadsheet', 'section']
  ] as const) {
    it(`routes ${viewer} binary data to its browser renderer`, async () => {
      const result = preview(viewer)
      const onPresentationViewChange = vi.fn()
      await act(async () => {
        renderer = create(createElement(WorkspaceOfficePreview, {
          result,
          loading: true,
          refreshError: 'refresh failed',
          onPresentationViewChange,
          presentationKeyboardActive: false
        }))
      })

      const renderedProps = renderer.root.find((node) => node.type === element).props
      expect(renderedProps).toMatchObject({
        result,
        loading: true,
        refreshError: 'refresh failed'
      })
      if (viewer === 'presentation') {
        expect(renderedProps).toMatchObject({
          keyboardActive: false,
          onPresentationViewChange
        })
      }
    })
  }
})
