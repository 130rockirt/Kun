import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { highlightCodeHtml } = vi.hoisted(() => ({
  highlightCodeHtml: vi.fn<(code: string, language: string) => Promise<string>>()
}))

vi.mock('../lib/code-highlighting', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/code-highlighting')>(),
  highlightCodeHtml
}))

import {
  WorkspaceCodePreview,
  WORKSPACE_CODE_PREVIEW_MAX_LINES
} from './WorkspaceCodePreview'

describe('WorkspaceCodePreview', () => {
  let renderer!: ReactTestRenderer

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    highlightCodeHtml.mockReset()
  })

  afterEach(async () => {
    await act(async () => renderer.unmount())
  })

  it('renders escaped inert fallback content with line numbers', async () => {
    highlightCodeHtml.mockReturnValue(new Promise(() => undefined))

    await act(async () => {
      renderer = create(createElement(WorkspaceCodePreview, {
        content: '<script>alert("unsafe")</script>\nconst answer = 42\n',
        path: '/workspace/src/example.ts',
        className: 'h-full'
      }))
    })

    const preview = renderer.root.findByProps({ 'data-workspace-code-preview': true })
    expect(preview.props.className).toContain('h-full')
    expect(preview.props['data-language']).toBe('ts')
    expect(renderer.root.findByProps({ className: 'ds-file-preview-line-numbers' })
      .children[0]).toBe('1\n2\n3')

    const html = renderer.root.findByProps({ className: 'ds-file-preview-code-html' })
      .props.dangerouslySetInnerHTML.__html as string
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<script>')
    expect(renderer.root.findAllByType('textarea')).toHaveLength(0)
  })

  it('replaces the fallback with shared Shiki output for the path language', async () => {
    const highlighted = '<pre class="shiki"><code><span class="line"><span>const</span></span></code></pre>'
    highlightCodeHtml.mockResolvedValue(highlighted)

    await act(async () => {
      renderer = create(createElement(WorkspaceCodePreview, {
        content: 'const value = 1',
        path: '/workspace/src/example.tsx'
      }))
      await Promise.resolve()
    })

    expect(highlightCodeHtml).toHaveBeenCalledWith('const value = 1', 'tsx')
    expect(renderer.root.findByProps({ className: 'ds-file-preview-code-html' })
      .props.dangerouslySetInnerHTML.__html).toBe(highlighted)
  })

  it('bounds dense files before rendering line numbers or highlighting', async () => {
    highlightCodeHtml.mockReturnValue(new Promise(() => undefined))
    const content = `${'x\n'.repeat(WORKSPACE_CODE_PREVIEW_MAX_LINES + 5)}tail`

    await act(async () => {
      renderer = create(createElement(WorkspaceCodePreview, {
        content,
        path: '/workspace/events.log',
        limitMessage: 'Preview limited'
      }))
    })

    const preview = renderer.root.findByProps({ 'data-workspace-code-preview': true })
    expect(preview.props['data-preview-limited']).toBe(true)
    expect(renderer.root.findByProps({ 'data-workspace-code-preview-limit': true })
      .children[0]).toBe('Preview limited')
    const renderedContent = highlightCodeHtml.mock.calls[0][0]
    expect(renderedContent.split('\n')).toHaveLength(WORKSPACE_CODE_PREVIEW_MAX_LINES)
    const lineNumbers = renderer.root.findByProps({ className: 'ds-file-preview-line-numbers' })
      .children[0] as string
    expect(lineNumbers.startsWith('1\n2\n3\n')).toBe(true)
    expect(lineNumbers.endsWith(String(WORKSPACE_CODE_PREVIEW_MAX_LINES))).toBe(true)
  })
})
