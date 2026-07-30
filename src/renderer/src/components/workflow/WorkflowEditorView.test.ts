import { describe, expect, it } from 'vitest'
import {
  WORKFLOW_EDITOR_BACK_BUTTON_CLASS,
  WORKFLOW_EDITOR_HEADER_CLASS,
  WORKFLOW_EDITOR_HEADER_SIDEBAR_COLLAPSED_CLASS,
  WORKFLOW_EDITOR_SIDEBAR_CLASS
} from './WorkflowEditorView'

describe('WorkflowEditorView', () => {
  it('keeps the full-window editor opaque and reserves titlebar space only when collapsed', async () => {
    const nodeFs = 'node:fs/promises'
    const { readFile } = await import(/* @vite-ignore */ nodeFs)
    const css = await readFile(new URL('../../styles/workflow-canvas.css', import.meta.url), 'utf8')
    const source = await readFile(new URL('./WorkflowEditorView.tsx', import.meta.url), 'utf8')

    expect(WORKFLOW_EDITOR_HEADER_CLASS).toContain('workflow-editor-header')
    expect(WORKFLOW_EDITOR_HEADER_CLASS).toContain('ds-drag')
    expect(WORKFLOW_EDITOR_HEADER_CLASS).not.toContain('py-')
    expect(WORKFLOW_EDITOR_SIDEBAR_CLASS).toContain('workflow-editor-sidebar')
    expect(WORKFLOW_EDITOR_SIDEBAR_CLASS).toContain('ds-drag')
    expect(WORKFLOW_EDITOR_SIDEBAR_CLASS).toContain('ds-sidebar-surface')
    expect(WORKFLOW_EDITOR_SIDEBAR_CLASS).not.toContain('bg-ds-card/40')
    expect(WORKFLOW_EDITOR_BACK_BUTTON_CLASS).toContain('workflow-editor-back-button')
    expect(WORKFLOW_EDITOR_BACK_BUTTON_CLASS).toContain('ds-no-drag')
    expect(css).toContain('.workflow-editor-overlay')
    expect(css).toContain('.workflow-editor-inspector')
    expect(css).toContain('background-color: var(--ds-sidebar-surface-bg)')
    expect(css).toContain('.workflow-editor-header')
    expect(css).toContain('height: 4rem')
    expect(css).toContain(":root[data-platform='darwin'] .workflow-editor-header")
    expect(css).toContain('padding-top: 1rem')
    expect(css).toContain('padding-bottom: 0.5rem')
    expect(css).toContain(`:root[data-platform='darwin'] .${WORKFLOW_EDITOR_HEADER_SIDEBAR_COLLAPSED_CLASS}`)
    expect(css).toContain('var(--ds-collapsed-sidebar-titlebar-extra-inset)')
    expect(source).toContain('className={WORKFLOW_EDITOR_SIDEBAR_CLASS}')
    expect(source).toContain('className={WORKFLOW_EDITOR_BACK_BUTTON_CLASS}')
    expect(source).toContain('className="workflow-editor-overlay')
    expect(source).toContain('className="workflow-editor-canvas-shell')
    expect(source).toContain('className="workflow-editor-inspector')
    expect(source.indexOf('className={WORKFLOW_EDITOR_SIDEBAR_CLASS}')).toBeLessThan(
      source.indexOf('className={`${WORKFLOW_EDITOR_HEADER_CLASS}')
    )
  })

  it('provides a complete Grand Line workflow treatment through host-owned hooks', async () => {
    const nodeFs = 'node:fs/promises'
    const { readFile } = await import(/* @vite-ignore */ nodeFs)
    const [css, nodesSource, configSource] = await Promise.all([
      readFile(new URL('../../styles/workflow-canvas.css', import.meta.url), 'utf8'),
      readFile(new URL('./WorkflowNodes.tsx', import.meta.url), 'utf8'),
      readFile(new URL('./NodeConfigPanel.tsx', import.meta.url), 'utf8')
    ])

    const scope = "html[data-ui-plugin='grand-line-logbook']"
    expect(css).toContain(`${scope} .workflow-editor-sidebar`)
    expect(css).toContain(`${scope} .workflow-editor-header`)
    expect(css).toContain(`${scope} .ds-workflow-canvas`)
    expect(css).toContain(`${scope} .workflow-canvas-node`)
    expect(css).toContain(`${scope} .workflow-editor-inspector`)
    expect(css).toContain(`${scope} .workflow-node-config-empty`)
    expect(css).toContain('@media (max-width: 1180px)')
    expect(nodesSource).toContain('className={`workflow-canvas-node')
    expect(nodesSource).toContain("data-workflow-status={status ?? 'idle'}")
    expect(configSource).toContain('className="workflow-node-config-empty')
    expect(configSource).toContain('className="workflow-node-config-panel')
  })
})
