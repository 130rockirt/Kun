import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement
} from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { QRCodeSVG } from 'qrcode.react'
import {
  AlertTriangle,
  Cable,
  CheckCircle2,
  ChevronRight,
  ExternalLink,
  History,
  KeyRound,
  Loader2,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
  X
} from 'lucide-react'
import type {
  OpenConnectorActionDetail,
  OpenConnectorActionSummary,
  OpenConnectorAuth,
  OpenConnectorCatalog,
  OpenConnectorConnection,
  OpenConnectorCredentialField,
  OpenConnectorDeviceRegistrationResult,
  OpenConnectorDeviceRegistrationStartResult,
  OpenConnectorHealth,
  OpenConnectorOAuthConfig,
  OpenConnectorOAuthStartResult,
  OpenConnectorPolicy,
  OpenConnectorProduct,
  OpenConnectorProvider,
  OpenConnectorRun,
  OpenConnectorRunQuery,
  OpenConnectorSideEffect
} from '@shared/open-connector'
import type { KunGuiApi } from '@shared/kun-gui-api'
import {
  defaultOpenConnectorDesktopSettings,
  normalizeOpenConnectorDesktopSettings
} from '@shared/app-settings-connectors'
import { SidebarTitlebarToggleButton } from '../sidebar/SidebarPrimitives'
import { ConnectorLogo, connectorLogoAssetKey } from './ConnectorLogo'

type Props = {
  leftSidebarCollapsed: boolean
  onToggleLeftSidebar: () => void
}

type CenterTab = 'catalog' | 'accounts' | 'policy' | 'runs'
type CatalogFilter = 'recommended' | 'all' | 'connected'
type Notice = {
  tone: 'info' | 'success' | 'error'
  message: string
  technical?: string
}
type ConnectorCenterHostApi = Pick<KunGuiApi, 'connectors' | 'getSettings' | 'setSettings'>
type ConnectorT = TFunction<'connectors'>

export type ConnectorCenterCoreSnapshot = {
  enabled: boolean
  port: number
  catalog: OpenConnectorCatalog
  connections: OpenConnectorConnection[]
  oauthConfigs: OpenConnectorOAuthConfig[]
  health: OpenConnectorHealth
}

export async function loadConnectorCenterCore(
  gui: ConnectorCenterHostApi
): Promise<ConnectorCenterCoreSnapshot> {
  const settings = await gui.getSettings()
  const connectorSettings = normalizeOpenConnectorDesktopSettings(
    settings.connectors ?? defaultOpenConnectorDesktopSettings()
  )
  const [catalog, connections, oauthConfigs] = await Promise.all([
    gui.connectors.catalog(),
    gui.connectors.connections(),
    gui.connectors.oauthConfigs()
  ])
  const health = await gui.connectors.health()
  return {
    enabled: connectorSettings.enabled,
    port: connectorSettings.port,
    catalog,
    connections,
    oauthConfigs,
    health
  }
}

export async function applyConnectorHostSettings(
  gui: ConnectorCenterHostApi,
  settings: { enabled: boolean; port: number }
): Promise<{ health: OpenConnectorHealth; oauthConfigs: OpenConnectorOAuthConfig[] | null }> {
  await gui.setSettings({ connectors: settings })
  const health = settings.enabled
    ? await gui.connectors.start()
    : await gui.connectors.stop()
  const oauthConfigs = settings.enabled && health.state === 'running'
    ? await gui.connectors.oauthConfigs()
    : null
  return { health, oauthConfigs }
}

export const CONNECTOR_OAUTH_PRESETS: Record<string, { label: string; services: string[] }> = {
  gmail: { label: 'Google Workspace', services: ['gmail', 'googlecalendar', 'googledrive'] },
  googlecalendar: { label: 'Google Workspace', services: ['gmail', 'googlecalendar', 'googledrive'] },
  googledrive: { label: 'Google Workspace', services: ['gmail', 'googlecalendar', 'googledrive'] },
  outlook: { label: 'Microsoft 365', services: ['outlook', 'outlookcalendar', 'sharepoint', 'teams'] },
  outlookcalendar: { label: 'Microsoft 365', services: ['outlook', 'outlookcalendar', 'sharepoint', 'teams'] },
  sharepoint: { label: 'Microsoft 365', services: ['outlook', 'outlookcalendar', 'sharepoint', 'teams'] },
  teams: { label: 'Microsoft 365', services: ['outlook', 'outlookcalendar', 'sharepoint', 'teams'] },
  jira: { label: 'Atlassian', services: ['jira', 'confluence'] },
  confluence: { label: 'Atlassian', services: ['jira', 'confluence'] }
}

export function oauthClientSecretRequired(
  tokenEndpointAuthMethod: OpenConnectorOAuthConfig['tokenEndpointAuthMethod']
): boolean {
  return tokenEndpointAuthMethod !== 'none'
}

export function requiredConnectorFieldsComplete(
  fields: OpenConnectorCredentialField[],
  values: Record<string, string>
): boolean {
  return fields.every((field) => !field.required ||
    (values[field.key] ?? field.defaultValue ?? '').trim().length > 0)
}

