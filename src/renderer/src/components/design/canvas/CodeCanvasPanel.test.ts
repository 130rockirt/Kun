import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  CodeCanvasPanel,
  codeCanvasPanelShellClass,
  codeCanvasPanelTitlebarClass
} from './CodeCanvasPanel'

describe('CodeCanvasPanel', () => {
  it('uses code whiteboard copy in the sidebar shell', () => {
    const html = renderToStaticMarkup(
      createElement(CodeCanvasPanel, {
        workspaceRoot: '/workspace',
        activeThreadId: null,
        onCollapse: () => {}
      })
    )

    expect(html).toContain('Whiteboard')
    expect(html).toContain('Open or start a conversation to use the whiteboard.')
    expect(html).not.toContain('Open or start a conversation to use the canvas.')
  })

  it('uses a floating canvas chrome instead of a docked sidebar header', () => {
    const html = renderToStaticMarkup(
      createElement(CodeCanvasPanel, {
        workspaceRoot: '/workspace',
        activeThreadId: null,
        onCollapse: () => {}
      })
    )

    expect(codeCanvasPanelShellClass('h-full')).toContain('overflow-hidden')
    expect(codeCanvasPanelShellClass('h-full')).toContain('bg-[#f8fafc]')
    expect(codeCanvasPanelTitlebarClass()).toContain('rounded-full')
    expect(codeCanvasPanelTitlebarClass()).toContain('backdrop-blur-2xl')
    expect(html).toContain('data-code-canvas-titlebar="true"')
    expect(html).not.toContain('border-b border-ds-border-muted bg-white/92')
  })

  it('keeps a classified Design task in its Design loading state before target hydration', () => {
    const html = renderToStaticMarkup(
      createElement(CodeCanvasPanel, {
        workspaceRoot: '/workspace',
        activeThreadId: 'design-thread',
        designTaskActive: true,
        onCollapse: () => {}
      })
    )

    expect(html).toContain('Loading')
    expect(html).not.toContain('Open or start a conversation to use the whiteboard.')
  })
})
