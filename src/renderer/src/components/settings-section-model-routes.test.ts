import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { act, create as createRenderer, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  defaultModelProviderSettings,
  getModelProviderPreset,
  modelProviderPresetAccountProfile,
  type ModelProviderSettingsV1
} from '@shared/app-settings'
import { ModelRoutesSettings } from './settings-section-model-routes'

function settings(): ModelProviderSettingsV1 {
  const defaults = defaultModelProviderSettings()
  return {
    ...defaults,
    localGateway: { enabled: true, name: 'Kun API' },
    routePools: [
      {
        id: 'kimi-pool', name: 'Kimi 容量池', modelId: 'kimi-auto', enabled: true, strategy: 'adaptive',
        targets: [{ id: 'target', providerId: defaults.providers[0].id, modelId: defaults.providers[0].models[0], enabled: true, weight: 2 }],
        failurePolicy: { failoverHttpStatusCodes: [429, 503], failoverOnNetworkError: true, failoverOnTimeout: true, failoverOnAuthError: true },
        healthPolicy: { failureThreshold: 3, cooldownMs: 60_000, halfOpenMaxAttempts: 1 }
      },
      {
        id: 'code-pool', name: 'Coding 容量池', modelId: 'code-auto', enabled: true, strategy: 'priority',
        targets: [{ id: 'code-target', providerId: defaults.providers[0].id, modelId: defaults.providers[0].models[0], enabled: true, weight: 1 }],
        failurePolicy: { failoverHttpStatusCodes: [429, 503], failoverOnNetworkError: true, failoverOnTimeout: true, failoverOnAuthError: true },
        healthPolicy: { failureThreshold: 3, cooldownMs: 60_000, halfOpenMaxAttempts: 1 }
      }
    ]
  }
}