export function ConnectorCenter({
  leftSidebarCollapsed,
  onToggleLeftSidebar
}: Props): ReactElement {
  const { t } = useTranslation('connectors')
  const [tab, setTab] = useState<CenterTab>('catalog')
  const [filter, setFilter] = useState<CatalogFilter>('recommended')
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('')
  const [catalog, setCatalog] = useState<OpenConnectorCatalog | null>(null)
  const [connections, setConnections] = useState<OpenConnectorConnection[]>([])
  const [oauthConfigs, setOauthConfigs] = useState<OpenConnectorOAuthConfig[]>([])
  const [health, setHealth] = useState<OpenConnectorHealth | null>(null)
  const [selectedService, setSelectedService] = useState<string | null>(null)
  const [actionDetail, setActionDetail] = useState<OpenConnectorActionDetail | null>(null)
  const [policy, setPolicy] = useState<OpenConnectorPolicy | null>(null)
  const [runs, setRuns] = useState<OpenConnectorRun[]>([])
  const [selectedRun, setSelectedRun] = useState<OpenConnectorRun | null>(null)
  const [enabled, setEnabled] = useState(false)
  const [port, setPort] = useState(18_898)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)

  const connectedServices = useMemo(
    () => new Set(connections.filter((connection) => connection.configured).map((connection) => connection.service)),
    [connections]
  )

  const refreshCore = useCallback(async (): Promise<void> => {
    setBusy(true)
    setNotice(null)
    try {
      const snapshot = await loadConnectorCenterCore(window.kunGui)
      setEnabled(snapshot.enabled)
      setPort(snapshot.port)
      setCatalog(snapshot.catalog)
      setConnections(snapshot.connections)
      setOauthConfigs(snapshot.oauthConfigs)
      setHealth(snapshot.health)
    } catch (error) {
      setNotice(localizedError(error, t))
      setHealth(await window.kunGui.connectors.health().catch(() => null))
    } finally {
      setBusy(false)
    }
  }, [t])

  useEffect(() => {
    void refreshCore()
  }, [refreshCore])

  useEffect(() => {
    if (tab === 'policy' && !policy) {
      void window.kunGui.connectors.policy()
        .then(setPolicy)
        .catch((error) => setNotice(localizedError(error, t)))
    }
    if (tab === 'runs') {
      void window.kunGui.connectors.runs({ limit: 50 })
        .then((page) => setRuns(page.items))
        .catch((error) => setNotice(localizedError(error, t)))
    }
  }, [policy, t, tab])

  const providers = useMemo(() => {
    if (!catalog) return []
    const launchServices = new Set(catalog.products.flatMap((product) => product.services))
    const normalizedQuery = query.trim().toLowerCase()
    return catalog.providers.filter((provider) => {
      if (!launchServices.has(provider.service)) return false
      if (filter === 'connected' && !connectedServices.has(provider.service)) return false
      if (category && !provider.categories.includes(category)) return false
      if (!normalizedQuery) return true
      const product = catalog.products.find((item) => item.services.includes(provider.service))
      return [
        provider.service,
        provider.displayName,
        provider.description,
        product ? productName(t, product) : '',
        product ? productDescription(t, product) : '',
        ...provider.actions.flatMap((action) => [action.id, action.name])
      ].some((value) => value.toLowerCase().includes(normalizedQuery))
    })
  }, [catalog, category, connectedServices, filter, query, t])

  const selectedProvider = useMemo(
    () => catalog?.providers.find((provider) => provider.service === selectedService) ?? null,
    [catalog, selectedService]
  )

  const saveHostSettings = useCallback(async (): Promise<void> => {
    if (!Number.isInteger(port) || port < 10_000 || port > 65_535) {
      setNotice({ tone: 'error', message: t('host.invalidPort') })
      return
    }
    setBusy(true)
    try {
      const result = await applyConnectorHostSettings(window.kunGui, { enabled, port })
      setHealth(result.health)
      if (result.oauthConfigs) setOauthConfigs(result.oauthConfigs)
      setNotice(result.health.state === 'running' || !enabled
        ? { tone: 'success', message: enabled ? t('host.enabled') : t('host.disabled') }
        : { tone: 'error', message: t(`health.${result.health.state}`) })
    } catch (error) {
      setNotice(localizedError(error, t))
    } finally {
      setBusy(false)
    }
  }, [enabled, port, t])

  return (
    <div className="flex h-full min-h-0 flex-col bg-ds-main text-ds-ink">
      <header className="ds-drag flex min-h-[64px] shrink-0 items-center gap-3 border-b border-ds-border px-5">
        {leftSidebarCollapsed ? (
          <SidebarTitlebarToggleButton title={t('expandSidebar')} onClick={onToggleLeftSidebar} />
        ) : null}
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <span className="rounded-xl bg-accent/10 p-2 text-accent"><Cable className="h-5 w-5" /></span>
          <div className="min-w-0">
            <h1 className="truncate text-[17px] font-semibold">{t('title')}</h1>
            <p className="truncate text-[12px] text-ds-muted">
              {t('subtitle', { health: healthLabel(t, health) })}
              {health?.version ? ` · ${t('version', { version: health.version, protocol: health.protocolVersion ?? '?' })}` : ''}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => void refreshCore()}
          disabled={busy}
          className="ds-no-drag rounded-lg border border-ds-border p-2 text-ds-muted hover:bg-ds-subtle hover:text-ds-ink disabled:opacity-50"
          aria-label={t('refresh')}
        >
          <RefreshCw className={`h-4 w-4 ${busy ? 'animate-spin' : ''}`} />
        </button>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="w-[210px] shrink-0 border-r border-ds-border bg-ds-sidebar p-3">
          <nav className="space-y-1">
            <NavButton active={tab === 'catalog'} icon={<Search className="h-4 w-4" />} label={t('nav.catalog')} onClick={() => setTab('catalog')} />
            <NavButton active={tab === 'accounts'} icon={<KeyRound className="h-4 w-4" />} label={t('nav.accounts')} onClick={() => setTab('accounts')} />
            <NavButton active={tab === 'policy'} icon={<ShieldCheck className="h-4 w-4" />} label={t('nav.policy')} onClick={() => setTab('policy')} />
            <NavButton active={tab === 'runs'} icon={<History className="h-4 w-4" />} label={t('nav.runs')} onClick={() => setTab('runs')} />
          </nav>

          <div className="mt-5 rounded-xl border border-ds-border bg-ds-card p-3 text-[12px]">
            <label className="flex items-center justify-between gap-2 font-medium">
              {t('host.agentTools')}
              <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} className="accent-[var(--color-accent)]" />
            </label>
            <label className="mt-3 block text-ds-muted">
              {t('host.port')}
              <input
                type="number"
                min={10_000}
                max={65_535}
                value={port}
                onChange={(event) => setPort(Number(event.target.value))}
                className="mt-1 w-full rounded-lg border border-ds-border bg-ds-main px-2 py-1.5 text-ds-ink outline-none focus:border-accent"
              />
            </label>
            <p className="mt-2 leading-4 text-ds-faint">{t('host.portHint')}</p>
            <button type="button" onClick={() => void saveHostSettings()} disabled={busy} className="mt-3 w-full rounded-lg bg-accent px-3 py-1.5 font-medium text-white disabled:opacity-50">
              {t('host.apply')}
            </button>
          </div>
        </aside>

        <section className="min-w-0 flex-1 overflow-auto">
          {notice ? <NoticeView notice={notice} onClose={() => setNotice(null)} /> : null}
          {tab === 'catalog' ? (
            <CatalogView
              catalog={catalog}
              providers={providers}
              connections={connections}
              query={query}
              category={category}
              filter={filter}
              selectedProvider={selectedProvider}
              port={port}
              oauthConfigs={oauthConfigs}
              busy={busy}
              onQuery={setQuery}
              onCategory={setCategory}
              onFilter={setFilter}
              onSelectService={setSelectedService}
              onCloseProvider={() => setSelectedService(null)}
              onConnections={setConnections}
              onOauthConfigs={setOauthConfigs}
              onAction={async (action) => {
                setBusy(true)
                try {
                  setActionDetail(await window.kunGui.connectors.action(action.id))
                } catch (error) {
                  setNotice(localizedError(error, t))
                } finally {
                  setBusy(false)
                }
              }}
              onNotice={setNotice}
              setBusy={setBusy}
            />
          ) : tab === 'accounts' ? (
            <AccountsView
              connections={connections}
              catalog={catalog}
              onConnections={setConnections}
              onSelectService={(service) => {
                setSelectedService(service)
                setTab('catalog')
              }}
              onNotice={setNotice}
            />
          ) : tab === 'policy' ? (
            <PolicyView policy={policy} onPolicy={setPolicy} onNotice={setNotice} />
          ) : (
            <RunsView
              runs={runs}
              selected={selectedRun}
              busy={busy}
              catalog={catalog}
              onSelect={setSelectedRun}
              onSearch={async (runQuery) => {
                setBusy(true)
                try {
                  const page = await window.kunGui.connectors.runs(runQuery)
                  setRuns(page.items)
                  setSelectedRun(null)
                } catch (error) {
                  setNotice(localizedError(error, t))
                } finally {
                  setBusy(false)
                }
              }}
            />
          )}
        </section>
      </div>

      {actionDetail ? <ActionDetailDialog action={actionDetail} catalog={catalog} onClose={() => setActionDetail(null)} /> : null}
    </div>
  )
}

