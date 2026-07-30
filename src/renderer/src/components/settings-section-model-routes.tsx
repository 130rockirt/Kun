import { useCallback, useEffect, useMemo, useState, type DragEvent, type ReactElement } from 'react'
import type { ModelProviderSettingsV1, ModelRoutePoolV1, ModelRouteStrategy } from '@shared/app-settings'
import type { KunRuntimeSettingsSyncStatusPayload } from '@shared/kun-gui-api'
import {
  DEFAULT_MODEL_ROUTE_FAILURE_POLICY,
  DEFAULT_MODEL_ROUTE_HEALTH_POLICY,
  projectExecutableModelRoutePools,
  resolveModelRouteTargetReference
} from '@shared/app-settings'
import { KUN_MODEL_ROUTES_PATH, kunModelRouteTestPath } from '@shared/kun-endpoints'
import { Activity, AlertTriangle, Boxes, Check, ChevronDown, Clipboard, Code2, GripVertical, Loader2, Plus, Play, Route, Server, Trash2, X } from 'lucide-react'
import { SettingsSubTabs, SettingsTabPanel, Toggle } from './settings-controls'

type RouteStatus = {
  localGateway?: { enabled: boolean }
  pools?: ModelRoutePoolV1[]
  metrics?: Record<string, { successes: number; failures: number; ewmaLatencyMs?: number; lastError?: string }>
  events?: Array<{ at: string; poolId: string; targetId: string; providerId: string; modelId: string; result: string; latencyMs: number; testId?: string; category?: string; message?: string }>
  tests?: RoutePoolTestRecord[]
}

type RoutePoolTestAttempt = {
  index: number
  targetId: string
  providerId: string
  modelId: string
  status: 'running' | 'succeeded' | 'failed'
  startedAt: string
  completedAt?: string
  latencyMs?: number
  category?: string
  message?: string
}

type RoutePoolTestRecord = {
  id: string
  poolId: string
  modelId: string
  status: 'queued' | 'running' | 'succeeded' | 'failed'
  createdAt: string
  startedAt?: string
  completedAt?: string
  totalTargets: number
  attemptedTargets: number
  attempts: RoutePoolTestAttempt[]
  currentTarget?: RouteTestTarget
  selectedTarget?: RouteTestTarget
  output?: string
  error?: { message: string; code?: string; category?: string }
}

type RouteTestTarget = { targetId: string; providerId: string; modelId: string }
type ModelRouteSettingsTab = 'gateway' | 'models' | 'resilience' | 'monitoring'

const strategies: Array<{ id: ModelRouteStrategy; label: string }> = [
  { id: 'priority', label: '优先级故障转移' },
  { id: 'round-robin', label: '轮询' },
  { id: 'weighted-round-robin', label: '加权轮询' },
  { id: 'least-latency', label: '最低延迟' },
  { id: 'adaptive', label: '稳定性优先自适应' }
]

function EmptyRoutePoolState({ onAdd }: { onAdd: () => void }): ReactElement {
  return (
    <div className="grid min-h-[360px] place-items-center text-center">
      <div>
        <Route className="mx-auto h-10 w-10 text-ds-faint" />
        <h3 className="mt-3 text-[14px] font-semibold text-ds-ink">添加第一个路由模型</h3>
        <p className="mt-1 text-[12px] text-ds-faint">一个本地中转供应商可以包含多个公开模型。</p>
        <button
          type="button"
          onClick={onAdd}
          className="mt-4 inline-flex h-9 items-center gap-2 rounded-full bg-accent px-4 text-[12px] font-semibold text-white"
        >
          <Plus className="h-3.5 w-3.5" />
          添加模型
        </button>
      </div>
    </div>
  )
}

