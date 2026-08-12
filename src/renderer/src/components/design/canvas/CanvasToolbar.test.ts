import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { useDesignWorkspaceStore } from '../../../design/design-workspace-store'
import { CanvasToolbar } from './CanvasToolbar'

describe('CanvasToolbar prototype playback', () => {
  it('hides design-only controls on the code canvas', () => {
    const html = renderToStaticMarkup(
      createElement(CanvasToolbar, {
        workspaceRoot: '/workspace',
        surface: 'code',
        onExportCanvas: async () => {}
      })
    )

    expect(html).toContain('aria-label="Select"')
    expect(html).toContain('aria-label="Frame"')
    expect(html).toContain('aria-label="AI image"')
    expect(html).toContain('aria-label="Upload image to whiteboard"')
    expect(html).toContain('aria-label="Export whiteboard"')
    expect(html).not.toContain('aria-label="AI image slot"')
    expect(html).not.toContain('aria-label="Upload files to canvas"')
    expect(html).not.toContain('aria-label="Screen"')
    expect(html).not.toContain('aria-label="Design context"')
    expect(html).not.toContain('aria-label="Agent actions"')
    expect(html).not.toContain('aria-label="Critique canvas"')
    expect(html).not.toContain('aria-label="Open design assistant"')
    expect(html).not.toContain('aria-label="Play prototype"')
  })

  it('uses the diagram toolset on the central Work whiteboard', () => {
    const html = renderToStaticMarkup(
      createElement(CanvasToolbar, {
        workspaceRoot: '/workspace',
        surface: 'work',
        onExportCanvas: async () => {}
      })
    )

    expect(html).toContain('aria-label="Select"')
    expect(html).toContain('aria-label="AI image"')
    expect(html).toContain('aria-label="Export whiteboard"')
    expect(html).not.toContain('aria-label="Screen"')
    expect(html).not.toContain('aria-label="Play prototype"')
  })

  it('shows agent action seeds on the design canvas', () => {
    const html = renderToStaticMarkup(
      createElement(CanvasToolbar, {
        workspaceRoot: '/workspace'
      })
    )

    expect(html).toContain('aria-label="Agent actions"')
  })

  it('keeps the design canvas toolbar focused on screen workflow controls', () => {
    const html = renderToStaticMarkup(
      createElement(CanvasToolbar, {
        workspaceRoot: '/workspace'
      })
    )

    expect(html).toContain('aria-label="Select"')
    expect(html).toContain('aria-label="Screen"')
    expect(html).toContain('aria-label="Frame"')
    expect(html).toContain('aria-label="Hand"')
    expect(html).toContain('aria-label="Upload files to canvas"')
    expect(html).not.toContain('aria-label="AI image slot"')
    expect(html).not.toContain('aria-label="Rectangle"')
    expect(html).not.toContain('aria-label="Ellipse"')
    expect(html).not.toContain('aria-label="Text"')
    expect(html).not.toContain('aria-label="Arrow"')
    expect(html).not.toContain('aria-label="Line"')
    expect(html).not.toContain('aria-label="Draw"')
  })

  it('explains why prototype playback is disabled before a screen exists', () => {
    const html = renderToStaticMarkup(
      createElement(CanvasToolbar, {
        workspaceRoot: '/workspace',
        prototypePlayable: false,
        onOpenPrototypePlayer: () => {}
      })
    )

    expect(html).toContain('Create at least one screen before playing the prototype')
    expect(html).toContain(
      'aria-label="Create at least one screen before playing the prototype"'
    )
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*title="Create at least one screen before playing the prototype"/)
  })

  it('keeps the normal play affordance when prototype screens exist', () => {
    const html = renderToStaticMarkup(
      createElement(CanvasToolbar, {
        workspaceRoot: '/workspace',
        prototypePlayable: true,
        onOpenPrototypePlayer: () => {}
      })
    )

    expect(html).toContain('aria-label="Play prototype"')
    expect(html).not.toContain('Create at least one screen before playing the prototype')
  })

  it('labels the open design assistant button as a collapsible toggle', () => {
    useDesignWorkspaceStore.setState({ canvasAssistantOpen: true, aiRailCollapsed: false })
    const openHtml = renderToStaticMarkup(
      createElement(CanvasToolbar, {
        workspaceRoot: '/workspace'
      })
    )
    expect(openHtml).toContain('aria-label="Collapse assistant"')
    expect(openHtml).toContain('aria-pressed="true"')
  })
})