export function CatalogView({
  catalog,
  providers: _providers,
  connections,
  query,
  category,
  filter,
  selectedProvider,
  port,
  oauthConfigs,
  busy,
  onQuery,
  onCategory,
  onFilter,
  onSelectService,
  onCloseProvider,
  onConnections,
  onOauthConfigs,
  onAction,
  onNotice,
  setBusy
}: {
  catalog: OpenConnectorCatalog | null
  providers: OpenConnectorProvider[]
  connections: OpenConnectorConnection[]
  query: string
  category: string
  filter: CatalogFilter
  selectedProvider: OpenConnectorProvider | null
  port: number
  oauthConfigs: OpenConnectorOAuthConfig[]
  busy: boolean
  onQuery: (value: string) => void
  onCategory: (value: string) => void
  onFilter: (value: CatalogFilter) => void
  onSelectService: (service: string) => void
  onCloseProvider: () => void
  onConnections: (connections: OpenConnectorConnection[]) => void
  onOauthConfigs: (configs: OpenConnectorOAuthConfig[]) => void
  onAction: (action: OpenConnectorActionSummary) => Promise<void>
  onNotice: (notice: Notice) => void
  setBusy: (busy: boolean) => void
}): ReactElement {
  const { t } = useTranslation('connectors')
  const normalizedQuery = query.trim().toLowerCase()
  const categories = catalog?.categories ?? []
  const products = (catalog?.products ?? []).filter((product) => {
    const productProviders = (catalog?.providers ?? []).filter((provider) => product.services.includes(provider.service))
    if (normalizedQuery && ![
      productName(t, product),
      productDescription(t, product),
      ...product.services,
      ...productProviders.flatMap((provider) => [provider.displayName, ...provider.actions.flatMap((action) => [action.id, action.name])])
    ].some((value) => value.toLowerCase().includes(normalizedQuery))) return false
    if (category && product.category !== category) return false
    if (filter === 'connected' && !product.services.some((service) => connections.some((item) => item.service === service && item.configured))) return false
    return true
  })

  return (
    <div className="mx-auto max-w-[1180px] p-6">
      <div className="flex flex-wrap items-center gap-2">
        <label className="relative min-w-[260px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-ds-faint" />
          <input value={query} onChange={(event) => onQuery(event.target.value)} placeholder={t('catalog.search')} className="w-full rounded-xl border border-ds-border bg-ds-card py-2 pl-9 pr-3 text-[13px] outline-none focus:border-accent" />
        </label>
        <select value={category} onChange={(event) => onCategory(event.target.value)} className="rounded-xl border border-ds-border bg-ds-card px-3 py-2 text-[13px]">
          <option value="">{t('catalog.allCategories')}</option>
          {categories.map((item) => <option key={item} value={item}>{t(`categories.${item}`, { defaultValue: item })}</option>)}
        </select>
        {(['recommended', 'all', 'connected'] as const).map((value) => (
          <button key={value} type="button" onClick={() => onFilter(value)} className={`rounded-xl px-3 py-2 text-[13px] font-medium ${filter === value ? 'bg-accent text-white' : 'border border-ds-border bg-ds-card text-ds-muted'}`}>
            {t(`catalog.${value}`)}
          </button>
        ))}
      </div>

      {!catalog ? (
        <CenteredLoading label={t('catalog.loading')} />
      ) : products.length === 0 ? (
        <p className="mt-5 rounded-2xl border border-dashed border-ds-border p-10 text-center text-[12px] text-ds-faint">{t('catalog.empty')}</p>
      ) : (
        <div className="mt-5 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {products.map((product) => {
            const productProviders = catalog.providers.filter((provider) => product.services.includes(provider.service))
            const connectedCount = product.services.filter((service) => connections.some((item) => item.service === service && item.configured)).length
            const status = connectedCount === 0
              ? product.available ? t('catalog.available') : t('catalog.notBundled')
              : connectedCount === product.services.length
                ? t('catalog.connected')
                : t('catalog.connectedCount', { count: connectedCount, total: product.services.length })
            return (
              <article key={product.id} className={`rounded-2xl border border-ds-border bg-ds-card p-4 shadow-sm ${product.available ? '' : 'opacity-55'}`}>
                <div className="flex items-start justify-between gap-3">
                  <ConnectorLogo assetKey={product.logoAssetKey} alt={productName(t, product)} />
                  <span className={`rounded-full px-2 py-1 text-[10px] font-semibold ${connectedCount ? 'bg-emerald-500/10 text-emerald-600' : 'bg-ds-subtle text-ds-faint'}`}>{status}</span>
                </div>
                <h2 className="mt-3 text-[15px] font-semibold">{productName(t, product)}</h2>
                <p className="mt-1 min-h-[40px] text-[12px] leading-5 text-ds-muted">{productDescription(t, product)}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {(productProviders.length ? productProviders : [{ service: product.services[0] }]).map((provider) => (
                    <button key={provider.service} type="button" disabled={!product.available} onClick={() => onSelectService(provider.service)} className="group flex items-center rounded-lg bg-accent/10 px-2.5 py-1.5 text-[11px] font-medium text-accent hover:bg-accent/15 disabled:cursor-not-allowed">
                      {connectedCount ? t('catalog.manage') : t('catalog.connect')}
                      <ChevronRight className="ml-1 h-3.5 w-3.5 transition group-hover:translate-x-0.5" />
                    </button>
                  ))}
                </div>
              </article>
            )
          })}
        </div>
      )}

      {selectedProvider ? (
        <ProviderPanel
          provider={selectedProvider}
          product={catalog?.products.find((product) => product.services.includes(selectedProvider.service)) ?? null}
          connections={connections.filter((connection) => connection.service === selectedProvider.service)}
          oauthConfig={oauthConfigs.find((config) => config.service === selectedProvider.service) ?? null}
          catalog={catalog}
          port={port}
          busy={busy}
          onClose={onCloseProvider}
          onConnections={onConnections}
          onOauthConfigs={onOauthConfigs}
          onAction={onAction}
          onNotice={onNotice}
          setBusy={setBusy}
        />
      ) : null}
    </div>
  )
}