describe('ModelRoutesSettings', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('renders four persistent task tabs with matching panels', () => {
    const html = renderToStaticMarkup(createElement(ModelRoutesSettings, {
      settings: settings(),
      onChange: () => undefined
    }))

    for (const tabId of ['gateway', 'models', 'resilience', 'monitoring']) {
      expect(html).toContain(`id="model-routes-settings-tab-${tabId}"`)
      expect(html).toContain(`aria-controls="model-routes-settings-panel-${tabId}"`)
      expect(html).toContain(`id="model-routes-settings-panel-${tabId}"`)
      expect(html).toContain(`aria-labelledby="model-routes-settings-tab-${tabId}"`)
    }
  })

  it('pauses Runtime polling while its persistent parent panel is hidden', async () => {
    vi.useFakeTimers()
    const runtimeRequest = vi.fn(async () => ({
      ok: true,
      status: 200,
      body: '{"localGateway":{"enabled":true},"pools":[],"metrics":{},"events":[]}'
    }))
    vi.stubGlobal('window', { kunGui: { runtimeRequest } })

    let renderer!: ReactTestRenderer
    await act(async () => {
      renderer = createRenderer(createElement(ModelRoutesSettings, {
        settings: settings(),
        onChange: () => undefined,
        active: false
      }))
    })
    expect(runtimeRequest).not.toHaveBeenCalled()

    await act(async () => {
      renderer.update(createElement(ModelRoutesSettings, {
        settings: settings(),
        onChange: () => undefined,
        active: true
      }))
      await Promise.resolve()
    })
    expect(runtimeRequest).toHaveBeenCalledOnce()

    await act(async () => {
      renderer.update(createElement(ModelRoutesSettings, {
        settings: settings(),
        onChange: () => undefined,
        active: false
      }))
    })
    await act(async () => {
      vi.advanceTimersByTime(1_100)
      await Promise.resolve()
    })
    expect(runtimeRequest).toHaveBeenCalledOnce()

    await act(async () => renderer.unmount())
  })

  it('renders one local provider with multiple routed models and safety policy', () => {
    const html = renderToStaticMarkup(createElement(ModelRoutesSettings, { settings: settings(), onChange: () => undefined }))
    expect(html).toContain('本地中转供应商')
    expect(html).toContain('Kun API')
    expect(html).toContain('2 / 2 个模型已启用')
    expect(html).toContain('路由模型')
    expect(html).toContain('Kimi 容量池')
    expect(html).toContain('kimi-auto')
    expect(html).toContain('Coding 容量池')
    expect(html).toContain('code-auto')
    expect(html).toContain('添加模型')
    expect(html).toContain('稳定性优先自适应')
    expect(html).toContain('流式输出开始后固定停止')
    expect(html).toContain('仅本机访问 · 无鉴权')
    expect(html).toContain('http://127.0.0.1:18899/v1')
    expect(html).toContain('GET /models')
    expect(html).toContain('POST /chat/completions')
    expect(html).toContain('POST /responses')
  })

  it('opens a detailed local API dialog with endpoint examples', async () => {
    vi.stubGlobal('window', {
      kunGui: {
        runtimeRequest: vi.fn(async () => ({ ok: true, status: 200, body: '{"localGateway":{"enabled":true},"pools":[],"metrics":{},"events":[]}' }))
      }
    })
    let renderer: ReactTestRenderer
    await act(async () => {
      renderer = createRenderer(createElement(ModelRoutesSettings, {
        settings: settings(),
        onChange: () => undefined,
        publicBaseUrl: 'http://127.0.0.1:19999'
      }))
    })

    await act(async () => {
      const button = renderer!.root.findAllByType('button').find((item) => item.children.join('')?.includes('接口说明'))
      button!.props.onClick()
    })

    expect(renderer!.root.findByProps({ role: 'dialog' })).toBeDefined()
    const dialogTree = JSON.stringify(renderer!.toJSON())
    expect(dialogTree).toContain('本地 API 说明')
    expect(dialogTree).toContain('Chat Completions')
    expect(dialogTree).toContain('http://127.0.0.1:19999/v1')
    expect(dialogTree).toContain('/chat/completions')

    await act(async () => { renderer!.unmount() })
  })

  it('keeps every numbered account available as an independent route target', () => {
    const draft = settings()
    const kimi = getModelProviderPreset('kimi-code')!
    const first = modelProviderPresetAccountProfile(kimi, 'api', [])!
    const second = modelProviderPresetAccountProfile(kimi, 'api', [first])!
    draft.providers = [...draft.providers, first, second]
    draft.routePools[0].targets = [
      { id: 'kimi-1', providerId: first.id, modelId: first.models[0], enabled: true, weight: 1 },
      { id: 'kimi-2', providerId: second.id, modelId: second.models[0], enabled: true, weight: 1 }
    ]

    const html = renderToStaticMarkup(createElement(ModelRoutesSettings, { settings: draft, onChange: () => undefined }))
    expect(html).toContain('Kimi Code')
    expect(html).toContain('Kimi Code 2')
    expect(html).toContain('value="kimi-code"')
    expect(html).toContain('value="kimi-code-2"')
  })

  it('dispatches local API and route pool enable switches', async () => {
    const draft = settings()
    draft.localGateway.enabled = false
    draft.routePools[0].enabled = false
    const onChange = vi.fn()
    vi.stubGlobal('window', {
      kunGui: {
        runtimeRequest: vi.fn(async () => ({ ok: true, status: 200, body: '{"pools":[],"metrics":{},"events":[]}' }))
      }
    })
    let renderer: ReactTestRenderer
    await act(async () => {
      renderer = createRenderer(createElement(ModelRoutesSettings, { settings: draft, onChange }))
    })

    await act(async () => {
      renderer!.root.findByProps({ 'aria-label': '开放本地 API' }).props.onClick()
    })
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({
      localGateway: expect.objectContaining({ enabled: true })
    }))

    await act(async () => {
      renderer!.root.findByProps({ 'aria-label': '启用路由池' }).props.onClick()
    })
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({
      routePools: expect.arrayContaining([expect.objectContaining({ id: 'kimi-pool', enabled: true })])
    }))

    await act(async () => { renderer!.unmount() })
  })

  it('shows separate local save and Runtime synchronization states with retry', async () => {
    const draft = settings()
    const onRetrySave = vi.fn()
    vi.stubGlobal('window', {
      kunGui: {
        runtimeRequest: vi.fn(async () => ({ ok: false, status: 503, body: '{"error":{"message":"Kun stopped"}}' }))
      }
    })
    let renderer: ReactTestRenderer
    await act(async () => {
      renderer = createRenderer(createElement(ModelRoutesSettings, {
        settings: draft,
        onChange: () => undefined,
        saveStatus: 'error',
        saveError: 'disk write failed',
        onRetrySave
      }))
    })

    const content = textContent(renderer!.root)
    expect(content).toContain('本地保存失败')
    expect(content).toContain('Kun Runtime 未连接')
    expect(content).toContain('disk write failed')
    const retry = renderer!.root.findAllByType('button').find((button) => textContent(button).includes('重试保存'))
    await act(async () => { retry!.props.onClick() })
    expect(onRetrySave).toHaveBeenCalledOnce()

    await act(async () => { renderer!.unmount() })
  })

  it('keeps missing route references visible and blocks stale chain tests', async () => {
    const draft = settings()
    draft.routePools[0].targets = [{
      id: 'missing-target', providerId: 'removed-provider', modelId: 'removed-model', enabled: true, weight: 1
    }]
    vi.stubGlobal('window', {
      kunGui: {
        runtimeRequest: vi.fn(async () => ({ ok: true, status: 200, body: routeStatus(draft, [], [{ ...draft.routePools[0], enabled: false, targets: [] }, draft.routePools[1]]) }))
      }
    })
    let renderer: ReactTestRenderer
    await act(async () => {
      renderer = createRenderer(createElement(ModelRoutesSettings, { settings: draft, onChange: () => undefined, saveStatus: 'saved' }))
    })

    const content = textContent(renderer!.root)
    expect(content).toContain('供应商已删除：removed-provider')
    expect(content).toContain('原模型：removed-model')
    expect(content).toContain('引用已保留')
    expect(content).toContain('修复无效目标后测试')
    expect(content).toContain('没有可执行目标')

    await act(async () => { renderer!.unmount() })
  })

  it('starts an asynchronous full-chain test and renders server-owned progress', async () => {
    const draft = settings()
    const running = testRecord('running')
    let tests: ReturnType<typeof testRecord>[] = []
    const runtimeRequest = vi.fn(async (_path: string, method?: string) => {
      if (method === 'POST') {
        tests = [running]
        return { ok: true, status: 202, body: JSON.stringify({ test: running }) }
      }
      return { ok: true, status: 200, body: routeStatus(draft, tests) }
    })
    vi.stubGlobal('window', { kunGui: { runtimeRequest } })
    let renderer: ReactTestRenderer
    await act(async () => {
      renderer = createRenderer(createElement(ModelRoutesSettings, { settings: draft, onChange: () => undefined }))
    })
    const testButton = renderer!.root.findAllByType('button').find((button) => textContent(button).includes('测试完整链路'))
    expect(testButton).toBeDefined()

    await act(async () => {
      testButton!.props.onClick()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(runtimeRequest).toHaveBeenCalledWith('/v1/model-routes/kimi-pool/test', 'POST')
    expect(textContent(renderer!.root)).toContain('测试进行中')
    expect(textContent(renderer!.root)).toContain('已尝试 2 / 2 个目标')
    expect(textContent(renderer!.root)).toContain('正在测试：provider-backup / kimi-backup')

    await act(async () => { renderer!.unmount() })
  })

  it('restores asynchronous test progress and results after leaving the page', async () => {
    const draft = settings()
    let statusBody = routeStatus(draft, [testRecord('running')])
    const runtimeRequest = vi.fn(async () => ({ ok: true, status: 200, body: statusBody }))
    vi.stubGlobal('window', { kunGui: { runtimeRequest } })

    let renderer: ReactTestRenderer
    await act(async () => {
      renderer = createRenderer(createElement(ModelRoutesSettings, { settings: draft, onChange: () => undefined }))
    })
    expect(textContent(renderer!.root)).toContain('测试进行中')
    expect(textContent(renderer!.root)).toContain('正在测试：provider-backup / kimi-backup')
    await act(async () => { renderer!.unmount() })

    statusBody = routeStatus(draft, [testRecord('succeeded')])
    await act(async () => {
      renderer = createRenderer(createElement(ModelRoutesSettings, { settings: draft, onChange: () => undefined }))
    })
    const restored = textContent(renderer!.root)
    expect(restored).toContain('链路测试成功')
    expect(restored).toContain('最终目标：provider-backup / kimi-backup')
    expect(restored).toContain('模型响应：OK')
    expect(restored).toContain('最近测试记录')

    await act(async () => { renderer!.unmount() })
  })

  it('waits for the saved route pool to reach the runtime before testing', async () => {
    const draft = settings()
    const runtimeRequest = vi.fn(async (_path: string, _method?: string) => ({ ok: true, status: 200, body: routeStatus(draft, [], []) }))
    vi.stubGlobal('window', { kunGui: { runtimeRequest } })
    let renderer: ReactTestRenderer
    await act(async () => {
      renderer = createRenderer(createElement(ModelRoutesSettings, { settings: draft, onChange: () => undefined }))
    })

    const testButton = renderer!.root.findAllByType('button').find((button) => textContent(button).includes('等待配置同步'))
    expect(testButton?.props.disabled).toBe(true)
    expect(textContent(renderer!.root)).toContain('本地配置已保存，正在等待 Kun Runtime')
    expect(textContent(renderer!.root)).toContain('等待 Kun Runtime 同步')
    expect(textContent(renderer!.root)).not.toContain('Kun Runtime 同步失败')
    expect(runtimeRequest.mock.calls.some((call) => call[1] === 'POST')).toBe(false)

    await act(async () => { renderer!.unmount() })
  })

  it('shows synchronization failure only when the main process reports one', async () => {
    const draft = settings()
    vi.stubGlobal('window', {
      kunGui: {
        runtimeRequest: vi.fn(async () => ({
          ok: true,
          status: 200,
          body: routeStatus(draft, [], [])
        })),
        getRuntimeSettingsSyncStatus: vi.fn(async () => ({
          state: 'failed' as const,
          generation: 4,
          message: 'hot apply rejected the route config',
          at: '2026-07-22T08:00:00.000Z'
        })),
        onRuntimeSettingsSyncStatus: vi.fn(() => () => undefined)
      }
    })

    let renderer: ReactTestRenderer
    await act(async () => {
      renderer = createRenderer(createElement(ModelRoutesSettings, {
        settings: draft,
        onChange: () => undefined,
        saveStatus: 'saved'
      }))
      await Promise.resolve()
    })

    const content = textContent(renderer!.root)
    expect(content).toContain('Kun Runtime 同步失败')
    expect(content).toContain('hot apply rejected the route config')
    expect(content).toContain('本地配置已保存，但 Kun Runtime 同步失败')

    await act(async () => { renderer!.unmount() })
  })

  it('does not let an older status snapshot overwrite a newer sync event', async () => {
    const draft = settings()
    let resolveSnapshot!: (value: {
      state: 'syncing'
      generation: number
      at: string
    }) => void
    let statusHandler!: (value: {
      state: 'failed'
      generation: number
      message: string
      at: string
    }) => void
    vi.stubGlobal('window', {
      kunGui: {
        runtimeRequest: vi.fn(async () => ({
          ok: true,
          status: 200,
          body: routeStatus(draft, [], [])
        })),
        getRuntimeSettingsSyncStatus: vi.fn(() => new Promise((resolve) => {
          resolveSnapshot = resolve
        })),
        onRuntimeSettingsSyncStatus: vi.fn((handler) => {
          statusHandler = handler
          return () => undefined
        })
      }
    })

    let renderer: ReactTestRenderer
    await act(async () => {
      renderer = createRenderer(createElement(ModelRoutesSettings, {
        settings: draft,
        onChange: () => undefined,
        saveStatus: 'saved'
      }))
    })
    await act(async () => {
      statusHandler({
        state: 'failed',
        generation: 5,
        message: 'latest apply failed',
        at: '2026-07-22T08:00:05.000Z'
      })
      resolveSnapshot({
        state: 'syncing',
        generation: 4,
        at: '2026-07-22T08:00:04.000Z'
      })
      await Promise.resolve()
    })

    expect(textContent(renderer!.root)).toContain('Kun Runtime 同步失败')
    expect(textContent(renderer!.root)).toContain('latest apply failed')

    await act(async () => { renderer!.unmount() })
  })
})

