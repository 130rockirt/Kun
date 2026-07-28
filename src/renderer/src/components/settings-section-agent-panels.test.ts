import { createElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { defaultKunBrowserUseSettings } from '@shared/app-settings'
import {
  BrowserUseSettingsPanel,
  ComputerUseSettingsPanel,
  DesignQualitySettingsPanel
} from './settings-section-agent-panels'

function textContent(node: ReactTestInstance): string {
  return node.children.map((child) => typeof child === 'string' ? child : textContent(child)).join('')
}

describe('BrowserUseSettingsPanel', () => {
  it('defaults to auto-safe and keeps bounded controls plus an off switch', () => {
    const onChange = vi.fn()
    const t = (key: string): string => key
    let renderer!: ReactTestRenderer
    act(() => {
      renderer = create(createElement(BrowserUseSettingsPanel, {
        t,
        value: defaultKunBrowserUseSettings(),
        selectControlClass: 'select',
        onChange
      }))
    })
    expect(textContent(renderer.root)).toContain('browserUseZeroTrustBody')
    const selects = renderer.root.findAllByType('select')
    expect(selects).toHaveLength(7)
    expect(selects[0]?.props.value).toBe('public')
    expect(selects[1]?.props.value).toBe('auto-safe')
    expect(selects[2]?.props.value).toBe(2)

    const toggle = renderer.root.findAllByType('button').find((button) =>
      button.props.role === 'switch'
    )
    act(() => toggle?.props.onClick())
    expect(onChange).toHaveBeenCalledWith({ enabled: false })

    act(() => {
      renderer.update(createElement(BrowserUseSettingsPanel, {
        t,
        value: { ...defaultKunBrowserUseSettings(), enabled: false },
        selectControlClass: 'select',
        onChange
      }))
    })
    expect(renderer.root.findAllByType('select')).toHaveLength(0)
  })

  it('lets a tab panel own spacing instead of adding an outer top margin', () => {
    const t = (key: string): string => key
    const onChange = vi.fn()
    let renderer!: ReactTestRenderer
    act(() => {
      renderer = create(createElement(
        'div',
        null,
        createElement(ComputerUseSettingsPanel, {
          t,
          value: { enabled: false, mode: 'auto' },
          selectControlClass: 'select',
          permissionRow: null,
          onChange
        }),
        createElement(BrowserUseSettingsPanel, {
          t,
          value: { ...defaultKunBrowserUseSettings(), enabled: false },
          selectControlClass: 'select',
          onChange
        }),
        createElement(DesignQualitySettingsPanel, {
          t,
          value: { enabled: false, strictness: 'standard' },
          selectControlClass: 'select',
          onChange
        })
      ))
    })

    expect(renderer.root.findAllByType('section')).toHaveLength(3)
    expect(renderer.root.findAll((node) =>
      typeof node.props.className === 'string'
      && node.props.className.split(/\s+/).includes('mt-6')
    )).toHaveLength(0)
  })
})
