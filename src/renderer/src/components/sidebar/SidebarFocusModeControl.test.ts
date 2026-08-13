/** @vitest-environment jsdom */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

vi.mock('../chat/AnimatedWorkLogo', async () => {
  const { createElement: createMockElement } = await import('react')
  return {
    SidebarMascot: () => createMockElement('span', { 'data-testid': 'sidebar-mascot' })
  }
})

import { SidebarFocusModeControl } from './SidebarFocusModeControl'

function setReactActEnvironment(value: boolean): void {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
    .IS_REACT_ACT_ENVIRONMENT = value
}

describe('SidebarFocusModeControl', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    setReactActEnvironment(true)
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    setReactActEnvironment(false)
  })

  it('exposes the preference as a switch and reports the next state', async () => {
    const onChange = vi.fn()
    await act(async () => {
      root.render(createElement(SidebarFocusModeControl, { enabled: false, onChange }))
    })

    let toggle = container.querySelector<HTMLButtonElement>('[role="switch"]')
    expect(toggle?.getAttribute('aria-checked')).toBe('false')
    expect(toggle?.getAttribute('aria-label')).toBe('focusModeToggleLabel')
    expect(toggle?.title).toContain('switchOff')
    expect(container.querySelector('[data-testid="sidebar-mascot"]')).not.toBeNull()

    await act(async () => toggle?.click())
    expect(onChange).toHaveBeenLastCalledWith(true)

    await act(async () => {
      root.render(createElement(SidebarFocusModeControl, { enabled: true, onChange }))
    })

    toggle = container.querySelector<HTMLButtonElement>('[role="switch"]')
    expect(toggle?.getAttribute('aria-checked')).toBe('true')
    expect(toggle?.title).toContain('switchOn')
    expect(container.querySelector('[data-testid="sidebar-mascot"]')).toBeNull()

    await act(async () => toggle?.click())
    expect(onChange).toHaveBeenLastCalledWith(false)
  })
})
