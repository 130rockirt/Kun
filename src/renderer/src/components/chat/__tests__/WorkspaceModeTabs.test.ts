import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '../../../i18n'
import { WorkspaceModeTabs } from '../WorkspaceModeTabs'

describe('WorkspaceModeTabs', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
  })

  function props(activeView: 'chat' | 'workflow' | 'write' | 'design' = 'chat') {
    return {
      activeView,
      onCodeOpen: vi.fn(),
      onWriteOpen: vi.fn()
    }
  }

  function renderInteractive(activeView: 'chat' | 'workflow' | 'write' | 'design' = 'chat') {
    const componentProps = props(activeView)
    let renderer!: ReactTestRenderer
    act(() => {
      renderer = create(createElement(WorkspaceModeTabs, componentProps))
    })
    return { componentProps, renderer }
  }

  it('renders one compact Code/Work menu trigger instead of segmented tabs', () => {
    const html = renderToStaticMarkup(createElement(WorkspaceModeTabs, props()))

    expect(html).toContain('data-workspace-mode-trigger="true"')
    expect(html).toContain('data-workspace-mode="chat"')
    expect(html).toContain('aria-haspopup="menu"')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('border-transparent')
    expect(html).toContain('bg-transparent')
    expect(html).toContain('hover:bg-[var(--ds-sidebar-field-bg)]')
    expect(html).not.toContain('border-[var(--ds-sidebar-row-ring)]')
    expect(html).not.toContain('role="tablist"')
    expect(html).not.toContain('role="tab"')
    expect(html).not.toContain('data-workspace-mode="design"')
  })

  it('opens an overlaid menu with Code and Work descriptions', () => {
    const { renderer } = renderInteractive()
    const trigger = renderer.root.findByProps({ 'data-workspace-mode-trigger': true })

    act(() => trigger.props.onClick())

    const options = renderer.root.findAllByProps({ role: 'menuitemradio' })
    expect(options).toHaveLength(2)
    expect(options.map((option) => option.props['data-workspace-mode'])).toEqual(['write', 'chat'])
    expect(renderer.root.findAllByProps({ role: 'menu' })).toHaveLength(1)
    const rendered = JSON.stringify(renderer.toJSON())
    expect(rendered).toContain('Build, debug, and ship')
    expect(rendered).toContain('Write, organize, and handle everyday tasks')
    act(() => renderer.unmount())
  })

  it('marks the current mode and invokes only the newly selected mode callback', () => {
    const { componentProps, renderer } = renderInteractive()
    const trigger = renderer.root.findByProps({ 'data-workspace-mode-trigger': true })
    act(() => trigger.props.onClick())

    const options = renderer.root.findAllByProps({ role: 'menuitemradio' })
    expect(options[0]?.props['aria-checked']).toBe(false)
    expect(options[1]?.props['aria-checked']).toBe(true)

    act(() => options[0]?.props.onClick())

    expect(componentProps.onWriteOpen).toHaveBeenCalledOnce()
    expect(componentProps.onCodeOpen).not.toHaveBeenCalled()
    expect(renderer.root.findAllByProps({ role: 'menu' })).toHaveLength(0)
    act(() => renderer.unmount())
  })

  it('opens with arrow keys for keyboard navigation', () => {
    const { renderer } = renderInteractive()
    const trigger = renderer.root.findByProps({ 'data-workspace-mode-trigger': true })
    const preventDefault = vi.fn()

    act(() => trigger.props.onKeyDown({ key: 'ArrowDown', preventDefault }))

    expect(preventDefault).toHaveBeenCalledOnce()
    expect(renderer.root.findAllByProps({ role: 'menuitemradio' })).toHaveLength(2)
    act(() => renderer.unmount())
  })

  it('uses Work as the trigger value in the Work workspace', () => {
    const html = renderToStaticMarkup(createElement(WorkspaceModeTabs, props('write')))

    expect(html).toContain('data-workspace-mode="write"')
    expect(html).toContain('title="Work"')
  })

  it('projects legacy Design and subordinate Code views through Code', () => {
    for (const activeView of ['design', 'workflow'] as const) {
      const html = renderToStaticMarkup(createElement(WorkspaceModeTabs, props(activeView)))
      expect(html).toContain('data-workspace-mode="chat"')
      expect(html).not.toContain('data-workspace-mode="design"')
    }
  })

  it('keeps the trigger label visible in narrow sidebars', () => {
    const html = renderToStaticMarkup(createElement(WorkspaceModeTabs, props()))

    expect(html).toContain('workspace-mode-tab-label')
    expect(html).toContain('min-w-0')
    expect(html).not.toContain('flex-1')
  })

  it('exposes a descriptive label and locks mode navigation when requested', () => {
    const html = renderToStaticMarkup(createElement(WorkspaceModeTabs, {
      ...props('design'),
      disabled: true,
      disabledReason: 'Preparing the drawing'
    }))

    expect(html).toContain(`aria-label="${i18n.t('code')} / ${i18n.t('workspaceModeWorkLabel')}"`)
    expect(html).toContain('disabled=""')
    expect(html).toContain('title="Preparing the drawing"')
    expect(html).not.toContain('role="menu"')
  })
})