export function ProviderPanel({
  provider,
  product = null,
  connections,
  oauthConfig,
  catalog,
  port,
  busy,
  onClose,
  onConnections,
  onOauthConfigs,
  onAction,
  onNotice,
  setBusy
}: {
  provider: OpenConnectorProvider
  product?: OpenConnectorProduct | null
  connections: OpenConnectorConnection[]
  oauthConfig: OpenConnectorOAuthConfig | null
  catalog: OpenConnectorCatalog | null
  port: number
  busy: boolean
  onClose: () => void
  onConnections: (connections: OpenConnectorConnection[]) => void
  onOauthConfigs: (configs: OpenConnectorOAuthConfig[]) => void
  onAction: (action: OpenConnectorActionSummary) => Promise<void>
  onNotice: (notice: Notice) => void
  setBusy: (busy: boolean) => void
}): ReactElement {
  const { t } = useTranslation('connectors')
  const defaultAuth = provider.auth.find((auth) => auth.type === 'oauth2') ?? provider.auth[0]
  const [authType, setAuthType] = useState<OpenConnectorAuth['type']>(defaultAuth?.type ?? 'no_auth')
  const [connectionName, setConnectionName] = useState('default')
  const [values, setValues] = useState<Record<string, string>>({})
  const [clientId, setClientId] = useState(oauthConfig?.clientId ?? '')
  const [clientSecret, setClientSecret] = useState('')
  const [oauthExtra, setOauthExtra] = useState<Record<string, string>>({})
  const [reusePreset, setReusePreset] = useState(true)
  const [oauthStatus, setOauthStatus] = useState('')
  const [activeOAuth, setActiveOAuth] = useState<OpenConnectorOAuthStartResult | null>(null)
  const [deviceFlow, setDeviceFlow] = useState<OpenConnectorDeviceRegistrationStartResult | OpenConnectorDeviceRegistrationResult | null>(null)
  const pollGeneration = useRef(0)
  const displayName = localProviderName(t, provider, product)
  const setupKind = product?.setupKind
  const deviceSetup = setupKind === 'device_registration_oauth' || setupKind === 'device_registration_app'

  useEffect(() => {
    setAuthType((provider.auth.find((auth) => auth.type === 'oauth2') ?? provider.auth[0])?.type ?? 'no_auth')
    setConnectionName('default')
    setValues({})
    setClientId(oauthConfig?.clientId ?? '')
    setClientSecret('')
    setOauthExtra({})
    setOauthStatus('')
    setActiveOAuth(null)
    setDeviceFlow(null)
    setBusy(false)
    pollGeneration.current += 1
  }, [oauthConfig?.clientId, provider.auth, provider.service, setBusy])

  useEffect(() => () => {
    pollGeneration.current += 1
  }, [])

  const auth = provider.auth.find((candidate) => candidate.type === authType) ?? defaultAuth
  const preset = CONNECTOR_OAUTH_PRESETS[provider.service]
  const credentialFields = auth && 'fields' in auth ? auth.fields : []
  const oauthFields = auth?.type === 'oauth2' ? (oauthConfig?.clientConfigFields ?? auth.clientConfigFields) : []
  const validConnectionName = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(connectionName.trim())

  const refreshConnections = async (): Promise<void> => {
    onConnections(await window.kunGui.connectors.connections())
  }

  const connectCredential = async (): Promise<void> => {
    if (!auth || auth.type === 'oauth2') return
    setBusy(true)
    try {
      await window.kunGui.connectors.connect({
        service: provider.service,
        authType: auth.type,
        connectionName: connectionName.trim() || 'default',
        values
      })
      setValues({})
      await refreshConnections()
      onNotice({ tone: 'success', message: t('notices.connected', { provider: displayName }) })
    } catch (error) {
      onNotice(localizedError(error, t))
    } finally {
      setBusy(false)
    }
  }

  const saveOAuthConfig = async (): Promise<void> => {
    setBusy(true)
    try {
      const targets = reusePreset && preset
        ? preset.services.filter((service) => catalog?.providers.some((candidate) => candidate.service === service && candidate.authTypes.includes('oauth2')))
        : [provider.service]
      for (const service of targets) {
        const targetProvider = catalog?.providers.find((candidate) => candidate.service === service)
        const targetAuth = targetProvider?.auth.find((candidate) => candidate.type === 'oauth2')
        const fields = service === provider.service && oauthConfig
          ? oauthConfig.clientConfigFields
          : targetAuth?.type === 'oauth2' ? targetAuth.clientConfigFields : []
        const extra: Record<string, string> = {}
        const secretExtra: Record<string, string> = {}
        for (const field of fields) {
          const value = oauthExtra[field.key] ?? field.defaultValue ?? ''
          if (field.location === 'secretExtra' || field.secret) secretExtra[field.key] = value
          else extra[field.key] = value
        }
        await window.kunGui.connectors.saveOAuthConfig({ service, clientId, clientSecret, extra, secretExtra })
      }
      setClientSecret('')
      setOauthExtra({})
      onOauthConfigs(await window.kunGui.connectors.oauthConfigs())
      onNotice({ tone: 'success', message: t('notices.oauthSaved') })
    } catch (error) {
      onNotice(localizedError(error, t))
    } finally {
      setBusy(false)
    }
  }

  const startOAuth = async (name = connectionName): Promise<void> => {
    const generation = ++pollGeneration.current
    const normalizedName = name.trim() || 'default'
    setBusy(true)
    try {
      const started = await window.kunGui.connectors.startOAuth({ service: provider.service, connectionName: normalizedName })
      if (generation !== pollGeneration.current) return
      setActiveOAuth(started)
      setOauthStatus(t('oauth.waiting', { host: started.authorizationHost }))
      setBusy(false)
      while (generation === pollGeneration.current && Date.now() < Date.parse(started.expiresAt)) {
        await wait(1_500)
        if (generation !== pollGeneration.current) return
        const result = await window.kunGui.connectors.pollOAuth({ service: provider.service, connectionName: normalizedName, state: started.state })
        if (generation !== pollGeneration.current) return
        if (result.status === 'connected') {
          await refreshConnections()
          setActiveOAuth(null)
          setOauthStatus(t('oauth.complete'))
          onNotice({ tone: 'success', message: t('notices.authorized', { provider: displayName }) })
          return
        }
        if (result.status !== 'pending') {
          setActiveOAuth(null)
          setOauthStatus(oauthTerminalMessage(t, result.status))
          onNotice(result.errorMessage
            ? { tone: 'error', message: oauthTerminalMessage(t, result.status), technical: result.errorMessage }
            : { tone: 'error', message: oauthTerminalMessage(t, result.status) })
          return
        }
      }
      if (generation === pollGeneration.current) {
        setActiveOAuth(null)
        setOauthStatus(t('oauth.expired'))
      }
    } catch (error) {
      if (generation !== pollGeneration.current) return
      setActiveOAuth(null)
      setOauthStatus('')
      onNotice(localizedError(error, t))
    } finally {
      if (generation === pollGeneration.current) setBusy(false)
    }
  }

  const cancelOAuth = async (): Promise<void> => {
    if (!activeOAuth) return
    const generation = pollGeneration.current
    setBusy(true)
    try {
      const result = await window.kunGui.connectors.cancelOAuth({
        service: activeOAuth.service,
        connectionName: activeOAuth.connectionName,
        state: activeOAuth.state
      })
      if (generation !== pollGeneration.current) return
      pollGeneration.current += 1
      setActiveOAuth(null)
      setOauthStatus(oauthTerminalMessage(t, result.status))
    } catch (error) {
      onNotice(localizedError(error, t))
    } finally {
      setBusy(false)
    }
  }

  const startDeviceRegistration = async (): Promise<void> => {
    const generation = ++pollGeneration.current
    setBusy(true)
    try {
      const started = await window.kunGui.connectors.startDeviceRegistration({
        service: provider.service,
        connectionName: connectionName.trim() || 'default'
      })
      if (generation !== pollGeneration.current) return
      setDeviceFlow(started)
      setBusy(false)
      while (generation === pollGeneration.current && Date.now() < Date.parse(started.expiresAt)) {
        await wait(Math.max(1_000, started.intervalMs))
        if (generation !== pollGeneration.current) return
        const result = await window.kunGui.connectors.pollDeviceRegistration({ flowId: started.flowId })
        if (generation !== pollGeneration.current) return
        setDeviceFlow(result)
        if (result.status === 'connected') {
          await refreshConnections()
          onNotice({ tone: 'success', message: t('notices.connected', { provider: displayName }) })
          return
        }
        if (result.status === 'authorized') {
          onOauthConfigs(await window.kunGui.connectors.oauthConfigs())
          setOauthStatus(t('setup.authorized'))
          await startOAuth(result.connectionName)
          return
        }
        if (result.status !== 'pending') {
          const message = deviceStatusText(t, result.status, displayName, result.errorCode)
          onNotice(result.errorMessage
            ? { tone: 'error', message, technical: result.errorMessage }
            : { tone: 'error', message })
          return
        }
      }
      if (generation === pollGeneration.current) setDeviceFlow((current) => current ? { ...current, status: 'expired' } : current)
    } catch (error) {
      if (generation !== pollGeneration.current) return
      if (isDeviceRegistrationNotFound(error)) setDeviceFlow(null)
      onNotice(localizedError(error, t))
    } finally {
      if (generation === pollGeneration.current) setBusy(false)
    }
  }

  const cancelDeviceRegistration = async (): Promise<void> => {
    if (!deviceFlow) return
    const generation = pollGeneration.current
    setBusy(true)
    try {
      const result = await window.kunGui.connectors.cancelDeviceRegistration({ flowId: deviceFlow.flowId })
      if (generation !== pollGeneration.current) return
      pollGeneration.current += 1
      setDeviceFlow(result)
    } catch (error) {
      if (isDeviceRegistrationNotFound(error)) setDeviceFlow(null)
      onNotice(localizedError(error, t))
    } finally {
      setBusy(false)
    }
  }

  const credentialSetup = auth && auth.type !== 'oauth2' ? (
    <CredentialSetup
      provider={provider}
      auth={auth}
      authType={authType}
      connectionName={connectionName}
      values={values}
      busy={busy}
      validConnectionName={validConnectionName}
      onAuthType={setAuthType}
      onConnectionName={setConnectionName}
      onValues={setValues}
      onConnect={() => void connectCredential()}
    />
  ) : null

  return (
    <div className="fixed inset-y-0 right-0 z-40 flex w-full max-w-[680px] flex-col border-l border-ds-border bg-ds-main shadow-2xl">
      <div className="flex items-start gap-3 border-b border-ds-border p-5">
        <ConnectorLogo assetKey={product?.logoAssetKey ?? connectorLogoAssetKey(provider.service)} alt={displayName} className="h-11 w-11" />
        <div className="min-w-0 flex-1">
          <h2 className="text-[17px] font-semibold">{displayName}</h2>
          <p className="mt-1 text-[12px] leading-5 text-ds-muted">{localProviderDescription(t, provider, product)}</p>
        </div>
        <button type="button" onClick={onClose} className="rounded-lg p-2 text-ds-muted hover:bg-ds-subtle" aria-label={t('detail.close')}><X className="h-4 w-4" /></button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-5">
        <section>
          <h3 className="text-[13px] font-semibold">{t('provider.accounts')}</h3>
          <div className="mt-2 space-y-2">
            {connections.length === 0 ? <p className="text-[12px] text-ds-faint">{t('provider.none')}</p> : connections.map((connection) => (
              <div key={connection.id} className="flex items-center gap-3 rounded-xl border border-ds-border bg-ds-card p-3">
                <ConnectorLogo assetKey={product?.logoAssetKey ?? connectorLogoAssetKey(provider.service)} alt="" className="h-8 w-8" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[12px] font-semibold">{connection.connectionName}</p>
                  <p className="truncate text-[11px] text-ds-muted">{connection.accountLabel} · {t(`auth.${connection.authType}`)}</p>
                </div>
                {connection.isDefault ? <span className="rounded bg-ds-subtle px-1.5 py-1 text-[9px] font-bold text-ds-faint">{t('provider.default')}</span> : null}
                {!connection.isDefault && !connection.virtual ? (
                  <button type="button" disabled={busy} onClick={() => void window.kunGui.connectors.setDefault({ service: provider.service, connectionName: connection.connectionName }).then(refreshConnections).catch((error) => onNotice(localizedError(error, t)))} className="text-[11px] font-medium text-accent disabled:opacity-50">{t('provider.makeDefault')}</button>
                ) : null}
                {connection.authType === 'oauth2' ? <button type="button" disabled={busy || Boolean(activeOAuth)} onClick={() => void startOAuth(connection.connectionName)} className="text-[11px] font-medium text-accent disabled:opacity-50">{t('provider.reauthorize')}</button> : null}
                <button type="button" onClick={() => void window.kunGui.connectors.disconnect({ service: provider.service, connectionName: connection.connectionName }).then(refreshConnections).catch((error) => onNotice(localizedError(error, t)))} className="rounded-lg p-1.5 text-red-500 hover:bg-red-500/10" aria-label={t('provider.disconnect', { name: connection.connectionName })}><Trash2 className="h-3.5 w-3.5" /></button>
              </div>
            ))}
          </div>
        </section>

        {deviceSetup ? (
          <section className="mt-6 rounded-2xl border border-ds-border bg-ds-card p-4">
            <h3 className="text-[13px] font-semibold">{t('setup.scanTitle')}</h3>
            <p className="mt-1 text-[11px] leading-5 text-ds-muted">{t('setup.scanDescription')}</p>
            {provider.service === 'feishu' ? <p className="mt-2 rounded-lg bg-blue-500/10 px-3 py-2 text-[11px] leading-5 text-blue-700 dark:text-blue-300">{t('setup.feishuReturnHint')}</p> : null}
            <AccountNameField value={connectionName} onChange={setConnectionName} />
            {deviceFlow ? (
              <div className="mt-4 flex flex-col items-center rounded-xl bg-ds-main p-4 text-center">
                {deviceFlow.status === 'pending'
                  ? <QRCodeSVG value={deviceFlow.verificationUriComplete} size={168} level="M" marginSize={2} />
                  : ['authorized', 'connected'].includes(deviceFlow.status)
                    ? <CheckCircle2 className="h-12 w-12 text-emerald-500" />
                    : <AlertTriangle className="h-12 w-12 text-amber-500" />}
                <p className="mt-3 text-[12px] font-medium">{deviceStatusText(
                  t,
                  deviceFlow.status,
                  displayName,
                  'errorCode' in deviceFlow ? deviceFlow.errorCode : undefined
                )}</p>
                {deviceFlow.userCode ? <p className="mt-2 text-[11px] text-ds-muted">{t('setup.userCode')}：<code className="select-all font-semibold text-ds-ink">{deviceFlow.userCode}</code></p> : null}
                <p className="mt-1 text-[10px] text-ds-faint">{t('setup.expiresAt', { time: new Date(deviceFlow.expiresAt).toLocaleTimeString() })}</p>
                {deviceFlow.status === 'pending' ? <button type="button" disabled={busy} onClick={() => void cancelDeviceRegistration()} className="mt-3 rounded-lg bg-red-500/10 px-3 py-2 text-[11px] font-semibold text-red-600">{t('setup.cancel')}</button> : null}
                {['failed', 'expired', 'cancelled', 'denied'].includes(deviceFlow.status) ? <button type="button" disabled={busy} onClick={() => setDeviceFlow(null)} className="mt-3 rounded-lg bg-accent px-3 py-2 text-[11px] font-semibold text-white disabled:opacity-50">{t('setup.retry')}</button> : null}
              </div>
            ) : (
              <button type="button" disabled={busy || !validConnectionName} onClick={() => void startDeviceRegistration()} className="mt-4 flex w-full items-center justify-center rounded-lg bg-accent px-3 py-2.5 text-[12px] font-semibold text-white disabled:opacity-50">
                <ExternalLink className="mr-1.5 h-3.5 w-3.5" />{t('setup.scanButton')}
              </button>
            )}
            {oauthStatus ? <p className="mt-3 text-[11px] text-ds-muted">{oauthStatus}</p> : null}
          </section>
        ) : product?.setupKind === 'guided_credentials' ? (
          <section className="mt-6 rounded-2xl border border-ds-border bg-ds-card p-4">
            <h3 className="text-[13px] font-semibold">{t('setup.guidedTitle')}</h3>
            <p className="mt-1 text-[11px] leading-5 text-ds-muted">{provider.service === 'wecom_bot' ? t('setup.wecomIntro') : t('setup.mailIntro')}</p>
            <button
              type="button"
              onClick={() => void window.kunGui.connectors.openSetupHelp(provider.service)
                .catch((error) => onNotice(localizedError(error, t)))}
              className="mt-3 flex items-center rounded-lg border border-ds-border px-3 py-2 text-[11px] font-medium text-accent hover:bg-ds-subtle"
            >
              <ExternalLink className="mr-1.5 h-3.5 w-3.5" />{t('setup.openOfficial')}
            </button>
            {credentialSetup}
          </section>
        ) : (
          <section className="mt-6 rounded-2xl border border-ds-border bg-ds-card p-4">
            <AuthTabs provider={provider} authType={authType} onAuthType={setAuthType} />
            <AccountNameField value={connectionName} onChange={setConnectionName} />
            {auth?.type === 'oauth2' ? (
              <OAuthManualSetup
                t={t}
                auth={auth}
                oauthConfig={oauthConfig}
                port={port}
                clientId={clientId}
                clientSecret={clientSecret}
                oauthExtra={oauthExtra}
                preset={preset}
                reusePreset={reusePreset}
                oauthFields={oauthFields}
                validConnectionName={validConnectionName}
                activeOAuth={activeOAuth}
                busy={busy}
                onClientId={setClientId}
                onClientSecret={setClientSecret}
                onOauthExtra={setOauthExtra}
                onReusePreset={setReusePreset}
                onSave={() => void saveOAuthConfig()}
                onStart={() => void startOAuth()}
                onCancel={() => void cancelOAuth()}
              />
            ) : credentialSetup}
          </section>
        )}

        {deviceSetup ? (
          <details className="mt-4 rounded-2xl border border-ds-border bg-ds-card p-4">
            <summary className="cursor-pointer text-[12px] font-semibold">{t('setup.advanced')}</summary>
            <div className="mt-4">
              <AuthTabs provider={provider} authType={authType} onAuthType={setAuthType} />
              <AccountNameField value={connectionName} onChange={setConnectionName} />
              {auth?.type === 'oauth2' ? (
                <OAuthManualSetup
                  t={t}
                  auth={auth}
                  oauthConfig={oauthConfig}
                  port={port}
                  clientId={clientId}
                  clientSecret={clientSecret}
                  oauthExtra={oauthExtra}
                  preset={preset}
                  reusePreset={reusePreset}
                  oauthFields={oauthFields}
                  validConnectionName={validConnectionName}
                  activeOAuth={activeOAuth}
                  busy={busy}
                  onClientId={setClientId}
                  onClientSecret={setClientSecret}
                  onOauthExtra={setOauthExtra}
                  onReusePreset={setReusePreset}
                  onSave={() => void saveOAuthConfig()}
                  onStart={() => void startOAuth()}
                  onCancel={() => void cancelOAuth()}
                />
              ) : credentialSetup}
            </div>
          </details>
        ) : null}

        <section className="mt-6">
          <div className="flex items-center justify-between">
            <h3 className="text-[13px] font-semibold">{t('provider.actions')}</h3>
            <span className="text-[11px] text-ds-faint">{t('provider.executable', { count: provider.locallyExecutableActionCount })}</span>
          </div>
          <div className="mt-2 overflow-hidden rounded-xl border border-ds-border">
            {provider.actions.slice(0, 250).map((action) => (
              <button key={action.id} type="button" onClick={() => void onAction(action)} className="flex w-full items-center gap-3 border-b border-ds-border bg-ds-card px-3 py-2.5 text-left last:border-b-0 hover:bg-ds-subtle">
                <SideEffectBadge effect={action.sideEffect} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[11px] font-semibold">{localizedActionTitle(t, action, displayName)}</p>
                  <p className="truncate text-[10px] text-ds-muted">{t('provider.technicalId', { id: action.id })}</p>
                </div>
                <ChevronRight className="h-3.5 w-3.5 text-ds-faint" />
              </button>
            ))}
          </div>
        </section>
      </div>
    </div>
  )
}

