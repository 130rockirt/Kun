import { useCallback, useEffect, useMemo, useState, type DragEvent, type ReactElement } from 'react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
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

const strategyTranslationKeys: Record<ModelRouteStrategy, string> = {
  priority: 'modelRoutes.strategyPriority',
  'round-robin': 'modelRoutes.strategyRoundRobin',
  'weighted-round-robin': 'modelRoutes.strategyWeightedRoundRobin',
  'least-latency': 'modelRoutes.strategyLeastLatency',
  adaptive: 'modelRoutes.strategyAdaptive'
}

function EmptyRoutePoolState({ onAdd, t }: { onAdd: () => void; t: TFunction }): ReactElement {
  return (
    <div className="grid min-h-[360px] place-items-center text-center">
      <div>
        <Route className="mx-auto h-10 w-10 text-ds-faint" />
        <h3 className="mt-3 text-[14px] font-semibold text-ds-ink">{t('modelRoutes.emptyTitle')}</h3>
        <p className="mt-1 text-[12px] text-ds-faint">{t('modelRoutes.gatewayMultipleModelsDesc')}</p>
        <button
          type="button"
          onClick={onAdd}
          className="mt-4 inline-flex h-9 items-center gap-2 rounded-full bg-accent px-4 text-[12px] font-semibold text-white"
        >
          <Plus className="h-3.5 w-3.5" />
          {t('modelRoutes.addModel')}
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
  const { t, i18n } = useTranslation('settings')
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
      if (!response.ok) throw new Error(routeStatusError(response.body, response.status, t))
      setStatus(JSON.parse(response.body) as RouteStatus)
      setStatusError('')
    } catch (error) {
      // Local settings remain durable while Runtime is stopped or unavailable.
      setStatus(null)
      setStatusError(error instanceof Error ? error.message : String(error))
    }
  }, [t])
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
      name: t('modelRoutes.defaultRouteName', { index: ordinal }),
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
      if (!response.ok || !body.test) throw new Error(body.error?.message ?? t('modelRoutes.testCreateFailed'))
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
  const strategies = (Object.keys(strategyTranslationKeys) as ModelRouteStrategy[]).map((id) => ({
    id,
    label: t(strategyTranslationKeys[id])
  }))
  const testButtonLabel = startPending
    ? t('modelRoutes.testButtonCreating')
    : activeTest
      ? t('modelRoutes.testButtonInProgress')
      : saveStatus === 'error'
        ? t('modelRoutes.testButtonFixSave')
        : saveStatus === 'saving'
          ? t('modelRoutes.testButtonWaitSave')
          : !selected?.enabled
        ? t('modelRoutes.testButtonEnableFirst')
        : !selectedHasExecutableTarget
          ? t('modelRoutes.testButtonFixInvalidTargets')
        : !status
          ? t('modelRoutes.runtimeUnavailable')
          : !runtimeReady
            ? t('modelRoutes.testButtonWaitSync')
            : t('modelRoutes.testButtonRun')

  const localSaveLabel = saveStatus === 'saving'
    ? t('modelRoutes.localSaveSaving')
    : saveStatus === 'error'
      ? t('modelRoutes.localSaveFailed')
      : t('modelRoutes.localSaveComplete')
  const runtimeSyncFailed = Boolean(
    !configurationSynced && runtimeSyncStatus?.state === 'failed'
  )
  const runtimeSyncLabel = configurationSynced
    ? t('modelRoutes.runtimeSynced')
    : runtimeSyncFailed
        ? t('modelRoutes.runtimeSyncFailed')
        : !status
          ? runtimeSyncStatus?.state === 'unavailable' ? t('modelRoutes.runtimeNotRunning') : t('modelRoutes.runtimeNotConnected')
              : runtimeSyncStatus?.state === 'syncing'
              ? t('modelRoutes.runtimeSyncing')
              : t('modelRoutes.runtimeWaitingForSync')
  const gatewayBaseUrl = `${publicBaseUrl.replace(/\/$/, '')}/v1`
  const sampleModelId = selected?.modelId || settings.routePools.find((pool) => pool.enabled)?.modelId || 'your-public-model-id'
  const curlExample = buildGatewayCurlExample(gatewayBaseUrl, sampleModelId, t)
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
          ariaLabel={t('modelRoutes.tabsAria')}
          items={[
            { id: 'gateway', label: t('modelRoutes.tabGateway'), icon: Server },
            { id: 'models', label: t('modelRoutes.tabModels'), icon: Boxes },
            { id: 'resilience', label: t('modelRoutes.tabResilience'), icon: AlertTriangle },
            { id: 'monitoring', label: t('modelRoutes.tabMonitoring'), icon: Activity }
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
            <span className="text-[11px] font-medium text-ds-faint">{t('modelRoutes.localRelayProvider')}</span>
            <span className="rounded-full bg-ds-card px-2 py-0.5 text-[10.5px] text-ds-muted">
              {t('modelRoutes.enabledModelCount', {
                enabled: settings.routePools.filter((pool) => pool.enabled).length,
                total: settings.routePools.length
              })}
            </span>
          </div>
          <input
            value={settings.localGateway.name}
            onChange={(event) => onChange({
              ...settings,
              localGateway: { ...settings.localGateway, name: event.target.value }
            })}
            aria-label={t('modelRoutes.providerNameAria')}
            className="mt-1 w-full max-w-md bg-transparent text-[17px] font-semibold text-ds-ink outline-none"
          />
          <p className="mt-1 text-[11.5px] text-ds-faint">{t('modelRoutes.providerDesc')}</p>
        </div>
        <div className="flex items-center gap-3 rounded-xl border border-ds-border bg-ds-card px-3 py-2.5">
          <div>
            <div className="text-[12px] font-medium text-ds-ink">{t('modelRoutes.enableLocalApi')}</div>
            <div className="mt-0.5 text-[10.5px] text-ds-faint">{t('modelRoutes.localOnlyNoAuth')}</div>
          </div>
          <Toggle
            checked={settings.localGateway.enabled}
            onChange={(enabled) => onChange({
              ...settings,
              localGateway: { ...settings.localGateway, enabled }
            })}
            ariaLabel={t('modelRoutes.enableLocalApi')}
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
              {t('modelRoutes.retrySave')}
            </button>
          ) : null}
          {saveStatus === 'error' && saveError ? <span className="min-w-0 truncate text-[11px] text-red-600" title={saveError}>{saveError}</span> : null}
          {!status && statusError ? <span className="min-w-0 truncate text-[11px] text-ds-faint" title={statusError}>{t('modelRoutes.runtimeUnavailableHint')}</span> : null}
          {runtimeSyncFailed && runtimeSyncStatus?.message ? <span className="min-w-0 truncate text-[11px] text-red-600" title={runtimeSyncStatus.message}>{runtimeSyncStatus.message}</span> : null}
        </div>

        <section className="grid basis-full gap-3 rounded-xl border border-ds-border bg-ds-card p-3.5 lg:grid-cols-[minmax(0,1fr)_auto]">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <h3 className="flex items-center gap-1.5 text-[13px] font-semibold text-ds-ink"><Code2 className="h-4 w-4 text-accent" />{t('modelRoutes.localApi')}</h3>
              <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-medium ${settings.localGateway.enabled ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-200' : 'bg-ds-main text-ds-muted'}`}>
                <span className={`h-1.5 w-1.5 rounded-full ${settings.localGateway.enabled ? 'bg-emerald-500' : 'bg-ds-faint'}`} />
                {settings.localGateway.enabled ? t('modelRoutes.localApiEnabledLocalOnly') : t('modelRoutes.disabled')}
              </span>
            </div>
            <p className="mt-1 text-[11px] text-ds-faint">{t('modelRoutes.apiCompatibilityDesc')}</p>
            <div className="mt-2 flex min-w-0 items-center gap-1.5 rounded-lg border border-ds-border bg-ds-main px-2.5 py-2">
              <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-ds-ink" title={gatewayBaseUrl}>{gatewayBaseUrl}</span>
              <button type="button" onClick={() => void copyGatewayText(gatewayBaseUrl, 'base-url')} className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-medium text-ds-muted hover:bg-ds-hover hover:text-ds-ink" aria-label={t('modelRoutes.copyLocalApiAddress')}>
                {copiedValue === 'base-url' ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Clipboard className="h-3.5 w-3.5" />}
                {copiedValue === 'base-url' ? t('modelRoutes.copied') : t('modelRoutes.copy')}
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
              {copiedValue === 'curl' ? t('modelRoutes.copied') : t('modelRoutes.copyCurl')}
            </button>
            <button type="button" onClick={() => setApiDocsOpen((open) => !open)} className="inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border border-ds-border px-3 text-[11.5px] font-medium text-ds-muted hover:bg-ds-hover hover:text-ds-ink" aria-expanded={apiDocsOpen}>
              {t('modelRoutes.apiDocs')} <ChevronDown className={`h-3.5 w-3.5 transition-transform ${apiDocsOpen ? 'rotate-180' : ''}`} />
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
            <h3 className="flex items-center gap-2 text-[14px] font-semibold text-ds-ink"><Boxes className="h-4 w-4 text-accent" />{t('modelRoutes.routedModels')}</h3>
            <p className="mt-1 text-[12px] leading-5 text-ds-faint">{t('modelRoutes.choosePool')}</p>
          </div>
        </div>
        <button type="button" onClick={addPool} className="inline-flex h-9 items-center justify-center gap-2 rounded-xl bg-accent text-[12.5px] font-semibold text-white">
          <Plus className="h-4 w-4" /> {t('modelRoutes.addModel')}
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
                <div className="mt-2 flex items-center justify-between text-[11px] text-ds-muted"><span>{t('modelRoutes.availableTargets', { available, total: pool.targets.length })}{invalid > 0 ? ` · ${t('modelRoutes.invalidTargets', { count: invalid })}` : ''}</span><span>{strategies.find((item) => item.id === pool.strategy)?.label}</span></div>
              </button>
            )
          })}
          {settings.routePools.length === 0 ? <div className="rounded-xl border border-dashed border-ds-border px-3 py-8 text-center text-[12px] text-ds-faint">{t('modelRoutes.noModels')}</div> : null}
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
              <p className="mb-1 text-[11px] font-medium text-accent">{settings.localGateway.name} / {t('modelRoutes.routedModel')}</p>
              <input aria-label={t('modelRoutes.routeModelNameAria')} value={selected.name} onChange={(event) => updatePool({ name: event.target.value })} className="w-full bg-transparent text-[20px] font-semibold text-ds-ink outline-none" />
              <p className="mt-1 text-[12px] text-ds-faint">{t('modelRoutes.hotUpdateHint')}</p>
            </div>
            <div className="flex items-center gap-3"><span className="text-[12px] text-ds-muted">{t('modelRoutes.enable')}</span><Toggle checked={selected.enabled} onChange={(enabled) => updatePool({ enabled })} ariaLabel={t('modelRoutes.enablePoolAria')} /></div>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <Field label={t('modelRoutes.publicModelId')}><input value={selected.modelId} onChange={(event) => updatePool({ modelId: event.target.value })} className={inputClass} spellCheck={false} /></Field>
            <Field label={t('modelRoutes.loadStrategy')}><select value={selected.strategy} onChange={(event) => updatePool({ strategy: event.target.value as ModelRouteStrategy })} className={inputClass}>{strategies.map((strategy) => <option key={strategy.id} value={strategy.id}>{strategy.label}</option>)}</select></Field>
          </div>

          <section className="grid gap-3">
            <div className="flex items-center justify-between"><h3 className="text-[13px] font-semibold text-ds-ink">{t('modelRoutes.routeTargets')}</h3><button type="button" onClick={() => {
              const provider = settings.providers.find((candidate) => candidate.models.length > 0)
              if (!provider) return
              updatePool({ targets: [...selected.targets, { id: `${selected.id}-target-${Date.now().toString(36)}`, providerId: provider.id, modelId: provider.models[0], enabled: true, weight: 1 }] })
            }} className="inline-flex items-center gap-1 rounded-full border border-ds-border px-3 py-1.5 text-[12px] text-ds-muted"><Plus className="h-3.5 w-3.5" /> {t('modelRoutes.addTarget')}</button></div>
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
                      {resolution.status === 'provider-missing' ? <option value={target.providerId}>{t('modelRoutes.providerDeleted', { providerId: target.providerId })}</option> : null}
                      {settings.providers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                    </select>
                    <select value={target.modelId} onChange={(event) => updatePool({ targets: selected.targets.map((item) => item.id === target.id ? { ...item, modelId: event.target.value } : item) })} className={compactInputClass}>
                      {resolution.status !== 'valid' ? <option value={target.modelId}>{resolution.status === 'provider-missing' ? t('modelRoutes.originalModel', { modelId: target.modelId }) : t('modelRoutes.modelDeleted', { modelId: target.modelId })}</option> : null}
                      {(provider?.models ?? []).map((model) => <option key={model} value={model}>{model}</option>)}
                    </select>
                    <input type="number" min={1} max={100} title={t('modelRoutes.weight')} value={target.weight} onChange={(event) => updatePool({ targets: selected.targets.map((item) => item.id === target.id ? { ...item, weight: Number(event.target.value) || 1 } : item) })} className={compactInputClass} />
                    <div className="text-[11px] text-ds-muted">{metric?.ewmaLatencyMs ? `${Math.round(metric.ewmaLatencyMs)} ms` : t('modelRoutes.notProbed')}<br /><span className="text-ds-faint">{metric ? t('modelRoutes.successCount', { successes: metric.successes, total: metric.successes + metric.failures }) : ''}</span></div>
                    <button type="button" onClick={() => updatePool({ targets: selected.targets.filter((item) => item.id !== target.id) })} className="rounded-full p-1.5 text-ds-faint hover:bg-red-50 hover:text-red-600"><Trash2 className="h-4 w-4" /></button>
                    {resolution.status !== 'valid' ? (
                      <div className="flex items-center gap-1.5 text-[11px] text-amber-700 md:col-span-5 md:col-start-3">
                        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                        {resolution.status === 'provider-missing'
                          ? t('modelRoutes.providerMissingWarning', { providerId: target.providerId })
                          : t('modelRoutes.modelMissingWarning', { modelId: target.modelId, providerId: target.providerId })}
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
                  {t('modelRoutes.deleteModel')}
                </button>
              </div>
            </>
          ) : (
            <EmptyRoutePoolState onAdd={addPool} t={t} />
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
              <section className="rounded-xl border border-ds-border p-4">
                <h3 className="flex items-center gap-2 text-[13px] font-semibold text-ds-ink"><AlertTriangle className="h-4 w-4 text-amber-500" />{t('modelRoutes.failoverRules')}</h3>
                <div className="mt-3 grid gap-3 text-[12px] text-ds-muted">
                  <ToggleRow label={t('modelRoutes.networkError')} checked={selected.failurePolicy.failoverOnNetworkError} onChange={(value) => updatePool({ failurePolicy: { ...selected.failurePolicy, failoverOnNetworkError: value } })} />
                  <ToggleRow label={t('modelRoutes.requestTimeout')} checked={selected.failurePolicy.failoverOnTimeout} onChange={(value) => updatePool({ failurePolicy: { ...selected.failurePolicy, failoverOnTimeout: value } })} />
                  <ToggleRow label={t('modelRoutes.credentialError')} checked={selected.failurePolicy.failoverOnAuthError} onChange={(value) => updatePool({ failurePolicy: { ...selected.failurePolicy, failoverOnAuthError: value } })} />
                  <Field label={t('modelRoutes.failoverStatuses')}><input value={selected.failurePolicy.failoverHttpStatusCodes.join(', ')} onChange={(event) => updatePool({ failurePolicy: { ...selected.failurePolicy, failoverHttpStatusCodes: parseCodes(event.target.value) } })} className={compactInputClass} /></Field>
                  <p className="text-[11px] text-ds-faint">{t('modelRoutes.afterStreamNoRetry')}</p>
                </div>
              </section>
              <section className="rounded-xl border border-ds-border p-4">
                <h3 className="flex items-center gap-2 text-[13px] font-semibold text-ds-ink"><Activity className="h-4 w-4 text-emerald-500" />{t('modelRoutes.healthCircuit')}</h3>
                <div className="mt-3 grid grid-cols-3 gap-3">
                  <Field label={t('modelRoutes.consecutiveFailures')}><input type="number" min={1} max={20} value={selected.healthPolicy.failureThreshold} onChange={(event) => updatePool({ healthPolicy: { ...selected.healthPolicy, failureThreshold: Number(event.target.value) } })} className={compactInputClass} /></Field>
                  <Field label={t('modelRoutes.cooldownSeconds')}><input type="number" min={1} value={Math.round(selected.healthPolicy.cooldownMs / 1000)} onChange={(event) => updatePool({ healthPolicy: { ...selected.healthPolicy, cooldownMs: Number(event.target.value) * 1000 } })} className={compactInputClass} /></Field>
                  <Field label={t('modelRoutes.halfOpenProbes')}><input type="number" min={1} max={10} value={selected.healthPolicy.halfOpenMaxAttempts} onChange={(event) => updatePool({ healthPolicy: { ...selected.healthPolicy, halfOpenMaxAttempts: Number(event.target.value) } })} className={compactInputClass} /></Field>
                </div>
              </section>
            </div>
          ) : (
            <EmptyRoutePoolState onAdd={addPool} t={t} />
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
                <h3 className="text-[13px] font-semibold text-ds-ink">{t('modelRoutes.routeValidation')}</h3>
                <p className="mt-1 text-[11px] text-ds-faint">{t('modelRoutes.routeValidationDesc')}</p>
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
                {chainTestBlockedReason({ saveStatus, status, statusError, runtimeSyncStatus, configurationSynced, selectedHasExecutableTarget, invalidTargetCount }, t)}
              </div>
            ) : null}

            {latestTest ? (
              <div className="grid gap-3 rounded-xl border border-ds-border bg-ds-card p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    {activeTest ? <Loader2 className="h-4 w-4 animate-spin text-accent" /> : <Activity className="h-4 w-4 text-accent" />}
                    <span className={`rounded-full px-2 py-1 text-[11px] font-medium ${testStatusClass(latestTest.status)}`}>{testStatusLabel(latestTest.status, t)}</span>
                    <span className="text-[11px] text-ds-faint">{new Date(latestTest.createdAt).toLocaleString(i18n.resolvedLanguage)}</span>
                  </div>
                  <span className="text-[11px] text-ds-muted">{t('modelRoutes.attemptedTargets', { attempted: latestTest.attemptedTargets, total: latestTest.totalTargets })}</span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-ds-main">
                  <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${testProgress(latestTest)}%` }} />
                </div>
                {latestTest.currentTarget ? <p className="text-[12px] text-ds-muted">{t('modelRoutes.testingTarget', { target: formatTarget(latestTest.currentTarget) })}</p> : null}
                {latestTest.selectedTarget ? <p className="text-[12px] text-emerald-700">{t('modelRoutes.finalTargetValue', { target: formatTarget(latestTest.selectedTarget) })}</p> : null}
                {latestTest.output ? <div className="rounded-lg bg-ds-main px-3 py-2 text-[12px] text-ds-muted">{t('modelRoutes.modelResponse', { response: latestTest.output })}</div> : null}
                {latestTest.error ? <div className="rounded-lg bg-red-50 px-3 py-2 text-[12px] text-red-700">{latestTest.error.message}{latestTest.error.category ? ` · ${latestTest.error.category}` : ''}</div> : null}
              </div>
            ) : status ? <div className="rounded-xl border border-dashed border-ds-border px-3 py-6 text-center text-[11px] text-ds-faint">{t('modelRoutes.noTests')}</div> : null}

            {latestTest?.attempts.length ? (
              <div className="overflow-hidden rounded-xl border border-ds-border">
                <div className="bg-ds-main px-3 py-2 text-[11px] font-medium text-ds-muted">{t('modelRoutes.currentTargetProgress')}</div>
                <table className="w-full text-left text-[11.5px]">
                  <thead className="text-ds-faint"><tr><th className="px-3 py-2">{t('modelRoutes.order')}</th><th className="px-3 py-2">{t('modelRoutes.target')}</th><th className="px-3 py-2">{t('modelRoutes.status')}</th><th className="px-3 py-2">{t('modelRoutes.latencyError')}</th></tr></thead>
                  <tbody>{latestTest.attempts.map((attempt) => (
                    <tr key={`${latestTest.id}-${attempt.targetId}`} className="border-t border-ds-border-muted text-ds-muted">
                      <td className="px-3 py-2">{attempt.index}</td>
                      <td className="px-3 py-2">{attempt.providerId} / {attempt.modelId}</td>
                      <td className="px-3 py-2">{attemptStatusLabel(attempt.status, t)}</td>
                      <td className="max-w-[320px] truncate px-3 py-2" title={attempt.message}>{attempt.latencyMs === undefined ? '—' : `${attempt.latencyMs} ms`}{attempt.category ? ` · ${attempt.category}` : ''}{attempt.message ? ` · ${attempt.message}` : ''}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            ) : null}

            {selectedTests.length ? (
              <div className="overflow-hidden rounded-xl border border-ds-border">
                <div className="bg-ds-main px-3 py-2 text-[11px] font-medium text-ds-muted">{t('modelRoutes.recentTests')}</div>
                <table className="w-full text-left text-[11.5px]">
                  <thead className="text-ds-faint"><tr><th className="px-3 py-2">{t('modelRoutes.time')}</th><th className="px-3 py-2">{t('modelRoutes.result')}</th><th className="px-3 py-2">{t('modelRoutes.attempts')}</th><th className="px-3 py-2">{t('modelRoutes.finalTarget')}</th></tr></thead>
                  <tbody>{selectedTests.slice(0, 5).map((test) => (
                    <tr key={test.id} className="border-t border-ds-border-muted text-ds-muted">
                      <td className="px-3 py-2">{new Date(test.createdAt).toLocaleString(i18n.resolvedLanguage)}</td>
                      <td className="px-3 py-2">{testStatusLabel(test.status, t)}</td>
                      <td className="px-3 py-2">{test.attemptedTargets} / {test.totalTargets}</td>
                      <td className="px-3 py-2">{test.selectedTarget ? formatTarget(test.selectedTarget) : '—'}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            ) : null}

            <div className="overflow-hidden rounded-xl border border-ds-border">
              <div className="bg-ds-main px-3 py-2 text-[11px] font-medium text-ds-muted">{t('modelRoutes.recentEvents')}</div>
              <table className="w-full text-left text-[11.5px]">
                <thead className="text-ds-faint"><tr><th className="px-3 py-2">{t('modelRoutes.time')}</th><th className="px-3 py-2">{t('modelRoutes.target')}</th><th className="px-3 py-2">{t('modelRoutes.result')}</th><th className="px-3 py-2">{t('modelRoutes.latency')}</th></tr></thead>
                <tbody>{events.map((event) => <tr key={`${event.at}-${event.targetId}-${event.result}`} className="border-t border-ds-border-muted text-ds-muted"><td className="px-3 py-2">{new Date(event.at).toLocaleTimeString(i18n.resolvedLanguage)}</td><td className="px-3 py-2">{event.providerId} / {event.modelId}</td><td className="px-3 py-2">{event.result}{event.category ? ` · ${event.category}` : ''}</td><td className="px-3 py-2">{event.latencyMs} ms</td></tr>)}</tbody>
              </table>
              {events.length === 0 ? <div className="px-3 py-6 text-center text-[11px] text-ds-faint">{t('modelRoutes.noEvents')}</div> : null}
            </div>
            </section>
          ) : (
            <EmptyRoutePoolState onAdd={addPool} t={t} />
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
  const { t } = useTranslation('settings')
  const [tab, setTab] = useState<GatewayApiTab>('chat')
  useEffect(() => {
    if (typeof globalThis.addEventListener !== 'function') return
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    globalThis.addEventListener('keydown', closeOnEscape)
    return () => globalThis.removeEventListener('keydown', closeOnEscape)
  }, [onClose])

  const guide = gatewayApiGuide(tab, baseUrl, modelId, t)
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/35 p-4 backdrop-blur-[1px]" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <section role="dialog" aria-modal="true" aria-labelledby="local-api-dialog-title" className="grid max-h-[min(760px,calc(100vh-32px))] w-full max-w-4xl overflow-hidden rounded-2xl border border-ds-border bg-ds-card shadow-2xl shadow-slate-950/25">
        <header className="flex items-start justify-between gap-4 border-b border-ds-border-muted px-5 py-4">
          <div>
            <h2 id="local-api-dialog-title" className="flex items-center gap-2 text-[16px] font-semibold text-ds-ink"><Code2 className="h-4 w-4 text-accent" />{t('modelRoutes.apiDialogTitle')}</h2>
            <p className="mt-1 text-[12px] text-ds-muted">{t('modelRoutes.apiDialogDesc')}</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-2 text-ds-muted hover:bg-ds-hover hover:text-ds-ink" aria-label={t('modelRoutes.closeApiDocs')}><X className="h-4 w-4" /></button>
        </header>

        <div className="grid min-h-0 overflow-y-auto md:grid-cols-[196px_minmax(0,1fr)]">
          <aside className="border-b border-ds-border-muted bg-ds-main/35 p-3 md:border-b-0 md:border-r">
            <p className="px-2 pb-2 text-[10.5px] font-medium uppercase tracking-[0.08em] text-ds-faint">{t('modelRoutes.endpoints')}</p>
            <div className="grid gap-1">
              <ApiGuideTab active={tab === 'models'} onClick={() => setTab('models')} method="GET" path="/models">{t('modelRoutes.modelList')}</ApiGuideTab>
              <ApiGuideTab active={tab === 'chat'} onClick={() => setTab('chat')} method="POST" path="/chat/completions">{t('modelRoutes.chatCompletions')}</ApiGuideTab>
              <ApiGuideTab active={tab === 'responses'} onClick={() => setTab('responses')} method="POST" path="/responses">{t('modelRoutes.responses')}</ApiGuideTab>
            </div>
            <div className="mt-4 rounded-lg border border-ds-border bg-ds-card p-2.5 text-[10.5px] leading-4 text-ds-muted">
              <div className="font-medium text-ds-ink">{t('modelRoutes.prerequisites')}</div>
              <p className="mt-1">{t('modelRoutes.prerequisitesDesc')}</p>
            </div>
          </aside>

          <div className="min-w-0 p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2"><span className={`rounded-md px-1.5 py-0.5 font-mono text-[10.5px] font-semibold ${guide.method === 'GET' ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-200' : 'bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-200'}`}>{guide.method}</span><h3 className="font-mono text-[14px] font-semibold text-ds-ink">{guide.path}</h3></div>
                <p className="mt-2 text-[12px] leading-5 text-ds-muted">{guide.description}</p>
              </div>
              <span className="rounded-full bg-ds-main px-2 py-1 text-[10.5px] text-ds-muted">{t('modelRoutes.openAiCompatible')}</span>
            </div>

            <div className="mt-4 rounded-xl border border-ds-border bg-ds-main/45 p-3">
              <div className="flex items-center justify-between gap-3"><span className="text-[11px] font-medium text-ds-muted">{t('modelRoutes.baseUrlLabel')}</span><button type="button" onClick={() => onCopy(baseUrl)} className="inline-flex items-center gap-1 text-[11px] font-medium text-accent hover:opacity-80">{copied ? <Check className="h-3.5 w-3.5" /> : <Clipboard className="h-3.5 w-3.5" />}{copied ? t('modelRoutes.copied') : t('modelRoutes.copy')}</button></div>
              <code className="mt-1.5 block break-all font-mono text-[12px] text-ds-ink">{baseUrl}</code>
            </div>

            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <InfoList title={t('modelRoutes.keyFields')} items={guide.fields} />
              <InfoList title={t('modelRoutes.responsesAndLimits')} items={guide.notes} />
            </div>

            <div className="mt-5 overflow-hidden rounded-xl border border-slate-700 bg-slate-950">
              <div className="flex items-center justify-between gap-3 border-b border-slate-700 px-3 py-2"><span className="text-[11px] font-medium text-slate-300">{t('modelRoutes.curlExample')}</span><button type="button" onClick={() => onCopy(guide.example)} className="inline-flex items-center gap-1 rounded-md bg-white/10 px-2 py-1 text-[10.5px] font-medium text-slate-100 hover:bg-white/15">{copied ? <Check className="h-3.5 w-3.5 text-emerald-300" /> : <Clipboard className="h-3.5 w-3.5" />}{copied ? t('modelRoutes.copied') : t('modelRoutes.copyExample')}</button></div>
              <pre className="overflow-x-auto p-3 font-mono text-[11.5px] leading-5 text-slate-100"><code>{guide.example}</code></pre>
            </div>

            <p className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] leading-4 text-amber-800 dark:border-amber-400/20 dark:bg-amber-500/10 dark:text-amber-100">{t('modelRoutes.apiSecurityWarning')}</p>
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

function gatewayApiGuide(tab: GatewayApiTab, baseUrl: string, modelId: string, t: TFunction): {
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
    description: t('modelRoutes.guideModelsDesc'),
    fields: [t('modelRoutes.guideModelsNoBody'), t('modelRoutes.guideModelsEnabledOnly')],
    notes: [t('modelRoutes.guideModelsResponse'), t('modelRoutes.guideModelsDisabled')],
    example: `curl --request GET ${baseUrl}/models`
  }
  if (tab === 'responses') return {
    method: 'POST',
    path: '/responses',
    description: t('modelRoutes.guideResponsesDesc'),
    fields: [
      t('modelRoutes.guideFieldModel', { modelId }),
      t('modelRoutes.guideResponsesInput'),
      t('modelRoutes.guideResponsesStream'),
      t('modelRoutes.guideResponsesOptional')
    ],
    notes: [t('modelRoutes.guideResponsesNonStreaming'), t('modelRoutes.guideResponsesStreaming')],
    example: buildGatewayResponsesCurlExample(baseUrl, modelId, t)
  }
  return {
    method: 'POST',
    path: '/chat/completions',
    description: t('modelRoutes.guideChatDesc'),
    fields: [
      t('modelRoutes.guideFieldModel', { modelId }),
      t('modelRoutes.guideChatMessages'),
      t('modelRoutes.guideChatStream'),
      t('modelRoutes.guideChatTools')
    ],
    notes: [
      t('modelRoutes.guideChatNonStreaming'),
      t('modelRoutes.guideChatStreaming'),
      t('modelRoutes.guideChatModelMissing')
    ],
    example: buildGatewayCurlExample(baseUrl, modelId, t)
  }
}

function buildGatewayCurlExample(baseUrl: string, modelId: string, t: TFunction): string {
  return `curl --request POST ${baseUrl}/chat/completions \\
  --header 'Content-Type: application/json' \\
  --data '{
    "model": "${modelId}",
    "messages": [
      { "role": "user", "content": ${JSON.stringify(t('modelRoutes.exampleChatPrompt'))} }
    ],
    "stream": false
  }'`
}

function buildGatewayResponsesCurlExample(baseUrl: string, modelId: string, t: TFunction): string {
  return `curl --request POST ${baseUrl}/responses \\
  --header 'Content-Type: application/json' \\
  --data '{
    "model": "${modelId}",
    "input": ${JSON.stringify(t('modelRoutes.exampleResponsesPrompt'))},
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
function routeStatusError(body: string, status: number, t: TFunction): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string }; message?: string }
    return parsed.error?.message?.trim() || parsed.message?.trim() || t('modelRoutes.statusRequestFailed', { status })
  } catch {
    return body.trim() || t('modelRoutes.statusRequestFailed', { status })
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
}, t: TFunction): string {
  if (input.saveStatus === 'error') return t('modelRoutes.blockedSaveFailed')
  if (input.saveStatus === 'saving') return t('modelRoutes.blockedSaving')
  if (!input.selectedHasExecutableTarget) {
    return input.invalidTargetCount > 0
      ? t('modelRoutes.blockedInvalidTargets', { count: input.invalidTargetCount })
      : t('modelRoutes.blockedNoTargets')
  }
  if (!input.configurationSynced && input.runtimeSyncStatus?.state === 'failed') {
    return input.runtimeSyncStatus.message
      ? t('modelRoutes.blockedSyncFailedWithMessage', { message: input.runtimeSyncStatus.message })
      : t('modelRoutes.blockedSyncFailed')
  }
  if (!input.status) return input.statusError
    ? t('modelRoutes.blockedRuntimeUnavailableWithMessage', { message: input.statusError })
    : t('modelRoutes.blockedRuntimeUnavailable')
  if (!input.configurationSynced) return t('modelRoutes.blockedWaitingForSync')
  return t('modelRoutes.blockedRuntimeNotReady')
}
function testStatusLabel(status: RoutePoolTestRecord['status'], t: TFunction): string { return t(`modelRoutes.testStatus.${status}`) }
function testStatusClass(status: RoutePoolTestRecord['status']): string { return status === 'succeeded' ? 'bg-emerald-50 text-emerald-700' : status === 'failed' ? 'bg-red-50 text-red-700' : 'bg-accent/10 text-accent' }
function attemptStatusLabel(status: RoutePoolTestAttempt['status'], t: TFunction): string { return t(`modelRoutes.attemptStatus.${status}`) }
function testProgress(test: RoutePoolTestRecord): number {
  if (test.status === 'succeeded' || test.status === 'failed') return 100
  if (test.status === 'queued' || test.totalTargets === 0) return 4
  return Math.max(8, Math.min(92, Math.round((test.attemptedTargets / test.totalTargets) * 100)))
}
function formatTarget(target: RouteTestTarget): string { return `${target.providerId} / ${target.modelId}` }