function routeStatus(draft: ModelProviderSettingsV1, tests: ReturnType<typeof testRecord>[] = [], pools = draft.routePools): string {
  return JSON.stringify({ localGateway: { enabled: draft.localGateway.enabled }, pools, metrics: {}, events: [], tests })
}

function testRecord(status: 'running' | 'succeeded') {
  const target = { targetId: 'backup-target', providerId: 'provider-backup', modelId: 'kimi-backup' }
  return {
    id: 'route-test-1',
    poolId: 'kimi-pool',
    modelId: 'kimi-auto',
    status,
    createdAt: '2026-07-22T08:00:00.000Z',
    startedAt: '2026-07-22T08:00:00.010Z',
    ...(status === 'succeeded' ? { completedAt: '2026-07-22T08:00:00.200Z', selectedTarget: target, output: 'OK' } : { currentTarget: target }),
    totalTargets: 2,
    attemptedTargets: 2,
    attempts: [
      {
        index: 1,
        targetId: 'primary-target',
        providerId: 'provider-primary',
        modelId: 'kimi-primary',
        status: 'failed',
        startedAt: '2026-07-22T08:00:00.010Z',
        completedAt: '2026-07-22T08:00:00.100Z',
        latencyMs: 90,
        category: 'rate_limit',
        message: '429 quota exhausted'
      },
      {
        index: 2,
        ...target,
        status: status === 'succeeded' ? 'succeeded' : 'running',
        startedAt: '2026-07-22T08:00:00.110Z',
        ...(status === 'succeeded' ? { completedAt: '2026-07-22T08:00:00.200Z', latencyMs: 90 } : {})
      }
    ]
  } as const
}

function textContent(node: ReactTestInstance): string {
  return node.children.map((child) => typeof child === 'string' ? child : textContent(child)).join('')
}