function CredentialSetup({
  provider,
  auth,
  authType,
  connectionName,
  values,
  busy,
  validConnectionName,
  onAuthType,
  onConnectionName,
  onValues,
  onConnect
}: {
  provider: OpenConnectorProvider
  auth: Exclude<OpenConnectorAuth, { type: 'oauth2' }>
  authType: OpenConnectorAuth['type']
  connectionName: string
  values: Record<string, string>
  busy: boolean
  validConnectionName: boolean
  onAuthType: (type: OpenConnectorAuth['type']) => void
  onConnectionName: (value: string) => void
  onValues: (values: Record<string, string>) => void
  onConnect: () => void
}): ReactElement {
  const { t } = useTranslation('connectors')
  const fields = 'fields' in auth ? auth.fields : []
  return (
    <div className="mt-4 space-y-3">
      <AuthTabs provider={provider} authType={authType} onAuthType={onAuthType} />
      <AccountNameField value={connectionName} onChange={onConnectionName} />
      {fields.map((field) => (
        <Field
          key={field.key}
          label={localizedFieldLabel(t, field)}
          value={values[field.key] ?? ''}
          secret={field.secret}
          inputType={field.inputType}
          required={field.required}
          placeholder={field.placeholder}
          onChange={(value) => onValues({ ...values, [field.key]: value })}
        />
      ))}
      <button type="button" disabled={busy || !validConnectionName || !requiredConnectorFieldsComplete(fields, values)} onClick={onConnect} className="rounded-lg bg-accent px-3 py-2 text-[12px] font-semibold text-white disabled:opacity-50">{t('setup.connect')}</button>
    </div>
  )
}

