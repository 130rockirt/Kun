import { createElement } from 'react'
import { act, create as createRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '../../i18n'
import { UsageQuotaPanel } from './UsageQuotaPanel'

function usageResponse(path: string): { ok: boolean; status: number; body: string } {
  if (path.includes('group_by=day')) {
    return {
      ok: true,
      status: 200,
      body: JSON.stringify({
        group_by: 'day',
        from: '2026-07-01',
        to: '2026-07-29',
        timezone: 'UTC',
        buckets: [{
          date: '2026-07-29',
          input_tokens: 900,
          output_tokens: 100,
          reasoning_tokens: 20,
          cached_tokens: 720,
          cache_miss_tokens: 180,
          total_tokens: 1000,
          cost_usd: 0.01,
          cost_cny: 0.072,
          token_economy_savings_tokens: 100,
          turns: 2,
          thread_count: 1,
          cache_hit_rate: 0.8
        }],
        totals: {}
      })
    }
  }
  if (path.includes('group_by=model')) {
    return {
      ok: true,
      status: 200,
      body: JSON.stringify({
        group_by: 'model',
        from: '2026-07-01',
        to: '2026-07-29',
        timezone: 'UTC',
        buckets: [{
          model: 'deepseek-v4',
          input_tokens: 900,
          output_tokens: 100,
          total_tokens: 1000
        }],
        days: [],
        totals: { total_tokens: 1000 }
      })
    }
  }
  return {
    ok: true,
    status: 200,
    body: JSON.stringify({
      group_by: 'thread',
      buckets: [{
        thread_id: 'thread-a',
        input_tokens: 900,
        output_tokens: 100,
        reasoning_tokens: 20,
        cached_tokens: 720,
        cache_miss_tokens: 180,
        total_tokens: 1000,
        cost_usd: 0.01,
        cost_cny: 0.072,
        token_economy_savings_tokens: 100,
        turns: 2,
        cache_hit_rate: 0.8,
        last_turn_cache_hit_rate: 0.9
      }],
      totals: {}
    })
  }
}

describe('UsageQuotaPanel', () => {
  beforeEach(async () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    await i18n.changeLanguage('en')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('opens on Usage and lazy-loads provider quota only after its tab is selected', async () => {
    const runtimeRequest = vi.fn(async (path: string) => usageResponse(path))
    const listProviderQuotas = vi.fn(async () => ({
      refreshedAt: '2026-07-29T08:00:00.000Z',
      entries: []
    }))
    vi.stubGlobal('window', {
      kunGui: {
        runtimeRequest,
        listProviderQuotas
      }
    })

    let renderer!: ReturnType<typeof createRenderer>
    await act(async () => {
      renderer = createRenderer(createElement(UsageQuotaPanel, {
        activeThreadId: 'thread-a'
      }))
    })

    expect(renderer.root.findByProps({ 'data-usage-quota-panel': true })).toBeTruthy()
    expect(renderer.root.findByProps({ id: 'usage-quota-tab-usage' }).props['aria-selected']).toBe(true)
    expect(renderer.root.findByProps({ id: 'usage-quota-tab-usage' }).props['data-active']).toBe('true')
    expect(renderer.root.findByProps({ id: 'usage-quota-tab-quota' }).props['data-active']).toBe('false')
    expect(renderer.root.findByProps({ 'data-sidebar-usage-panel': true })).toBeTruthy()
    expect(listProviderQuotas).not.toHaveBeenCalled()
    expect(JSON.stringify(renderer.toJSON())).toContain('1.0k')
    expect(JSON.stringify(renderer.toJSON())).toContain('deepseek-v4')

    await act(async () => {
      renderer.root.findByProps({ id: 'usage-quota-tab-quota' }).props.onClick()
    })

    expect(renderer.root.findByProps({ id: 'usage-quota-tab-quota' }).props['aria-selected']).toBe(true)
    expect(renderer.root.findByProps({ id: 'usage-quota-tab-quota' }).props['data-active']).toBe('true')
    expect(renderer.root.findByProps({ 'data-provider-quota-panel': true }).props['data-embedded'])
      .toBe('true')
    expect(renderer.root.findAllByProps({ className: 'provider-quota-header' })).toHaveLength(0)
    expect(renderer.root.findByProps({ 'data-provider-quota-scroller': true })).toBeTruthy()
    expect(listProviderQuotas).toHaveBeenCalledTimes(1)

    act(() => renderer.unmount())
  })

  it('refreshes only the active Usage tab', async () => {
    const runtimeRequest = vi.fn(async (path: string) => usageResponse(path))
    const listProviderQuotas = vi.fn(async () => ({ refreshedAt: '', entries: [] }))
    vi.stubGlobal('window', {
      kunGui: {
        runtimeRequest,
        listProviderQuotas
      }
    })

    let renderer!: ReturnType<typeof createRenderer>
    await act(async () => {
      renderer = createRenderer(createElement(UsageQuotaPanel, {
        activeThreadId: 'thread-a'
      }))
    })
    const initialUsageRequests = runtimeRequest.mock.calls.length

    await act(async () => {
      renderer.root.findByProps({ 'aria-label': 'Refresh' }).props.onClick()
    })

    expect(runtimeRequest.mock.calls.length).toBeGreaterThan(initialUsageRequests)
    expect(listProviderQuotas).not.toHaveBeenCalled()
    act(() => renderer.unmount())
  })

  it('refreshes only provider quota after switching tabs', async () => {
    const runtimeRequest = vi.fn(async (path: string) => usageResponse(path))
    const listProviderQuotas = vi.fn(async () => ({
      refreshedAt: '2026-07-29T08:00:00.000Z',
      entries: []
    }))
    vi.stubGlobal('window', {
      kunGui: {
        runtimeRequest,
        listProviderQuotas
      }
    })

    let renderer!: ReturnType<typeof createRenderer>
    await act(async () => {
      renderer = createRenderer(createElement(UsageQuotaPanel, {
        activeThreadId: 'thread-a'
      }))
    })
    await act(async () => {
      renderer.root.findByProps({ id: 'usage-quota-tab-quota' }).props.onClick()
    })
    const usageRequestsAfterSwitch = runtimeRequest.mock.calls.length

    await act(async () => {
      renderer.root.findByProps({ 'aria-label': 'Refresh' }).props.onClick()
    })

    expect(listProviderQuotas).toHaveBeenCalledTimes(2)
    expect(runtimeRequest).toHaveBeenCalledTimes(usageRequestsAfterSwitch)
    act(() => renderer.unmount())
  })
})