export function ModelRoutesSettings({
  settings,
  onChange,
  saveStatus = 'idle',
  saveError,
  onRetrySave,
  active = true,
  publicBaseUrl = 'http://127.0.0.1:18899'
}: {
  settings: ModelProviderSettingsV1
  onChange: (next: ModelProviderSettingsV1) => void
  saveStatus?: 'idle' | 'saving' | 'saved' | 'error'
  saveError?: string | null
  onRetrySave?: () => void
  active?: boolean
  /** The configured local Kun endpoint; this is also the public gateway origin. */
  publicBaseUrl?: string
}): ReactElement {
  const [selectedId, setSelectedId] = useState(settings.routePools[0]?.id ?? '')
  const [status, setStatus] = useState<RouteStatus | null>(null)
  const [statusError, setStatusError] = useState('')
  const [runtimeSyncStatus, setRuntimeSyncStatus] = useState<KunRuntimeSettingsSyncStatusPayload | null>(null)
  const [startPending, setStartPending] = useState(false)
  const [startError, setStartError] = useState('')
  const [apiDocsOpen, setApiDocsOpen] = useState(false)
  const [copiedValue, setCopiedValue] = useState<'base-url' | 'curl' | 'api-example' | null>(null)
  const [activeSettingsTab, setActiveSettingsTab] = useState<ModelRouteSettingsTab>('gateway')
  const selected = settings.routePools.find((pool) => pool.id === selectedId) ?? settings.routePools[0]
  const executablePools = useMemo(() => projectExecutableModelRoutePools(settings), [settings])
  const executableSelected = executablePools.find((pool) => pool.id === selected?.id)
  const configurationSynced = useMemo(
    () => runtimeConfigurationMatches(executablePools, settings.localGateway.enabled, status),
    [executablePools, settings.localGateway.enabled, status]
  )
  useEffect(() => {
    if (!selected && settings.routePools[0]) setSelectedId(settings.routePools[0].id)
  }, [selected, settings.routePools])

  const refreshStatus = useCallback(async (): Promise<void> => {
    try {
      const response = await window.kunGui.runtimeRequest(KUN_MODEL_ROUTES_PATH, 'GET')
      if (!response.ok) throw new Error(routeStatusError(response.body, response.status))
      setStatus(JSON.parse(response.body) as RouteStatus)
      setStatusError('')
    } catch (error) {
      // Local settings remain durable while Runtime is stopped or unavailable.
      setStatus(null)
      setStatusError(error instanceof Error ? error.message : String(error))
    }
  }, [])
  useEffect(() => {
    if (!active) return
    void refreshStatus()
    const interval = globalThis.setInterval(() => { void refreshStatus() }, 1_000)
    return () => globalThis.clearInterval(interval)
  }, [active, refreshStatus])
  useEffect(() => {
    if (!active) return
    let mounted = true
    if (typeof window.kunGui.getRuntimeSettingsSyncStatus === 'function') {
      void window.kunGui.getRuntimeSettingsSyncStatus()
        .then((next) => {
          if (mounted) {
            setRuntimeSyncStatus((current) =>
              current && current.generation > next.generation ? current : next
            )
          }
        })
        .catch(() => undefined)
    }
    const unsubscribe = typeof window.kunGui.onRuntimeSettingsSyncStatus === 'function'
      ? window.kunGui.onRuntimeSettingsSyncStatus((next) => {
          if (mounted) {
            setRuntimeSyncStatus((current) =>
              current && current.generation > next.generation ? current : next
            )
          }
        })
      : undefined
    return () => {
      mounted = false
      unsubscribe?.()
    }
  }, [active])
  useEffect(() => { setStartError('') }, [selected?.id])

  const updatePool = (patch: Partial<ModelRoutePoolV1>): void => {
    if (!selected) return
    onChange({ ...settings, routePools: settings.routePools.map((pool) => pool.id === selected.id ? { ...pool, ...patch } : pool) })
  }

  const addPool = (): void => {
    const provider = settings.providers.find((candidate) => candidate.models.length > 0)
    const ordinal = settings.routePools.length + 1
    const id = uniqueValue(`route-pool-${ordinal}`, new Set(settings.routePools.map((pool) => pool.id)))
    const modelId = uniqueValue(`local-route-${ordinal}`, new Set([
      ...settings.providers.flatMap((item) => item.models),
      ...settings.routePools.map((pool) => pool.modelId)
    ]))
    const pool: ModelRoutePoolV1 = {
      id,
      name: `路由模型 ${ordinal}`,
      modelId,
      enabled: false,
      strategy: 'priority',
      targets: provider ? [{ id: `${id}-target-1`, providerId: provider.id, modelId: provider.models[0], enabled: true, weight: 1 }] : [],
      failurePolicy: { ...DEFAULT_MODEL_ROUTE_FAILURE_POLICY, failoverHttpStatusCodes: [...DEFAULT_MODEL_ROUTE_FAILURE_POLICY.failoverHttpStatusCodes] },
      healthPolicy: { ...DEFAULT_MODEL_ROUTE_HEALTH_POLICY }
    }
    onChange({ ...settings, routePools: [...settings.routePools, pool] })
    setSelectedId(id)
  }

  const removePool = (): void => {
    if (!selected) return
    const next = settings.routePools.filter((pool) => pool.id !== selected.id)
    onChange({ ...settings, routePools: next })
    setSelectedId(next[0]?.id ?? '')
  }

  const runTest = async (): Promise<void> => {
    if (!selected || !runtimeReady) return
    setStartPending(true)
    setStartError('')
    try {
      const response = await window.kunGui.runtimeRequest(kunModelRouteTestPath(selected.id), 'POST')
      const body = JSON.parse(response.body) as { test?: RoutePoolTestRecord; error?: { message?: string } }
      if (!response.ok || !body.test) throw new Error(body.error?.message ?? '无法创建链路测试')
      setStatus((current) => ({
        ...(current ?? {}),
        tests: [body.test!, ...(current?.tests ?? []).filter((test) => test.id !== body.test!.id)]
      }))
      await refreshStatus()
    } catch (error) {
      setStartError(error instanceof Error ? error.message : String(error))
    } finally {
      setStartPending(false)
    }
  }

  const events = useMemo(() => (status?.events ?? []).filter((event) => !selected || event.poolId === selected.id).slice(-8).reverse(), [selected, status?.events])
  const selectedTests = useMemo(() => (status?.tests ?? []).filter((test) => test.poolId === selected?.id), [selected?.id, status?.tests])
  const latestTest = selectedTests[0]
  const activeTest = latestTest?.status === 'queued' || latestTest?.status === 'running'
  const runtimePool = status?.pools?.find((pool) => pool.id === selected?.id)
  const selectedHasExecutableTarget = Boolean(executableSelected?.enabled && executableSelected.targets.some((target) => target.enabled))
  const persistenceReady = saveStatus !== 'saving' && saveStatus !== 'error'
  const runtimeReady = Boolean(
    selected?.enabled &&
    selectedHasExecutableTarget &&
    persistenceReady &&
    configurationSynced &&
    runtimePoolMatches(executableSelected, runtimePool)
  )
  const invalidTargetCount = selected?.targets.filter((target) =>
    resolveModelRouteTargetReference(target, settings.providers).status !== 'valid'
  ).length ?? 0
  const testButtonLabel = startPending
    ? '正在创建测试'
    : activeTest
      ? '测试进行中'
      : saveStatus === 'error'
        ? '先修复保存失败'
        : saveStatus === 'saving'
          ? '等待本地保存'
          : !selected?.enabled
        ? '启用后可测试'
        : !selectedHasExecutableTarget
          ? '修复无效目标后测试'
        : !status
          ? 'Kun Runtime 不可用'
          : !runtimeReady
            ? '等待配置同步'
            : '测试完整链路'

  const localSaveLabel = saveStatus === 'saving'
    ? '正在保存到本地'
    : saveStatus === 'error'
      ? '本地保存失败'
      : '已保存到本地'
  const runtimeSyncFailed = Boolean(
    !configurationSynced && runtimeSyncStatus?.state === 'failed'
  )
  const runtimeSyncLabel = configurationSynced
    ? 'Kun Runtime 已同步'
    : runtimeSyncFailed
        ? 'Kun Runtime 同步失败'
        : !status
          ? runtimeSyncStatus?.state === 'unavailable' ? 'Kun Runtime 未运行' : 'Kun Runtime 未连接'
              : runtimeSyncStatus?.state === 'syncing'
              ? '正在同步到 Kun Runtime'
              : '等待 Kun Runtime 同步'
  const gatewayBaseUrl = `${publicBaseUrl.replace(/\/$/, '')}/v1`
  const sampleModelId = selected?.modelId || settings.routePools.find((pool) => pool.enabled)?.modelId || 'your-public-model-id'
  const curlExample = buildGatewayCurlExample(gatewayBaseUrl, sampleModelId)
  const copyGatewayText = async (value: string, kind: 'base-url' | 'curl' | 'api-example'): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value)
      setCopiedValue(kind)
      globalThis.setTimeout(() => setCopiedValue((current) => current === kind ? null : current), 1_800)
    } catch {
      setCopiedValue(null)
    }
  }

  return (
    <div className="grid min-h-[620px] gap-4 p-4 lg:grid-cols-[280px_minmax(0,1fr)]">
      <div className="lg:col-span-2">
        <SettingsSubTabs<ModelRouteSettingsTab>
          baseId="model-routes-settings"
          ariaLabel="模型路由设置"
          items={[
            { id: 'gateway', label: '网关与 API', icon: Server },
            { id: 'models', label: '模型与目标', icon: Boxes },
            { id: 'resilience', label: '容错策略', icon: AlertTriangle },
            { id: 'monitoring', label: '验证与监控', icon: Activity }
          ]}
          value={activeSettingsTab}
          onChange={setActiveSettingsTab}
        />
      </div>

      <SettingsTabPanel
        baseId="model-routes-settings"
        tabId="gateway"
        active={activeSettingsTab === 'gateway'}
        className="lg:col-span-2"
      >
        <section className="flex flex-wrap items-center gap-4 rounded-2xl border border-ds-border bg-ds-main/35 p-4">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-accent/10 text-accent">
          <Server className="h-5 w-5" />
        </span>
        <div className="min-w-[220px] flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] font-medium text-ds-faint">本地中转供应商</span>
            <span className="rounded-full bg-ds-card px-2 py-0.5 text-[10.5px] text-ds-muted">
              {settings.routePools.filter((pool) => pool.enabled).length} / {settings.routePools.length} 个模型已启用
            </span>
          </div>
          <input
            value={settings.localGateway.name}
            onChange={(event) => onChange({
              ...settings,
              localGateway: { ...settings.localGateway, name: event.target.value }
            })}
            aria-label="中转供应商名称"
            className="mt-1 w-full max-w-md bg-transparent text-[17px] font-semibold text-ds-ink outline-none"
          />
          <p className="mt-1 text-[11.5px] text-ds-faint">一个供应商统一承载多个公开模型，每个模型可配置独立的路由目标和负载策略。</p>
        </div>
        <div className="flex items-center gap-3 rounded-xl border border-ds-border bg-ds-card px-3 py-2.5">
          <div>
            <div className="text-[12px] font-medium text-ds-ink">开放本地 API</div>
            <div className="mt-0.5 text-[10.5px] text-ds-faint">仅本机访问 · 无鉴权</div>
          </div>
          <Toggle
            checked={settings.localGateway.enabled}
            onChange={(enabled) => onChange({
              ...settings,
              localGateway: { ...settings.localGateway, enabled }
            })}
            ariaLabel="开放本地 API"
          />
        </div>
        <div className="flex basis-full flex-wrap items-center gap-2 border-t border-ds-border-muted pt-3">
          <span className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${
            saveStatus === 'error'
              ? 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-200'
              : saveStatus === 'saving'
                ? 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-200'
                : 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-200'
          }`}>{localSaveLabel}</span>
          <span className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${
            configurationSynced
              ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-200'
              : runtimeSyncFailed
                ? 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-200'
              : status
                ? 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-200'
                : 'bg-ds-card text-ds-muted'
          }`}>{runtimeSyncLabel}</span>
          {saveStatus === 'error' && onRetrySave ? (
            <button type="button" onClick={onRetrySave} className="rounded-full border border-red-200 px-2.5 py-1 text-[11px] font-medium text-red-700">
              重试保存
            </button>
          ) : null}
          {saveStatus === 'error' && saveError ? <span className="min-w-0 truncate text-[11px] text-red-600" title={saveError}>{saveError}</span> : null}
          {!status && statusError ? <span className="min-w-0 truncate text-[11px] text-ds-faint" title={statusError}>本地配置不受影响；Kun 启动后会自动同步。</span> : null}
          {runtimeSyncFailed && runtimeSyncStatus?.message ? <span className="min-w-0 truncate text-[11px] text-red-600" title={runtimeSyncStatus.message}>{runtimeSyncStatus.message}</span> : null}
        </div>

        <section className="grid basis-full gap-3 rounded-xl border border-ds-border bg-ds-card p-3.5 lg:grid-cols-[minmax(0,1fr)_auto]">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <h3 className="flex items-center gap-1.5 text-[13px] font-semibold text-ds-ink"><Code2 className="h-4 w-4 text-accent" />本地 API</h3>
              <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-medium ${settings.localGateway.enabled ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-200' : 'bg-ds-main text-ds-muted'}`}>
                <span className={`h-1.5 w-1.5 rounded-full ${settings.localGateway.enabled ? 'bg-emerald-500' : 'bg-ds-faint'}`} />
                {settings.localGateway.enabled ? '已启用 · 仅本机访问' : '未启用'}
              </span>
            </div>
            <p className="mt-1 text-[11px] text-ds-faint">兼容 OpenAI Chat Completions 与 Responses；公开模型 ID 由下方路由模型决定。</p>
            <div className="mt-2 flex min-w-0 items-center gap-1.5 rounded-lg border border-ds-border bg-ds-main px-2.5 py-2">
              <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-ds-ink" title={gatewayBaseUrl}>{gatewayBaseUrl}</span>
              <button type="button" onClick={() => void copyGatewayText(gatewayBaseUrl, 'base-url')} className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-medium text-ds-muted hover:bg-ds-hover hover:text-ds-ink" aria-label="复制本地 API 地址">
                {copiedValue === 'base-url' ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Clipboard className="h-3.5 w-3.5" />}
                {copiedValue === 'base-url' ? '已复制' : '复制'}
              </button>
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5 text-[10.5px] text-ds-muted">
              <ApiCompatibilityPill>GET /models</ApiCompatibilityPill>
              <ApiCompatibilityPill>POST /chat/completions</ApiCompatibilityPill>
              <ApiCompatibilityPill>POST /responses</ApiCompatibilityPill>
            </div>
          </div>
          <div className="flex items-end gap-2 lg:flex-col lg:items-stretch lg:justify-center">
            <button type="button" onClick={() => void copyGatewayText(curlExample, 'curl')} className="inline-flex h-8 items-center justify-center gap-1.5 rounded-lg bg-accent px-3 text-[11.5px] font-semibold text-white hover:opacity-90">
              {copiedValue === 'curl' ? <Check className="h-3.5 w-3.5" /> : <Clipboard className="h-3.5 w-3.5" />}
              {copiedValue === 'curl' ? '已复制' : '复制 cURL'}
            </button>
            <button type="button" onClick={() => setApiDocsOpen((open) => !open)} className="inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border border-ds-border px-3 text-[11.5px] font-medium text-ds-muted hover:bg-ds-hover hover:text-ds-ink" aria-expanded={apiDocsOpen}>
              接口说明 <ChevronDown className={`h-3.5 w-3.5 transition-transform ${apiDocsOpen ? 'rotate-180' : ''}`} />
            </button>
          </div>

        </section>
        {apiDocsOpen ? <LocalGatewayApiDialog
          baseUrl={gatewayBaseUrl}
          modelId={sampleModelId}
          copied={copiedValue === 'api-example'}
          onClose={() => setApiDocsOpen(false)}
          onCopy={(value) => void copyGatewayText(value, 'api-example')}
        /> : null}
        </section>
      </SettingsTabPanel>
      <aside className={`${activeSettingsTab === 'gateway' ? 'hidden' : 'grid'} min-w-0 content-start gap-3 border-b border-ds-border-muted pb-4 lg:border-b-0 lg:border-r lg:pb-0 lg:pr-4`}>
        <div className="flex items-start justify-between gap-2">
          <div>
            <h3 className="flex items-center gap-2 text-[14px] font-semibold text-ds-ink"><Boxes className="h-4 w-4 text-accent" />路由模型</h3>
            <p className="mt-1 text-[12px] leading-5 text-ds-faint">选择一个模型配置它的容量池。</p>
          </div>
        </div>
        <button type="button" onClick={addPool} className="inline-flex h-9 items-center justify-center gap-2 rounded-xl bg-accent text-[12.5px] font-semibold text-white">
          <Plus className="h-4 w-4" /> 添加模型
        </button>
        <div className="grid gap-2">
          {settings.routePools.map((pool) => {
            const executablePool = executablePools.find((candidate) => candidate.id === pool.id)
            const available = executablePool?.targets.filter((target) => target.enabled).length ?? 0
            const invalid = pool.targets.length - (executablePool?.targets.length ?? 0)
            return (
              <button key={pool.id} type="button" onClick={() => setSelectedId(pool.id)} className={`rounded-xl border px-3 py-3 text-left transition ${selected?.id === pool.id ? 'border-accent bg-accent/5' : 'border-ds-border bg-ds-card hover:bg-ds-hover'}`}>
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-mono text-[13px] font-semibold text-ds-ink">{pool.modelId}</span>
                  <span className={`h-2 w-2 rounded-full ${executablePool?.enabled ? 'bg-emerald-500' : invalid > 0 ? 'bg-amber-500' : 'bg-ds-faint'}`} />
                </div>
                <div className="mt-1 truncate text-[11px] text-ds-faint">{pool.name}</div>
                <div className="mt-2 flex items-center justify-between text-[11px] text-ds-muted"><span>{available}/{pool.targets.length} 可用{invalid > 0 ? ` · ${invalid} 个待修复` : ''}</span><span>{strategies.find((item) => item.id === pool.strategy)?.label}</span></div>
              </button>
            )
          })}
          {settings.routePools.length === 0 ? <div className="rounded-xl border border-dashed border-ds-border px-3 py-8 text-center text-[12px] text-ds-faint">还没有路由模型</div> : null}
        </div>
      </aside>

      <main className={activeSettingsTab === 'gateway' ? 'hidden' : 'min-w-0'}>
        <SettingsTabPanel
          baseId="model-routes-settings"
          tabId="models"
          active={activeSettingsTab === 'models'}
          className="grid content-start gap-5"
        >
          {selected ? (
            <>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <p className="mb-1 text-[11px] font-medium text-accent">{settings.localGateway.name} / 路由模型</p>
              <input aria-label="路由模型名称" value={selected.name} onChange={(event) => updatePool({ name: event.target.value })} className="w-full bg-transparent text-[20px] font-semibold text-ds-ink outline-none" />
              <p className="mt-1 text-[12px] text-ds-faint">配置保存后会热更新到当前 Kun Runtime。</p>
            </div>
            <div className="flex items-center gap-3"><span className="text-[12px] text-ds-muted">启用</span><Toggle checked={selected.enabled} onChange={(enabled) => updatePool({ enabled })} ariaLabel="启用路由池" /></div>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <Field label="公开模型 ID"><input value={selected.modelId} onChange={(event) => updatePool({ modelId: event.target.value })} className={inputClass} spellCheck={false} /></Field>
            <Field label="负载策略"><select value={selected.strategy} onChange={(event) => updatePool({ strategy: event.target.value as ModelRouteStrategy })} className={inputClass}>{strategies.map((strategy) => <option key={strategy.id} value={strategy.id}>{strategy.label}</option>)}</select></Field>
          </div>

          <section className="grid gap-3">
            <div className="flex items-center justify-between"><h3 className="text-[13px] font-semibold text-ds-ink">路由目标</h3><button type="button" onClick={() => {
              const provider = settings.providers.find((candidate) => candidate.models.length > 0)
              if (!provider) return
              updatePool({ targets: [...selected.targets, { id: `${selected.id}-target-${Date.now().toString(36)}`, providerId: provider.id, modelId: provider.models[0], enabled: true, weight: 1 }] })
            }} className="inline-flex items-center gap-1 rounded-full border border-ds-border px-3 py-1.5 text-[12px] text-ds-muted"><Plus className="h-3.5 w-3.5" /> 添加目标</button></div>
            <div className="grid gap-2">
              {selected.targets.map((target, index) => {
                const resolution = resolveModelRouteTargetReference(target, settings.providers)
                const provider = resolution.provider
                const metric = status?.metrics?.[`${selected.id}:${target.id}`]
                return (
                  <div key={target.id} draggable onDragStart={(event) => event.dataTransfer.setData('text/route-target-index', String(index))} onDragOver={(event) => event.preventDefault()} onDrop={(event) => reorderTarget(event, index, selected, updatePool)} className={`grid items-center gap-2 rounded-xl border bg-ds-card p-3 md:grid-cols-[24px_28px_minmax(150px,1fr)_minmax(150px,1fr)_80px_110px_32px] ${resolution.status === 'valid' ? 'border-ds-border' : 'border-amber-300/80'}`}>
                    <GripVertical className="h-4 w-4 cursor-grab text-ds-faint" />
                    <span className="grid h-6 w-6 place-items-center rounded-full bg-ds-main text-[11px] text-ds-muted">{index + 1}</span>
                    <select value={target.providerId} onChange={(event) => {
                      const nextProvider = settings.providers.find((candidate) => candidate.id === event.target.value)
                      updatePool({ targets: selected.targets.map((item) => item.id === target.id ? { ...item, providerId: event.target.value, modelId: nextProvider?.models[0] ?? '' } : item) })
                    }} className={compactInputClass}>
                      {resolution.status === 'provider-missing' ? <option value={target.providerId}>供应商已删除：{target.providerId}</option> : null}
                      {settings.providers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                    </select>
                    <select value={target.modelId} onChange={(event) => updatePool({ targets: selected.targets.map((item) => item.id === target.id ? { ...item, modelId: event.target.value } : item) })} className={compactInputClass}>
                      {resolution.status !== 'valid' ? <option value={target.modelId}>{resolution.status === 'provider-missing' ? '原模型' : '模型已删除'}：{target.modelId}</option> : null}
                      {(provider?.models ?? []).map((model) => <option key={model} value={model}>{model}</option>)}
                    </select>
                    <input type="number" min={1} max={100} title="权重" value={target.weight} onChange={(event) => updatePool({ targets: selected.targets.map((item) => item.id === target.id ? { ...item, weight: Number(event.target.value) || 1 } : item) })} className={compactInputClass} />
                    <div className="text-[11px] text-ds-muted">{metric?.ewmaLatencyMs ? `${Math.round(metric.ewmaLatencyMs)} ms` : '未探测'}<br /><span className="text-ds-faint">{metric ? `${metric.successes}/${metric.successes + metric.failures} 成功` : ''}</span></div>
                    <button type="button" onClick={() => updatePool({ targets: selected.targets.filter((item) => item.id !== target.id) })} className="rounded-full p-1.5 text-ds-faint hover:bg-red-50 hover:text-red-600"><Trash2 className="h-4 w-4" /></button>
                    {resolution.status !== 'valid' ? (
                      <div className="flex items-center gap-1.5 text-[11px] text-amber-700 md:col-span-5 md:col-start-3">
                        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                        {resolution.status === 'provider-missing'
                          ? `供应商 ${target.providerId} 已不存在；引用已保留，请选择替代供应商或删除目标。`
                          : `模型 ${target.modelId} 已不在 ${target.providerId} 中；引用已保留，请选择替代模型或删除目标。`}
                      </div>
                    ) : null}
                  </div>
                )
              })}
            </div>
          </section>

              <div className="flex justify-end">
                <button type="button" onClick={removePool} className="inline-flex items-center gap-2 rounded-full border border-red-200 px-3 py-2 text-[12px] text-red-600">
                  <Trash2 className="h-3.5 w-3.5" />
                  删除模型
                </button>
              </div>
            </>
          ) : (
            <EmptyRoutePoolState onAdd={addPool} />
          )}
        </SettingsTabPanel>

        <SettingsTabPanel
          baseId="model-routes-settings"
          tabId="resilience"
          active={activeSettingsTab === 'resilience'}
          className="grid content-start gap-5"
        >
          {selected ? (
            <div className="grid gap-3 xl:grid-cols-2">
            <section className="rounded-xl border border-ds-border p-4"><h3 className="flex items-center gap-2 text-[13px] font-semibold text-ds-ink"><AlertTriangle className="h-4 w-4 text-amber-500" />故障转移规则</h3><div className="mt-3 grid gap-3 text-[12px] text-ds-muted"><ToggleRow label="网络错误" checked={selected.failurePolicy.failoverOnNetworkError} onChange={(value) => updatePool({ failurePolicy: { ...selected.failurePolicy, failoverOnNetworkError: value } })} /><ToggleRow label="请求超时" checked={selected.failurePolicy.failoverOnTimeout} onChange={(value) => updatePool({ failurePolicy: { ...selected.failurePolicy, failoverOnTimeout: value } })} /><ToggleRow label="401 / 403 凭据错误" checked={selected.failurePolicy.failoverOnAuthError} onChange={(value) => updatePool({ failurePolicy: { ...selected.failurePolicy, failoverOnAuthError: value } })} /><Field label="切换 HTTP 状态码"><input value={selected.failurePolicy.failoverHttpStatusCodes.join(', ')} onChange={(event) => updatePool({ failurePolicy: { ...selected.failurePolicy, failoverHttpStatusCodes: parseCodes(event.target.value) } })} className={compactInputClass} /></Field><p className="text-[11px] text-ds-faint">流式输出开始后固定停止，不会重复请求或执行工具。</p></div></section>
            <section className="rounded-xl border border-ds-border p-4"><h3 className="flex items-center gap-2 text-[13px] font-semibold text-ds-ink"><Activity className="h-4 w-4 text-emerald-500" />健康与熔断</h3><div className="mt-3 grid grid-cols-3 gap-3"><Field label="连续失败"><input type="number" min={1} max={20} value={selected.healthPolicy.failureThreshold} onChange={(event) => updatePool({ healthPolicy: { ...selected.healthPolicy, failureThreshold: Number(event.target.value) } })} className={compactInputClass} /></Field><Field label="冷却秒数"><input type="number" min={1} value={Math.round(selected.healthPolicy.cooldownMs / 1000)} onChange={(event) => updatePool({ healthPolicy: { ...selected.healthPolicy, cooldownMs: Number(event.target.value) * 1000 } })} className={compactInputClass} /></Field><Field label="半开探测"><input type="number" min={1} max={10} value={selected.healthPolicy.halfOpenMaxAttempts} onChange={(event) => updatePool({ healthPolicy: { ...selected.healthPolicy, halfOpenMaxAttempts: Number(event.target.value) } })} className={compactInputClass} /></Field></div></section>
            </div>
          ) : (
            <EmptyRoutePoolState onAdd={addPool} />
          )}
        </SettingsTabPanel>

        <SettingsTabPanel
          baseId="model-routes-settings"
          tabId="monitoring"
          active={activeSettingsTab === 'monitoring'}
          className="grid content-start gap-5"
        >
          {selected ? (
            <section className="grid gap-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="text-[13px] font-semibold text-ds-ink">路由验证</h3>
                <p className="mt-1 text-[11px] text-ds-faint">测试由 Kun Runtime 异步执行，离开页面后仍会继续，返回时自动恢复进度和结果。</p>
              </div>
              <button
                type="button"
                disabled={startPending || activeTest || !runtimeReady}
                onClick={() => void runTest()}
                className="inline-flex h-9 items-center gap-2 rounded-full border border-accent px-4 text-[12px] font-medium text-accent disabled:opacity-40"
              >
                {startPending || activeTest ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                {testButtonLabel}
              </button>
            </div>

            {startError ? <div className="rounded-lg bg-red-50 px-3 py-2 text-[12px] text-red-700">{startError}</div> : null}
            {selected.enabled && !runtimeReady ? (
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11.5px] text-amber-700">
                {chainTestBlockedReason({ saveStatus, status, statusError, runtimeSyncStatus, configurationSynced, selectedHasExecutableTarget, invalidTargetCount })}
              </div>
            ) : null}

            {latestTest ? (
              <div className="grid gap-3 rounded-xl border border-ds-border bg-ds-card p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    {activeTest ? <Loader2 className="h-4 w-4 animate-spin text-accent" /> : <Activity className="h-4 w-4 text-accent" />}
                    <span className={`rounded-full px-2 py-1 text-[11px] font-medium ${testStatusClass(latestTest.status)}`}>{testStatusLabel(latestTest.status)}</span>
                    <span className="text-[11px] text-ds-faint">{new Date(latestTest.createdAt).toLocaleString()}</span>
                  </div>
                  <span className="text-[11px] text-ds-muted">已尝试 {latestTest.attemptedTargets} / {latestTest.totalTargets} 个目标</span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-ds-main">
                  <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${testProgress(latestTest)}%` }} />
                </div>
                {latestTest.currentTarget ? <p className="text-[12px] text-ds-muted">正在测试：{formatTarget(latestTest.currentTarget)}</p> : null}
                {latestTest.selectedTarget ? <p className="text-[12px] text-emerald-700">最终目标：{formatTarget(latestTest.selectedTarget)}</p> : null}
                {latestTest.output ? <div className="rounded-lg bg-ds-main px-3 py-2 text-[12px] text-ds-muted">模型响应：{latestTest.output}</div> : null}
                {latestTest.error ? <div className="rounded-lg bg-red-50 px-3 py-2 text-[12px] text-red-700">{latestTest.error.message}{latestTest.error.category ? ` · ${latestTest.error.category}` : ''}</div> : null}
              </div>
            ) : status ? <div className="rounded-xl border border-dashed border-ds-border px-3 py-6 text-center text-[11px] text-ds-faint">暂无链路测试记录</div> : null}

            {latestTest?.attempts.length ? (
              <div className="overflow-hidden rounded-xl border border-ds-border">
                <div className="bg-ds-main px-3 py-2 text-[11px] font-medium text-ds-muted">本次目标进度</div>
                <table className="w-full text-left text-[11.5px]">
                  <thead className="text-ds-faint"><tr><th className="px-3 py-2">顺序</th><th className="px-3 py-2">目标</th><th className="px-3 py-2">状态</th><th className="px-3 py-2">延迟 / 错误</th></tr></thead>
                  <tbody>{latestTest.attempts.map((attempt) => (
                    <tr key={`${latestTest.id}-${attempt.targetId}`} className="border-t border-ds-border-muted text-ds-muted">
                      <td className="px-3 py-2">{attempt.index}</td>
                      <td className="px-3 py-2">{attempt.providerId} / {attempt.modelId}</td>
                      <td className="px-3 py-2">{attemptStatusLabel(attempt.status)}</td>
                      <td className="max-w-[320px] truncate px-3 py-2" title={attempt.message}>{attempt.latencyMs === undefined ? '—' : `${attempt.latencyMs} ms`}{attempt.category ? ` · ${attempt.category}` : ''}{attempt.message ? ` · ${attempt.message}` : ''}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            ) : null}

            {selectedTests.length ? (
              <div className="overflow-hidden rounded-xl border border-ds-border">
                <div className="bg-ds-main px-3 py-2 text-[11px] font-medium text-ds-muted">最近测试记录</div>
                <table className="w-full text-left text-[11.5px]">
                  <thead className="text-ds-faint"><tr><th className="px-3 py-2">时间</th><th className="px-3 py-2">结果</th><th className="px-3 py-2">尝试</th><th className="px-3 py-2">最终目标</th></tr></thead>
                  <tbody>{selectedTests.slice(0, 5).map((test) => (
                    <tr key={test.id} className="border-t border-ds-border-muted text-ds-muted">
                      <td className="px-3 py-2">{new Date(test.createdAt).toLocaleString()}</td>
                      <td className="px-3 py-2">{testStatusLabel(test.status)}</td>
                      <td className="px-3 py-2">{test.attemptedTargets} / {test.totalTargets}</td>
                      <td className="px-3 py-2">{test.selectedTarget ? formatTarget(test.selectedTarget) : '—'}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            ) : null}

            <div className="overflow-hidden rounded-xl border border-ds-border">
              <div className="bg-ds-main px-3 py-2 text-[11px] font-medium text-ds-muted">最近路由事件</div>
              <table className="w-full text-left text-[11.5px]">
                <thead className="text-ds-faint"><tr><th className="px-3 py-2">时间</th><th className="px-3 py-2">目标</th><th className="px-3 py-2">结果</th><th className="px-3 py-2">延迟</th></tr></thead>
                <tbody>{events.map((event) => <tr key={`${event.at}-${event.targetId}-${event.result}`} className="border-t border-ds-border-muted text-ds-muted"><td className="px-3 py-2">{new Date(event.at).toLocaleTimeString()}</td><td className="px-3 py-2">{event.providerId} / {event.modelId}</td><td className="px-3 py-2">{event.result}{event.category ? ` · ${event.category}` : ''}</td><td className="px-3 py-2">{event.latencyMs} ms</td></tr>)}</tbody>
              </table>
              {events.length === 0 ? <div className="px-3 py-6 text-center text-[11px] text-ds-faint">暂无路由事件</div> : null}
            </div>
            </section>
          ) : (
            <EmptyRoutePoolState onAdd={addPool} />
          )}
        </SettingsTabPanel>
      </main>
    </div>
  )
}

type GatewayApiTab = 'models' | 'chat' | 'responses'

function ApiCompatibilityPill({ children }: { children: string }): ReactElement {
  return <span className="rounded-full bg-ds-main px-2 py-1 font-mono text-[10px] text-ds-muted">{children}</span>
}

function LocalGatewayApiDialog({
  baseUrl,
  modelId,
  copied,
  onClose,
  onCopy
}: {
  baseUrl: string
  modelId: string
  copied: boolean
  onClose: () => void
  onCopy: (value: string) => void
}): ReactElement {
  const [tab, setTab] = useState<GatewayApiTab>('chat')
  useEffect(() => {
    if (typeof globalThis.addEventListener !== 'function') return
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    globalThis.addEventListener('keydown', closeOnEscape)
    return () => globalThis.removeEventListener('keydown', closeOnEscape)
  }, [onClose])

  const guide = gatewayApiGuide(tab, baseUrl, modelId)
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/35 p-4 backdrop-blur-[1px]" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <section role="dialog" aria-modal="true" aria-labelledby="local-api-dialog-title" className="grid max-h-[min(760px,calc(100vh-32px))] w-full max-w-4xl overflow-hidden rounded-2xl border border-ds-border bg-ds-card shadow-2xl shadow-slate-950/25">
        <header className="flex items-start justify-between gap-4 border-b border-ds-border-muted px-5 py-4">
          <div>
            <h2 id="local-api-dialog-title" className="flex items-center gap-2 text-[16px] font-semibold text-ds-ink"><Code2 className="h-4 w-4 text-accent" />本地 API 说明</h2>
            <p className="mt-1 text-[12px] text-ds-muted">OpenAI 兼容接口，仅允许本机进程访问；不需要 Authorization 请求头。</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-2 text-ds-muted hover:bg-ds-hover hover:text-ds-ink" aria-label="关闭 API 说明"><X className="h-4 w-4" /></button>
        </header>

        <div className="grid min-h-0 overflow-y-auto md:grid-cols-[196px_minmax(0,1fr)]">
          <aside className="border-b border-ds-border-muted bg-ds-main/35 p-3 md:border-b-0 md:border-r">
            <p className="px-2 pb-2 text-[10.5px] font-medium uppercase tracking-[0.08em] text-ds-faint">接口</p>
            <div className="grid gap-1">
              <ApiGuideTab active={tab === 'models'} onClick={() => setTab('models')} method="GET" path="/models">模型列表</ApiGuideTab>
              <ApiGuideTab active={tab === 'chat'} onClick={() => setTab('chat')} method="POST" path="/chat/completions">Chat Completions</ApiGuideTab>
              <ApiGuideTab active={tab === 'responses'} onClick={() => setTab('responses')} method="POST" path="/responses">Responses</ApiGuideTab>
            </div>
            <div className="mt-4 rounded-lg border border-ds-border bg-ds-card p-2.5 text-[10.5px] leading-4 text-ds-muted">
              <div className="font-medium text-ds-ink">调用前提</div>
              <p className="mt-1">先启用本地 API，并至少启用一个路由模型。请求中的 <code className="font-mono">model</code> 使用它的公开模型 ID。</p>
            </div>
          </aside>

          <div className="min-w-0 p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2"><span className={`rounded-md px-1.5 py-0.5 font-mono text-[10.5px] font-semibold ${guide.method === 'GET' ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-200' : 'bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-200'}`}>{guide.method}</span><h3 className="font-mono text-[14px] font-semibold text-ds-ink">{guide.path}</h3></div>
                <p className="mt-2 text-[12px] leading-5 text-ds-muted">{guide.description}</p>
              </div>
              <span className="rounded-full bg-ds-main px-2 py-1 text-[10.5px] text-ds-muted">OpenAI 兼容</span>
            </div>

            <div className="mt-4 rounded-xl border border-ds-border bg-ds-main/45 p-3">
              <div className="flex items-center justify-between gap-3"><span className="text-[11px] font-medium text-ds-muted">Base URL</span><button type="button" onClick={() => onCopy(baseUrl)} className="inline-flex items-center gap-1 text-[11px] font-medium text-accent hover:opacity-80">{copied ? <Check className="h-3.5 w-3.5" /> : <Clipboard className="h-3.5 w-3.5" />}{copied ? '已复制' : '复制'}</button></div>
              <code className="mt-1.5 block break-all font-mono text-[12px] text-ds-ink">{baseUrl}</code>
            </div>

            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <InfoList title="关键字段" items={guide.fields} />
              <InfoList title="响应与限制" items={guide.notes} />
            </div>

            <div className="mt-5 overflow-hidden rounded-xl border border-slate-700 bg-slate-950">
              <div className="flex items-center justify-between gap-3 border-b border-slate-700 px-3 py-2"><span className="text-[11px] font-medium text-slate-300">cURL 示例</span><button type="button" onClick={() => onCopy(guide.example)} className="inline-flex items-center gap-1 rounded-md bg-white/10 px-2 py-1 text-[10.5px] font-medium text-slate-100 hover:bg-white/15">{copied ? <Check className="h-3.5 w-3.5 text-emerald-300" /> : <Clipboard className="h-3.5 w-3.5" />}{copied ? '已复制' : '复制示例'}</button></div>
              <pre className="overflow-x-auto p-3 font-mono text-[11.5px] leading-5 text-slate-100"><code>{guide.example}</code></pre>
            </div>

            <p className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] leading-4 text-amber-800 dark:border-amber-400/20 dark:bg-amber-500/10 dark:text-amber-100">此中转站不是面向公网的 API 服务：它仅绑定本机回环地址，且目前无鉴权。不要通过端口映射或未受保护的反向代理暴露给局域网或公网。</p>
          </div>
        </div>
      </section>
    </div>
  )
}

function ApiGuideTab({
  active,
  method,
  path,
  children,
  onClick
}: {
  active: boolean
  method: 'GET' | 'POST'
  path: string
  children: string
  onClick: () => void
}): ReactElement {
  return <button type="button" onClick={onClick} className={`grid gap-1 rounded-lg px-2.5 py-2 text-left transition ${active ? 'bg-ds-card text-ds-ink shadow-sm' : 'text-ds-muted hover:bg-ds-hover hover:text-ds-ink'}`}><span className="text-[11.5px] font-medium">{children}</span><span className="font-mono text-[10px]"><span className={method === 'GET' ? 'text-emerald-600' : 'text-accent'}>{method}</span> {path}</span></button>
}

function InfoList({ title, items }: { title: string; items: string[] }): ReactElement {
  return <section><h4 className="text-[11px] font-medium text-ds-ink">{title}</h4><ul className="mt-1.5 grid gap-1 text-[11px] leading-4 text-ds-muted">{items.map((item) => <li key={item} className="flex gap-1.5"><span className="mt-[6px] h-1 w-1 shrink-0 rounded-full bg-ds-faint" />{item}</li>)}</ul></section>
}

function gatewayApiGuide(tab: GatewayApiTab, baseUrl: string, modelId: string): {
  method: 'GET' | 'POST'
  path: string
  description: string
  fields: string[]
  notes: string[]
  example: string
} {
  if (tab === 'models') return {
    method: 'GET',
    path: '/models',
    description: '列出本地中转站中所有已启用的路由模型。返回的 data[].id 就是后续生成请求使用的公开模型 ID。',
    fields: ['无需请求体。', '只返回已启用的路由模型；未启用或无效的容量池不会出现。'],
    notes: ['成功时返回 OpenAI 风格的 object: "list" 与 data 数组。', '本地 API 未启用时返回 404（gateway_disabled）。'],
    example: `curl --request GET ${baseUrl}/models`
  }
  if (tab === 'responses') return {
    method: 'POST',
    path: '/responses',
    description: '以 OpenAI Responses 风格生成内容，适合使用 input 作为单次输入的客户端。',
    fields: [`model：必填，使用公开模型 ID，例如 ${modelId}。`, 'input：必填，可传字符串或消息数组。', 'stream：可选；true 时返回 Server-Sent Events。', 'max_output_tokens、tools 与 reasoning_effort 可选。'],
    notes: ['非流式响应为 object: "response"，文本位于 output 中。', '流式响应依次发送 response.created、response.output_text.delta 与 response.completed。'],
    example: buildGatewayResponsesCurlExample(baseUrl, modelId)
  }
  return {
    method: 'POST',
    path: '/chat/completions',
    description: '以 OpenAI Chat Completions 风格生成对话回复，是多数 OpenAI 兼容 SDK 的默认接入方式。',
    fields: [`model：必填，使用公开模型 ID，例如 ${modelId}。`, 'messages：必填且不能为空，支持 system、developer、user、assistant 与 tool 消息。', 'stream：可选；true 时返回 SSE，false 时返回完整 JSON。', 'tools：可选，使用 OpenAI function 工具定义；图片仅接受 Base64 data URL。'],
    notes: ['非流式文本位于 choices[0].message.content。', '流式输出以 data: [DONE] 结束。', '模型不存在时返回 404（model_not_found）。'],
    example: buildGatewayCurlExample(baseUrl, modelId)
  }
}

function buildGatewayCurlExample(baseUrl: string, modelId: string): string {
  return `curl --request POST ${baseUrl}/chat/completions \\
  --header 'Content-Type: application/json' \\
  --data '{
    "model": "${modelId}",
    "messages": [
      { "role": "user", "content": "你好，Kun！" }
    ],
    "stream": false
  }'`
}

function buildGatewayResponsesCurlExample(baseUrl: string, modelId: string): string {
  return `curl --request POST ${baseUrl}/responses \\
  --header 'Content-Type: application/json' \\
  --data '{
    "model": "${modelId}",
    "input": "用一句话介绍 Kun 本地中转站",
    "stream": false
  }'`
}

const inputClass = 'w-full rounded-xl border border-ds-border bg-ds-card px-3 py-2 text-[13px] text-ds-ink outline-none focus:border-accent/50'
const compactInputClass = 'w-full min-w-0 rounded-lg border border-ds-border bg-ds-card px-2 py-1.5 text-[12px] text-ds-ink outline-none focus:border-accent/50'
function Field({ label, children }: { label: string; children: ReactElement }): ReactElement { return <label className="grid gap-1.5 text-[11.5px] font-medium text-ds-muted"><span>{label}</span>{children}</label> }
function ToggleRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }): ReactElement { return <div className="flex items-center justify-between"><span>{label}</span><Toggle checked={checked} onChange={onChange} ariaLabel={label} /></div> }
function uniqueValue(base: string, values: Set<string>): string { let value = base; let i = 2; while (values.has(value)) value = `${base}-${i++}`; return value }
function parseCodes(value: string): number[] { return [...new Set(value.split(/[\s,]+/).map(Number).filter((code) => Number.isInteger(code) && code >= 400 && code <= 599))] }
function reorderTarget(event: DragEvent, destination: number, pool: ModelRoutePoolV1, update: (patch: Partial<ModelRoutePoolV1>) => void): void { event.preventDefault(); const source = Number(event.dataTransfer.getData('text/route-target-index')); if (!Number.isInteger(source) || source === destination) return; const targets = [...pool.targets]; const [moved] = targets.splice(source, 1); targets.splice(destination, 0, moved); update({ targets }) }
function runtimePoolMatches(selected: ModelRoutePoolV1 | undefined, runtime: ModelRoutePoolV1 | undefined): boolean {
  if (!selected || !runtime) return false
  const comparable = (pool: ModelRoutePoolV1): unknown => ({
    id: pool.id,
    name: pool.name,
    modelId: pool.modelId,
    enabled: pool.enabled,
    strategy: pool.strategy,
    targets: pool.targets.map((target) => ({
      id: target.id,
      providerId: target.providerId,
      modelId: target.modelId,
      enabled: target.enabled,
      weight: target.weight
    })),
    failurePolicy: {
      failoverHttpStatusCodes: pool.failurePolicy.failoverHttpStatusCodes,
      failoverOnNetworkError: pool.failurePolicy.failoverOnNetworkError,
      failoverOnTimeout: pool.failurePolicy.failoverOnTimeout,
      failoverOnAuthError: pool.failurePolicy.failoverOnAuthError
    },
    healthPolicy: {
      failureThreshold: pool.healthPolicy.failureThreshold,
      cooldownMs: pool.healthPolicy.cooldownMs,
      halfOpenMaxAttempts: pool.healthPolicy.halfOpenMaxAttempts
    }
  })
  return JSON.stringify(comparable(selected)) === JSON.stringify(comparable(runtime))
}
function runtimeConfigurationMatches(
  expectedPools: readonly ModelRoutePoolV1[],
  expectedGatewayEnabled: boolean,
  status: RouteStatus | null
): boolean {
  if (!status || status.localGateway?.enabled !== expectedGatewayEnabled) return false
  const runtimePools = status.pools ?? []
  return expectedPools.length === runtimePools.length &&
    expectedPools.every((pool, index) => runtimePoolMatches(pool, runtimePools[index]))
}
function routeStatusError(body: string, status: number): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string }; message?: string }
    return parsed.error?.message?.trim() || parsed.message?.trim() || `Kun Runtime 状态请求失败 (${status})`
  } catch {
    return body.trim() || `Kun Runtime 状态请求失败 (${status})`
  }
}
function chainTestBlockedReason(input: {
  saveStatus: 'idle' | 'saving' | 'saved' | 'error'
  status: RouteStatus | null
  statusError: string
  runtimeSyncStatus: KunRuntimeSettingsSyncStatusPayload | null
  configurationSynced: boolean
  selectedHasExecutableTarget: boolean
  invalidTargetCount: number
}): string {
  if (input.saveStatus === 'error') return '本地保存失败，请先重试保存；未持久化的配置不会用于链路测试。'
  if (input.saveStatus === 'saving') return '配置正在保存到本地，保存完成并同步到 Kun Runtime 后即可测试。'
  if (!input.selectedHasExecutableTarget) {
    return input.invalidTargetCount > 0
      ? `当前路由有 ${input.invalidTargetCount} 个失效引用且没有可执行目标，请先替换供应商或模型。`
      : '当前路由没有已启用的有效目标，请先添加或启用一个目标。'
  }
  if (!input.configurationSynced && input.runtimeSyncStatus?.state === 'failed') {
    return `本地配置已保存，但 Kun Runtime 同步失败。${input.runtimeSyncStatus.message ? ` ${input.runtimeSyncStatus.message}` : '请检查 Runtime 日志后重试保存。'}`
  }
  if (!input.status) return `本地配置已保存，但 Kun Runtime 当前不可用；启动后会自动同步。${input.statusError ? ` ${input.statusError}` : ''}`
  if (!input.configurationSynced) return '本地配置已保存，正在等待 Kun Runtime 应用相同的路由池和本地 API 状态。'
  return 'Kun Runtime 尚未准备好执行该路由的完整链路测试。'
}
function testStatusLabel(status: RoutePoolTestRecord['status']): string { return ({ queued: '等待执行', running: '测试进行中', succeeded: '链路测试成功', failed: '链路测试失败' })[status] }
function testStatusClass(status: RoutePoolTestRecord['status']): string { return status === 'succeeded' ? 'bg-emerald-50 text-emerald-700' : status === 'failed' ? 'bg-red-50 text-red-700' : 'bg-accent/10 text-accent' }
function attemptStatusLabel(status: RoutePoolTestAttempt['status']): string { return ({ running: '测试中', succeeded: '成功', failed: '失败，已切换' })[status] }
function testProgress(test: RoutePoolTestRecord): number {
  if (test.status === 'succeeded' || test.status === 'failed') return 100
  if (test.status === 'queued' || test.totalTargets === 0) return 4
  return Math.max(8, Math.min(92, Math.round((test.attemptedTargets / test.totalTargets) * 100)))
}
function formatTarget(target: RouteTestTarget): string { return `${target.providerId} / ${target.modelId}` }
