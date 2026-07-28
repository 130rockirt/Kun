import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderQuotaListResult } from '@shared/provider-quota'
import type { KunTrayProviderQuotaApi } from '@shared/tray-provider-quota'
import i18n from '../../i18n'
import { TrayProviderQuotaPopover } from './TrayProviderQuotaPopover'

const result: ProviderQuotaListResult = {
  refreshedAt: '2026-07-28T02:30:00.000Z',
  entries: [
    {
      providerId: 'codex',
      providerName: 'Codex',
      status: 'available',
      source: 'ChatGPT Codex usage API',
      dashboardUrl: 'https://chatgpt.com/codex/settings/usage',
      metrics: [{
        id: 'weekly',
        label: 'Weekly',
        unit: 'requests',
        used: 23,
        limit: 100,
        remaining: 77,
        usedPercent: 23,
        resetsAt: '2026-08-03T00:00:00.000Z'
      }]
    },
    {
      providerId: 'claude-subscription',
      providerName: 'Claude subscription',
      status: 'unsupported',
      metrics: [],
      message: 'No supported endpoint'
    }
  ]
}

function createApi(overrides: Partial<KunTrayProviderQuotaApi> = {}): KunTrayProviderQuotaApi {
  return {
    list: vi.fn(async () => result),
    context: vi.fn(async () => ({
      locale: 'en' as const,
      colorMode: 'light' as const,
      platform: 'win32' as const
    })),
    action: vi.fn(async () => undefined),
    openExternal: vi.fn(async () => undefined),
    onRefresh: vi.fn(() => () => undefined),
    ...overrides
  }
}

describe('TrayProviderQuotaPopover', () => {
  let keydown: ((event: KeyboardEvent) => void) | undefined

  beforeAll(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })

  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT
  })

  beforeEach(async () => {
    await i18n.changeLanguage('en')
    keydown = undefined
    vi.stubGlobal('document', {
      documentElement: { lang: 'en', dataset: {} }
    })
    vi.stubGlobal('window', {
      addEventListener: vi.fn((name: string, handler: (event: KeyboardEvent) => void) => {
        if (name === 'keydown') keydown = handler
      }),
      removeEventListener: vi.fn()
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('selects the first configured provider and exposes overview/provider tabs', async () => {
    const api = createApi()
    let renderer!: ReactTestRenderer
    await act(async () => {
      renderer = create(createElement(TrayProviderQuotaPopover, { api }))
    })

    const tabs = renderer.root.findAllByProps({ role: 'tab' })
    expect(tabs).toHaveLength(3)
    expect(tabs[1].props['aria-selected']).toBe(true)
    expect((document.documentElement.dataset as Record<string, string>).platform).toBe('win32')
    expect(JSON.stringify(renderer.toJSON())).toContain('Weekly')
    expect(JSON.stringify(renderer.toJSON())).toContain('77 requests')

    await act(async () => tabs[0].props.onClick())
    expect(renderer.root.findAllByProps({ role: 'tab' })[0].props['aria-selected']).toBe(true)
    expect(JSON.stringify(renderer.toJSON())).toContain('Claude subscription')
    await act(async () => renderer.unmount())
  })

  it('retains the last quota data when a refresh fails', async () => {
    let publishRefresh: (() => void) | undefined
    const list = vi.fn()
      .mockResolvedValueOnce(result)
      .mockRejectedValueOnce(new Error('provider offline'))
    const api = createApi({
      list,
      onRefresh: vi.fn((handler) => {
        publishRefresh = handler
        return () => undefined
      })
    })
    let renderer!: ReactTestRenderer
    await act(async () => {
      renderer = create(createElement(TrayProviderQuotaPopover, { api }))
    })
    await act(async () => publishRefresh?.())

    const html = JSON.stringify(renderer.toJSON())
    expect(html).toContain('provider offline')
    expect(html).toContain('Weekly')
    await act(async () => renderer.unmount())
  })

  it('dispatches close on Escape and new-chat from the fixed action footer', async () => {
    const api = createApi()
    let renderer!: ReactTestRenderer
    await act(async () => {
      renderer = create(createElement(TrayProviderQuotaPopover, { api }))
    })

    await act(async () => keydown?.({ key: 'Escape' } as KeyboardEvent))
    const newChat = renderer.root.findAllByType('button').find(
      (button) => button.children.includes('New chat')
    )
    expect(newChat).toBeDefined()
    await act(async () => newChat!.props.onClick())

    expect(api.action).toHaveBeenCalledWith('close')
    expect(api.action).toHaveBeenCalledWith('new-chat')
    await act(async () => renderer.unmount())
  })

  it('keeps providers in one horizontal row and quota details independently scrollable', async () => {
    const nodeFs = 'node:fs/promises'
    const { readFile } = await import(/* @vite-ignore */ nodeFs)
    const css = await readFile(new URL('../../styles/tray-provider-quota.css', import.meta.url), 'utf8')

    expect(css).toMatch(/\.tray-quota-tabs \{[\s\S]*display: flex/)
    expect(css).toMatch(/\.tray-provider-tab \{[\s\S]*flex: 1 0 56px/)
    expect(css).toMatch(/\.tray-quota-switcher \{[\s\S]*overflow-x: auto/)
    expect(css).toMatch(/\.tray-quota-switcher \{[\s\S]*overflow-y: hidden/)
    expect(css).toMatch(/\.tray-quota-content \{[\s\S]*min-height: 0;[\s\S]*overflow-y: auto/)
    expect(css).toMatch(/\.tray-quota-footer \{[\s\S]*flex: none/)
    expect(css).toContain(':root[data-platform="win32"] .tray-quota-popover')
    expect(css).toContain('@media (forced-colors: active)')
  })
})