function OAuthManualSetup({
  t,
  auth,
  oauthConfig,
  port,
  clientId,
  clientSecret,
  oauthExtra,
  preset,
  reusePreset,
  oauthFields,
  validConnectionName,
  activeOAuth,
  busy,
  onClientId,
  onClientSecret,
  onOauthExtra,
  onReusePreset,
  onSave,
  onStart,
  onCancel
}: {
  t: ConnectorT
  auth: Extract<OpenConnectorAuth, { type: 'oauth2' }>
  oauthConfig: OpenConnectorOAuthConfig | null
  port: number
  clientId: string
  clientSecret: string
  oauthExtra: Record<string, string>
  preset?: { label: string; services: string[] }
  reusePreset: boolean
  oauthFields: OpenConnectorCredentialField[]
  validConnectionName: boolean
  activeOAuth: OpenConnectorOAuthStartResult | null
  busy: boolean
  onClientId: (value: string) => void
  onClientSecret: (value: string) => void
  onOauthExtra: (value: Record<string, string>) => void
  onReusePreset: (value: boolean) => void
  onSave: () => void
  onStart: () => void
  onCancel: () => void
}): ReactElement {
  return (
    <div className="mt-4 space-y-3">
      <div className="rounded-lg bg-ds-subtle p-3 text-[11px] leading-5 text-ds-muted"><span className="font-semibold text-ds-ink">{t('setup.oauthCallback')}</span><code className="mt-1 block select-all break-all">{oauthConfig?.expectedRedirectUri ?? `http://127.0.0.1:${port}/oauth/callback`}</code></div>
      <Field label={t('setup.oauthClientId')} value={clientId} onChange={onClientId} />
      <Field label={oauthConfig?.configured ? t('setup.oauthClientSecretUpdate') : t('setup.oauthClientSecret')} value={clientSecret} secret onChange={onClientSecret} />
      {(oauthConfig?.clientConfigFields ?? auth.clientConfigFields).map((field) => <Field key={field.key} label={localizedFieldLabel(t, field)} value={oauthExtra[field.key] ?? field.defaultValue ?? ''} secret={field.secret} inputType={field.inputType} required={field.required} placeholder={field.placeholder} onChange={(value) => onOauthExtra({ ...oauthExtra, [field.key]: value })} />)}
      {preset ? <label className="flex items-start gap-2 text-[11px] leading-5 text-ds-muted"><input type="checkbox" checked={reusePreset} onChange={(event) => onReusePreset(event.target.checked)} className="mt-1 accent-[var(--color-accent)]" />{t('setup.reuseOAuth', { preset: preset.label })}</label> : null}
      <div className="flex gap-2">
        <button type="button" disabled={busy || !clientId.trim() || !validConnectionName || (oauthClientSecretRequired(oauthConfig?.tokenEndpointAuthMethod ?? auth.tokenEndpointAuthMethod) && !clientSecret) || !requiredConnectorFieldsComplete(oauthFields, oauthExtra)} onClick={onSave} className="rounded-lg bg-ds-subtle px-3 py-2 text-[12px] font-semibold disabled:opacity-50">{t('setup.saveOAuth')}</button>
        {activeOAuth ? <button type="button" disabled={busy} onClick={onCancel} className="rounded-lg bg-red-500/10 px-3 py-2 text-[12px] font-semibold text-red-600 disabled:opacity-50">{t('setup.cancelAuthorization')}</button> : <button type="button" disabled={busy || !oauthConfig?.configured} onClick={onStart} className="flex items-center rounded-lg bg-accent px-3 py-2 text-[12px] font-semibold text-white disabled:opacity-50"><ExternalLink className="mr-1.5 h-3.5 w-3.5" />{t('setup.authorize')}</button>}
      </div>
    </div>
  )
}

function AuthTabs({ provider, authType, onAuthType }: { provider: OpenConnectorProvider; authType: OpenConnectorAuth['type']; onAuthType: (type: OpenConnectorAuth['type']) => void }): ReactElement {
  const { t } = useTranslation('connectors')
  return <div className="flex flex-wrap gap-2">{provider.auth.map((candidate) => <button key={candidate.type} type="button" onClick={() => onAuthType(candidate.type)} className={`rounded-lg px-3 py-1.5 text-[11px] font-semibold ${authType === candidate.type ? 'bg-accent text-white' : 'bg-ds-subtle text-ds-muted'}`}>{t(`auth.${candidate.type}`)}</button>)}</div>
}

function AccountNameField({ value, onChange }: { value: string; onChange: (value: string) => void }): ReactElement {
  const { t } = useTranslation('connectors')
  return <label className="mt-4 block text-[11px] font-medium text-ds-muted">{t('setup.accountName')}<input value={value} maxLength={64} pattern="[A-Za-z0-9][A-Za-z0-9_-]{0,63}" onChange={(event) => onChange(event.target.value)} className="mt-1 w-full rounded-lg border border-ds-border bg-ds-main px-3 py-2 text-[12px] text-ds-ink" /><span className="mt-1 block font-normal text-ds-faint">{t('setup.accountNameHint')}</span></label>
}

function AccountsView({ connections, catalog, onConnections, onSelectService, onNotice }: { connections: OpenConnectorConnection[]; catalog: OpenConnectorCatalog | null; onConnections: (connections: OpenConnectorConnection[]) => void; onSelectService: (service: string) => void; onNotice: (notice: Notice) => void }): ReactElement {
  const { t } = useTranslation('connectors')
  const configured = connections.filter((connection) => connection.configured)
  return (
    <div className="mx-auto max-w-[900px] p-6">
      <h2 className="text-[17px] font-semibold">{t('accounts.title')}</h2>
      <p className="mt-1 text-[12px] text-ds-muted">{t('accounts.description')}</p>
      <div className="mt-5 space-y-3">
        {configured.map((connection) => {
          const provider = catalog?.providers.find((item) => item.service === connection.service)
          const product = catalog?.products.find((item) => item.services.includes(connection.service))
          const name = provider ? localProviderName(t, provider, product) : connection.service
          return <div key={connection.id} className="flex items-center gap-3 rounded-2xl border border-ds-border bg-ds-card p-4"><ConnectorLogo assetKey={product?.logoAssetKey ?? connectorLogoAssetKey(connection.service)} alt={name} className="h-9 w-9" /><div className="min-w-0 flex-1"><p className="truncate text-[13px] font-semibold">{name} · {connection.connectionName}</p><p className="truncate text-[11px] text-ds-muted">{connection.accountLabel} · {t(`auth.${connection.authType}`)}</p></div>{connection.isDefault ? <span className="rounded bg-ds-subtle px-1.5 py-1 text-[9px] font-bold text-ds-faint">{t('provider.default')}</span> : null}{!connection.isDefault && !connection.virtual ? <button type="button" onClick={() => void window.kunGui.connectors.setDefault({ service: connection.service, connectionName: connection.connectionName }).then(() => window.kunGui.connectors.connections()).then(onConnections).catch((error) => onNotice(localizedError(error, t)))} className="rounded-lg border border-ds-border px-3 py-1.5 text-[11px] font-medium text-accent">{t('provider.makeDefault')}</button> : null}<button type="button" onClick={() => onSelectService(connection.service)} className="rounded-lg border border-ds-border px-3 py-1.5 text-[11px] font-medium">{t('accounts.manage')}</button><button type="button" aria-label={t('provider.disconnect', { name: connection.connectionName })} onClick={() => void window.kunGui.connectors.disconnect({ service: connection.service, connectionName: connection.connectionName }).then(() => window.kunGui.connectors.connections()).then(onConnections).catch((error) => onNotice(localizedError(error, t)))} className="rounded-lg p-2 text-red-500 hover:bg-red-500/10"><Trash2 className="h-4 w-4" /></button></div>
        })}
        {configured.length === 0 ? <p className="rounded-xl border border-dashed border-ds-border p-8 text-center text-[12px] text-ds-faint">{t('accounts.empty')}</p> : null}
      </div>
    </div>
  )
}

