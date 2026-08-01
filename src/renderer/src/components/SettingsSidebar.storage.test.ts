import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { SettingsSidebar } from './SettingsSidebar'

const t = (key: string): string => key

describe('Windows storage settings navigation', () => {
  it('shows Storage on Windows and hides it on other platforms', () => {
    const windows = renderToStaticMarkup(createElement(SettingsSidebar, {
      category: 'general',
      goBack: vi.fn(),
      setCategory: vi.fn(),
      platform: 'win32',
      t
    }))
    const mac = renderToStaticMarkup(createElement(SettingsSidebar, {
      category: 'general',
      goBack: vi.fn(),
      setCategory: vi.fn(),
      platform: 'darwin',
      t
    }))
    expect(windows).toContain('storageRelocation')
    expect(mac).not.toContain('storageRelocation')
  })
})
