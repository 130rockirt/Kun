import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WriteImagePreview } from './WriteImagePreview'

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string) => key })
}))

describe('WriteImagePreview', () => {
  let renderer: ReactTestRenderer
  const openEditorPath = vi.fn(async () => ({ ok: true }))
  const saveWorkspaceFileAs = vi.fn(async () => ({
    ok: true,
    path: '/tmp/1.png'
  }))

  beforeEach(async () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    openEditorPath.mockClear()
    saveWorkspaceFileAs.mockClear()
    vi.stubGlobal('window', {
      kunGui: { openEditorPath, saveWorkspaceFileAs }
    })
    await act(async () => {
      renderer = create(
        createElement(WriteImagePreview, {
          src: 'data:image/png;base64,AAAA',
          filePath: '/repo/pic/1.png',
          mimeType: 'image/png',
          size: 115_610,
          workspaceRoot: '/repo'
        })
      )
    })
  })

  afterEach(async () => {
    await act(async () => renderer.unmount())
    vi.unstubAllGlobals()
  })

  it('renders one unified header and an integrated image status bar', async () => {
    expect(renderer.root.findByProps({ 'aria-label': 'writeModePreview' }).props['aria-pressed']).toBe('true')
    expect(renderer.root.findByProps({ 'aria-label': 'writeImageZoom' }).props.value).toBe(100)

    await act(async () => {
      renderer.root.findByType('img').props.onLoad({
        currentTarget: { naturalWidth: 584, naturalHeight: 228 }
      })
    })

    const text = JSON.stringify(renderer.toJSON())
    const statusValues = renderer.root
      .findAll((node) => node.type === 'span' && node.props.className?.includes('font-mono'))
      .map((node) => node.children.join(''))
    expect(text).toContain('pic/1.png')
    expect(statusValues).toEqual(['image/png', '112.9 KB', '584 × 228', '100%'])
  })

  it('keeps edit, download, and zoom controls functional', async () => {
    await act(async () => renderer.root.findByProps({ 'aria-label': 'agentsView.edit' }).props.onClick())
    expect(openEditorPath).toHaveBeenCalledWith({
      path: '/repo/pic/1.png',
      workspaceRoot: '/repo',
      editorId: 'system'
    })

    await act(async () => renderer.root.findByProps({ 'aria-label': 'generatedFileDownload' }).props.onClick())
    expect(saveWorkspaceFileAs).toHaveBeenCalledWith({
      suggestedName: '1.png',
      sourcePath: '/repo/pic/1.png',
      workspaceRoot: '/repo',
      mimeType: 'image/png'
    })

    await act(async () => renderer.root.findByProps({ 'aria-label': 'writeImageZoomIn' }).props.onClick())
    expect(renderer.root.findByProps({ 'aria-label': 'writeImageZoom' }).props.value).toBe(125)
    expect(JSON.stringify(renderer.toJSON())).toContain('125%')
  })
})