export function PolicyView({ policy, onPolicy, onNotice }: { policy: OpenConnectorPolicy | null; onPolicy: (policy: OpenConnectorPolicy) => void; onNotice: (notice: Notice) => void }): ReactElement {
  const { t } = useTranslation('connectors')
  const [allowed, setAllowed] = useState('')
  const [blocked, setBlocked] = useState('')
  useEffect(() => {
    if (!policy) return
    setAllowed(policyRuleLines(policy.runtime.allowedActions))
    setBlocked(policyRuleLines(policy.runtime.blockedActions))
  }, [policy])
  if (!policy) return <CenteredLoading label={t('policy.loading')} />
  return <div className="mx-auto max-w-[900px] p-6"><h2 className="text-[17px] font-semibold">{t('policy.title')}</h2><p className="mt-1 text-[12px] leading-5 text-ds-muted">{t('policy.description')}</p><div className="mt-5 grid gap-4 md:grid-cols-2"><PolicyEditor title={t('policy.allowed')} value={allowed} onChange={setAllowed} /><PolicyEditor title={t('policy.blocked')} value={blocked} onChange={setBlocked} /></div><button type="button" onClick={() => void window.kunGui.connectors.updatePolicy({ rules: { allowedActions: lines(allowed), blockedActions: lines(blocked), allowedProxies: [], blockedProxies: ['*'] } }).then((next) => { onPolicy(next); onNotice({ tone: 'success', message: t('policy.saved') }) }).catch((error) => onNotice(localizedError(error, t)))} className="mt-4 rounded-lg bg-accent px-4 py-2 text-[12px] font-semibold text-white">{t('policy.save')}</button></div>
}

export function RunsView({ runs, selected, busy = false, catalog = null, onSelect, onSearch = async () => undefined }: { runs: OpenConnectorRun[]; selected: OpenConnectorRun | null; busy?: boolean; catalog?: OpenConnectorCatalog | null; onSelect: (run: OpenConnectorRun | null) => void; onSearch?: (query: OpenConnectorRunQuery) => Promise<void> }): ReactElement {
  const { t } = useTranslation('connectors')
  const [service, setService] = useState('')
  const [actionId, setActionId] = useState('')
  const [caller, setCaller] = useState<'' | 'http' | 'mcp' | 'web'>('')
  const [result, setResult] = useState<'' | 'success' | 'failure'>('')
  const queryRuns = (): Promise<void> => onSearch({ limit: 50, ...(service.trim() ? { service: service.trim() } : {}), ...(actionId.trim() ? { actionId: actionId.trim() } : {}), ...(caller ? { caller } : {}), ...(result ? { ok: result === 'success' } : {}) })
  return <div className="mx-auto max-w-[1000px] p-6"><h2 className="text-[17px] font-semibold">{t('runs.title')}</h2><p className="mt-1 text-[12px] text-ds-muted">{t('runs.description')}</p><form className="mt-4 grid gap-2 rounded-2xl border border-ds-border bg-ds-card p-3 md:grid-cols-[1fr_1.5fr_auto_auto_auto]" onSubmit={(event) => { event.preventDefault(); void queryRuns() }}><input value={service} onChange={(event) => setService(event.target.value)} placeholder={t('runs.service')} className="rounded-lg border border-ds-border bg-ds-main px-3 py-2 text-[11px]" /><input value={actionId} onChange={(event) => setActionId(event.target.value)} placeholder={t('runs.actionId')} className="rounded-lg border border-ds-border bg-ds-main px-3 py-2 text-[11px]" /><select value={caller} onChange={(event) => setCaller(event.target.value as typeof caller)} className="rounded-lg border border-ds-border bg-ds-main px-3 py-2 text-[11px]"><option value="">{t('runs.allCallers')}</option><option value="http">HTTP</option><option value="mcp">MCP</option><option value="web">Web</option></select><select value={result} onChange={(event) => setResult(event.target.value as typeof result)} className="rounded-lg border border-ds-border bg-ds-main px-3 py-2 text-[11px]"><option value="">{t('runs.allResults')}</option><option value="success">{t('runs.succeeded')}</option><option value="failure">{t('runs.failed')}</option></select><button type="submit" disabled={busy} className="rounded-lg bg-accent px-3 py-2 text-[11px] font-semibold text-white disabled:opacity-50">{t('runs.filter')}</button></form><div className="mt-5 overflow-hidden rounded-2xl border border-ds-border bg-ds-card">{runs.map((run) => { const product = catalog?.products.find((item) => item.services.includes(run.service)); const provider = catalog?.providers.find((item) => item.service === run.service); const name = provider ? localProviderName(t, provider, product) : run.service; return <button key={run.id} type="button" onClick={() => onSelect(run)} className="flex w-full items-center gap-3 border-b border-ds-border px-4 py-3 text-left last:border-b-0 hover:bg-ds-subtle"><ConnectorLogo assetKey={product?.logoAssetKey ?? connectorLogoAssetKey(run.service)} alt={name} className="h-8 w-8" />{run.ok ? <CheckCircle2 className="h-4 w-4 text-emerald-500" /> : <AlertTriangle className="h-4 w-4 text-red-500" />}<div className="min-w-0 flex-1"><p className="truncate text-[12px] font-semibold">{localizedActionTitle(t, { sideEffect: 'unknown' } as OpenConnectorActionSummary, name)}</p><p className="truncate text-[10px] text-ds-muted">{run.actionId} · {run.caller} · {run.connectionLabel ?? t('runs.defaultAccount')} · {new Date(run.startedAt).toLocaleString()}</p></div><span className="text-[10px] text-ds-faint">{run.durationMs} ms</span></button> })}{runs.length === 0 ? <p className="p-8 text-center text-[12px] text-ds-faint">{t('runs.empty')}</p> : null}</div>{selected ? <div className="mt-4 rounded-2xl border border-ds-border bg-ds-card p-4"><div className="flex items-center justify-between"><h3 className="text-[13px] font-semibold">{selected.actionId}</h3><button type="button" onClick={() => onSelect(null)} aria-label={t('detail.close')}><X className="h-4 w-4" /></button></div>{selected.errorMessage ? <details className="mt-3 rounded-lg bg-red-500/10 p-3 text-[11px] text-red-600"><summary>{t('runs.technicalDetails')}</summary><p className="mt-2 break-words">{selected.errorCode}: {selected.errorMessage}</p></details> : null}<RunJson label={t('runs.input')} value={selected.inputSummary} /><RunJson label={t('runs.output')} value={selected.outputSummary} /></div> : null}</div>
}

function ActionDetailDialog({ action, catalog, onClose }: { action: OpenConnectorActionDetail; catalog: OpenConnectorCatalog | null; onClose: () => void }): ReactElement {
  const { t } = useTranslation('connectors')
  const provider = catalog?.providers.find((item) => item.service === action.service)
  const product = catalog?.products.find((item) => item.services.includes(action.service))
  const providerName = provider ? localProviderName(t, provider, product) : action.service
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-5" role="dialog" aria-modal="true"><div className="max-h-[86vh] w-full max-w-[760px] overflow-auto rounded-2xl border border-ds-border bg-ds-main p-5 shadow-2xl"><div className="flex items-start gap-3"><SideEffectBadge effect={action.sideEffect} /><div className="min-w-0 flex-1"><h2 className="text-[15px] font-semibold">{localizedActionTitle(t, action, providerName)}</h2><p className="mt-1 text-[11px] text-ds-muted">{t('provider.technicalId', { id: action.id })}</p></div><button type="button" onClick={onClose} aria-label={t('detail.close')}><X className="h-4 w-4" /></button></div><div className="mt-4 grid gap-3 md:grid-cols-2"><PermissionList title={t('detail.requiredScopes')} values={action.requiredScopes} /><PermissionList title={t('detail.permissions')} values={action.providerPermissions} /></div><SchemaView title={t('detail.inputSchema')} schema={action.inputSchema} /><SchemaView title={t('detail.outputSchema')} schema={action.outputSchema} /><details className="mt-3 rounded-xl border border-ds-border bg-ds-card p-3"><summary className="cursor-pointer text-[11px] font-semibold">{t('errors.technicalDetails')}</summary><p className="mt-2 text-[10px] leading-5 text-ds-muted">{action.description}</p></details></div></div>
}

function NavButton({ active, icon, label, onClick }: { active: boolean; icon: ReactElement; label: string; onClick: () => void }): ReactElement {
  return <button type="button" onClick={onClick} className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-[12px] font-medium ${active ? 'bg-ds-card text-ds-ink shadow-sm' : 'text-ds-muted hover:bg-ds-subtle'}`}>{icon}{label}</button>
}

function NoticeView({ notice, onClose }: { notice: Notice; onClose: () => void }): ReactElement {
  const { t } = useTranslation('connectors')
  const tone = notice.tone === 'error' ? 'border-red-500/40 bg-red-500/10 text-red-600' : notice.tone === 'success' ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600' : 'border-ds-border bg-ds-subtle text-ds-muted'
  return <div className={`mx-6 mt-4 rounded-xl border px-3 py-2 text-[12px] ${tone}`}><div className="flex items-center gap-2"><span className="flex-1">{notice.message}</span><button type="button" onClick={onClose} aria-label={t('detail.close')}><X className="h-3.5 w-3.5" /></button></div>{notice.technical ? <details className="mt-2 text-[10px] opacity-80"><summary className="cursor-pointer">{t('errors.technicalDetails')}</summary><p className="mt-1 break-words font-mono">{notice.technical}</p></details> : null}</div>
}

function Field({ label, value, secret, inputType = 'text', required, placeholder, onChange }: { label: string; value: string; secret?: boolean; inputType?: OpenConnectorCredentialField['inputType']; required?: boolean; placeholder?: string; onChange: (value: string) => void }): ReactElement {
  const control = inputType === 'textarea' || inputType === 'json'
    ? <textarea rows={inputType === 'json' ? 6 : 3} spellCheck={inputType !== 'json'} autoComplete="off" required={required} value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} className={`mt-1 w-full resize-y rounded-lg border border-ds-border bg-ds-main px-3 py-2 text-[12px] text-ds-ink ${inputType === 'json' ? 'font-mono' : ''}`} />
    : <input type={secret || inputType === 'password' ? 'password' : 'text'} autoComplete="off" required={required} value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} className="mt-1 w-full rounded-lg border border-ds-border bg-ds-main px-3 py-2 text-[12px] text-ds-ink" />
  return <label className="block text-[11px] font-medium text-ds-muted">{label}{required ? ' *' : ''}{control}</label>
}

function SideEffectBadge({ effect }: { effect: OpenConnectorSideEffect }): ReactElement {
  const { t } = useTranslation('connectors')
  const styles: Record<OpenConnectorSideEffect, string> = { read: 'bg-sky-500/10 text-sky-600', write: 'bg-amber-500/10 text-amber-600', send: 'bg-violet-500/10 text-violet-600', delete: 'bg-red-500/10 text-red-600', unknown: 'bg-zinc-500/10 text-zinc-500' }
  return <span className={`shrink-0 rounded-md px-2 py-1 text-[9px] font-bold ${styles[effect]}`}>{t(`effects.${effect}`)}</span>
}

function PolicyEditor({ title, value, onChange }: { title: string; value: string; onChange: (value: string) => void }): ReactElement {
  return <label className="block rounded-2xl border border-ds-border bg-ds-card p-4 text-[12px] font-semibold">{title}<textarea value={value} onChange={(event) => onChange(event.target.value)} rows={10} spellCheck={false} placeholder={'service.action\nservice.*'} className="mt-3 w-full resize-y rounded-lg border border-ds-border bg-ds-main p-3 font-mono text-[11px] font-normal leading-5 outline-none focus:border-accent" /></label>
}

function PermissionList({ title, values }: { title: string; values: string[] }): ReactElement {
  const { t } = useTranslation('connectors')
  return <div className="rounded-xl bg-ds-subtle p-3"><h3 className="text-[11px] font-semibold">{title}</h3><div className="mt-2 flex flex-wrap gap-1">{values.length ? values.map((value) => <code key={value} className="rounded bg-ds-card px-1.5 py-1 text-[9px]">{value}</code>) : <span className="text-[10px] text-ds-faint">{t('detail.none')}</span>}</div></div>
}

function SchemaView({ title, schema }: { title: string; schema: Record<string, unknown> }): ReactElement {
  return <details className="mt-3 rounded-xl border border-ds-border bg-ds-card p-3"><summary className="cursor-pointer text-[11px] font-semibold">{title}</summary><pre className="mt-3 overflow-auto whitespace-pre-wrap break-words text-[10px] leading-5 text-ds-muted">{JSON.stringify(schema, null, 2)}</pre></details>
}

function RunJson({ label, value }: { label: string; value: unknown }): ReactElement | null {
  if (value === undefined) return null
  return <div className="mt-3"><h4 className="text-[10px] font-semibold text-ds-muted">{label}</h4><pre className="mt-1 max-h-56 overflow-auto rounded-lg bg-ds-subtle p-3 text-[10px] leading-5">{JSON.stringify(value, null, 2)}</pre></div>
}

function CenteredLoading({ label }: { label: string }): ReactElement {
  return <div className="flex h-64 items-center justify-center text-[12px] text-ds-muted"><Loader2 className="mr-2 h-4 w-4 animate-spin" />{label}</div>
}

function productName(t: ConnectorT, product: OpenConnectorProduct): string {
  return t(`products.${product.id}.name`, { defaultValue: product.displayName })
}

function productDescription(t: ConnectorT, product: OpenConnectorProduct): string {
  return t(`products.${product.id}.description`, { defaultValue: product.description })
}

function localProviderName(t: ConnectorT, provider: OpenConnectorProvider, product?: OpenConnectorProduct | null): string {
  return product ? productName(t, product) : t(`providers.${provider.service}.name`, { defaultValue: provider.displayName })
}

function localProviderDescription(t: ConnectorT, provider: OpenConnectorProvider, product?: OpenConnectorProduct | null): string {
  return product ? productDescription(t, product) : t(`providers.${provider.service}.description`, { defaultValue: provider.service })
}

function localizedActionTitle(
  t: ConnectorT,
  action: Pick<OpenConnectorActionSummary, 'sideEffect'> & Partial<Pick<OpenConnectorActionSummary, 'i18nKey'>>,
  providerName: string
): string {
  const fallback = t(`actionFallback.${action.sideEffect}`, { provider: providerName })
  const key = action.i18nKey?.replace(/^connectors\./, '')
  return key ? t(key, { defaultValue: fallback }) : fallback
}

function localizedFieldLabel(t: ConnectorT, field: OpenConnectorCredentialField): string {
  const normalized = field.key === 'secret' ? 'botSecret' : field.key
  const declaredKey = field.i18nKey.replace(/^connectors\./, '')
  return t(declaredKey, { defaultValue: t(`fields.${normalized}`, { defaultValue: field.label }) })
}

function healthLabel(t: ConnectorT, health: OpenConnectorHealth | null): string {
  if (!health) return t('health.checking')
  if (health.state === 'running') return t('health.running', { url: health.baseUrl })
  return t(`health.${health.state}`)
}

function localizedError(error: unknown, t: ConnectorT): Notice {
  const technical = error instanceof Error ? error.message : String(error)
  const knownCode = ['timeout', 'unavailable', 'unsafe_verification_url', 'device_registration_not_supported', 'device_registration_not_found', 'feishu_redirect_permission_missing', 'feishu_redirect_config_failed']
    .find((code) => technical.toLowerCase().includes(code))
  return {
    tone: 'error',
    message: knownCode ? t(`errors.${knownCode}`) : t('errors.generic'),
    technical: redactTechnicalMessage(technical)
  }
}

function isDeviceRegistrationNotFound(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  const normalized = message.toLowerCase()
  return normalized.includes('device_registration_not_found') ||
    normalized.includes('device registration was not found')
}

function redactTechnicalMessage(value: string): string {
  return value
    .replace(/(authorization|bearer|token|secret|password|code)(\s*[:=]\s*)[^\s,;]+/gi, '$1$2[redacted]')
    .slice(0, 2_000)
}

function deviceStatusText(
  t: ConnectorT,
  status: OpenConnectorDeviceRegistrationResult['status'],
  providerName: string,
  errorCode?: string
): string {
  if (status === 'pending') return t('setup.waiting', { provider: providerName })
  if (status === 'authorized') return t('setup.authorized')
  if (status === 'connected') return t('setup.connected')
  if (errorCode === 'feishu_redirect_permission_missing') return t('errors.feishu_redirect_permission_missing')
  if (errorCode === 'feishu_redirect_config_failed') return t('errors.feishu_redirect_config_failed')
  return t(`oauth.${deviceTerminalKey(status)}`)
}

function deviceTerminalKey(status: OpenConnectorDeviceRegistrationResult['status']): 'failed' | 'expired' | 'cancelled' | 'denied' {
  if (status === 'expired') return 'expired'
  if (status === 'cancelled') return 'cancelled'
  if (status === 'denied') return 'denied'
  return 'failed'
}

function oauthTerminalMessage(t: ConnectorT, status: 'pending' | 'connected' | 'failed' | 'expired' | 'cancelled' | 'denied'): string {
  if (status === 'cancelled') return t('oauth.cancelled')
  if (status === 'denied') return t('oauth.denied')
  if (status === 'expired') return t('oauth.expired')
  if (status === 'connected') return t('oauth.complete')
  return t('oauth.failed')
}

function lines(value: string): string[] {
  return [...new Set(value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean))]
}

export function policyRuleLines(values: string[]): string {
  return values.join('\n')
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
