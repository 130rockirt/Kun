import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import i18n from '../../i18n'
import type {
  OpenConnectorCatalog,
  OpenConnectorConnection,
  OpenConnectorHealth,
  OpenConnectorOAuthConfig,
  OpenConnectorPolicy,
  OpenConnectorProvider,
  OpenConnectorRun
} from '@shared/open-connector'
import type { KunGuiApi } from '@shared/kun-gui-api'
import {
  applyConnectorHostSettings,
  CatalogView,
  CONNECTOR_OAUTH_PRESETS,
  loadConnectorCenterCore,
  oauthClientSecretRequired,
  policyRuleLines,
  PolicyView,
  ProviderPanel,
  requiredConnectorFieldsComplete,
  RunsView
} from './ConnectorCenter'

const PRODUCTS = [
  { id: 'feishu', displayName: 'Feishu', service: 'feishu', category: 'collaboration', setupKind: 'device_registration_oauth' as const },
  { id: 'dingtalk', displayName: 'DingTalk', service: 'dingtalk', category: 'collaboration', setupKind: 'device_registration_app' as const },
  { id: 'wecom', displayName: 'WeCom', service: 'wecom_bot', category: 'collaboration', setupKind: 'guided_credentials' as const },
  { id: 'qq-mail', displayName: 'QQ Mail', service: 'qq_mail', category: 'email', setupKind: 'guided_credentials' as const },
  { id: 'netease-mail', displayName: 'NetEase Mail', service: 'netease_mail', category: 'email', setupKind: 'guided_credentials' as const }
]

function calendarOAuthAuth(
  tokenEndpointAuthMethod: OpenConnectorOAuthConfig['tokenEndpointAuthMethod'] = 'client_secret_post'
): Extract<OpenConnectorProvider['auth'][number], { type: 'oauth2' }> {
  return {
    type: 'oauth2',
    authorizationUrl: 'https://login.example.test/authorize',
    tokenUrl: 'https://login.example.test/token',
    scopes: ['Calendars.ReadWrite'],
    tokenEndpointAuthMethod,
    clientConfigFields: [{
      key: 'tenant',
      i18nKey: 'connectors.fields.tenant',
      label: 'Tenant',
      inputType: 'text',
      required: true,
      secret: false,
      defaultValue: 'common'
    }]
  }
}

function provider(overrides: Partial<OpenConnectorProvider> = {}): OpenConnectorProvider {
  return {
    service: 'feishu',
    displayName: 'Feishu',
    description: 'Manage collaboration.',
    i18nKey: 'connectors.providers.feishu',
    categories: ['collaboration'],
    authTypes: ['oauth2'],
    auth: [calendarOAuthAuth()],
    homepageUrl: null,
    iconUrl: null,
    actions: [{
      id: 'feishu.list_events',
      service: 'feishu',
      name: 'list_events',
      description: 'List events.',
      i18nKey: 'connectors.actions.feishu.list_events',
      sideEffect: 'read',
      requiredScopes: ['Calendars.Read'],
      providerPermissions: [],
      locallyExecutable: true
    }],
    actionCount: 1,
    locallyExecutableActionCount: 1,
    available: true,
    ...overrides
  }
}

function catalog(): OpenConnectorCatalog {
  return {
    generatedAt: '2026-07-31T00:00:00.000Z',
    categories: ['collaboration', 'email'],
    providers: [provider()],
    products: PRODUCTS.map((product) => ({
      id: product.id,
      displayName: product.displayName,
      description: `${product.displayName} connector.`,
      i18nKey: `connectors.products.${product.id}`,
      region: 'cn',
      logoAssetKey: product.id,
      setupKind: product.setupKind,
      services: [product.service],
      category: product.category,
      recommended: true,
      available: true,
      adminConsentRequired: false
    }))
  }
}

function oauthConfig(method: OpenConnectorOAuthConfig['tokenEndpointAuthMethod'] = 'client_secret_post'): OpenConnectorOAuthConfig {
  return {
    service: 'feishu',
    configured: true,
    clientId: 'desktop-client-id',
    expectedRedirectUri: 'http://127.0.0.1:18898/oauth/callback',
    scopes: ['Calendars.ReadWrite'],
    tokenEndpointAuthMethod: method,
    clientConfigFields: calendarOAuthAuth().clientConfigFields
  }
}

function connectorHealth(port = 18_898): OpenConnectorHealth {
  return {
    state: 'running',
    enabled: true,
    managed: true,
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    version: '1.4.0',
    protocolVersion: '1',
    checkedAt: '2026-07-31T00:00:00.000Z'
  }
}

function namedConnection(overrides: Partial<OpenConnectorConnection> = {}): OpenConnectorConnection {
  return {
    id: 'feishu:work',
    service: 'feishu',
    connectionName: 'work',
    authType: 'oauth2',
    configured: true,
    virtual: false,
    isDefault: false,
    accountId: 'account-1',
    accountLabel: 'Work account',
    displayName: 'Work account',
    ...overrides
  }
}

describe('ConnectorCenter', () => {
  beforeAll(async () => {
    await i18n.changeLanguage('en')
    await i18n.loadNamespaces('connectors')
  })
  it('reads health only after startup-owning catalog calls finish', async () => {
    const calls: string[] = []
    let resolveCatalog!: (value: OpenConnectorCatalog) => void
    const pendingCatalog = new Promise<OpenConnectorCatalog>((resolve) => {
      resolveCatalog = resolve
    })
    const connectors = {
      catalog: vi.fn(() => {
        calls.push('catalog')
        return pendingCatalog
      }),
      connections: vi.fn(async () => {
        calls.push('connections')
        return []
      }),
      oauthConfigs: vi.fn(async () => {
        calls.push('oauthConfigs')
        return []
      }),
      health: vi.fn(async () => {
        calls.push('health')
        return connectorHealth()
      })
    }
    const gui = {
      getSettings: vi.fn(async () => ({ connectors: { enabled: true, port: 18_898 } })),
      connectors
    } as unknown as Pick<KunGuiApi, 'connectors' | 'getSettings' | 'setSettings'>

    const pending = loadConnectorCenterCore(gui)
    await vi.waitFor(() => expect(connectors.oauthConfigs).toHaveBeenCalledOnce())
    expect(connectors.health).not.toHaveBeenCalled()
    resolveCatalog(catalog())

    const snapshot = await pending
    expect(snapshot.health.state).toBe('running')
    expect(calls.at(-1)).toBe('health')
  })

  it('refreshes OAuth callback metadata after applying a new active port', async () => {
    const calls: string[] = []
    const refreshedConfig = {
      ...oauthConfig(),
      expectedRedirectUri: 'http://127.0.0.1:19123/oauth/callback'
    }
    const gui = {
      setSettings: vi.fn(async () => {
        calls.push('settings')
        return {} as never
      }),
      connectors: {
        start: vi.fn(async () => {
          calls.push('start')
          return connectorHealth(19_123)
        }),
        oauthConfigs: vi.fn(async () => {
          calls.push('oauthConfigs')
          return [refreshedConfig]
        })
      }
    } as unknown as Pick<KunGuiApi, 'connectors' | 'getSettings' | 'setSettings'>

    const result = await applyConnectorHostSettings(gui, { enabled: true, port: 19_123 })

    expect(result.oauthConfigs?.[0]?.expectedRedirectUri).toContain(':19123/')
    expect(calls).toEqual(['settings', 'start', 'oauthConfigs'])
  })

  it('renders the five China-first product cards from the host catalog', () => {
    const html = renderToStaticMarkup(createElement(CatalogView, {
      catalog: catalog(),
      providers: [provider()],
      connections: [],
      query: '',
      category: '',
      filter: 'recommended',
      selectedProvider: null,
      port: 18_898,
      oauthConfigs: [],
      busy: false,
      onQuery: () => undefined,
      onCategory: () => undefined,
      onFilter: () => undefined,
      onSelectService: () => undefined,
      onCloseProvider: () => undefined,
      onConnections: () => undefined,
      onOauthConfigs: () => undefined,
      onAction: async () => undefined,
      onNotice: () => undefined,
      setBusy: () => undefined
    }))

    for (const product of PRODUCTS) expect(html).toContain(product.displayName)
    expect(html).not.toContain('Outlook Calendar')
  })

  it('matches recommended cards through provider action text and provider categories', () => {
    const common = {
      catalog: catalog(),
      providers: [provider()],
      connections: [],
      filter: 'recommended' as const,
      selectedProvider: null,
      port: 19_123,
      oauthConfigs: [],
      busy: false,
      onQuery: () => undefined,
      onCategory: () => undefined,
      onFilter: () => undefined,
      onSelectService: () => undefined,
      onCloseProvider: () => undefined,
      onConnections: () => undefined,
      onOauthConfigs: () => undefined,
      onAction: async () => undefined,
      onNotice: () => undefined,
      setBusy: () => undefined
    }
    const byAction = renderToStaticMarkup(createElement(CatalogView, {
      ...common,
      query: 'list_events',
      category: ''
    }))
    const byProviderCategory = renderToStaticMarkup(createElement(CatalogView, {
      ...common,
      query: '',
      category: 'collaboration'
    }))

    expect(byAction).toContain('Feishu')
    expect(byProviderCategory).toContain('Feishu')
  })

  it('renders local brand images instead of letter placeholders', () => {
    const html = renderToStaticMarkup(createElement(CatalogView, {
      catalog: catalog(),
      providers: [provider()],
      connections: [],
      query: '',
      category: '',
      filter: 'recommended',
      selectedProvider: null,
      port: 18_898,
      oauthConfigs: [],
      busy: false,
      onQuery: () => undefined,
      onCategory: () => undefined,
      onFilter: () => undefined,
      onSelectService: () => undefined,
      onCloseProvider: () => undefined,
      onConnections: () => undefined,
      onOauthConfigs: () => undefined,
      onAction: async () => undefined,
      onNotice: () => undefined,
      setBusy: () => undefined
    }))

    expect(html).toContain('<img')
    expect(html).toContain('data:image/svg+xml')
  })

  it('uses the actual outlookcalendar service ID when sharing Microsoft OAuth app settings', () => {
    expect(CONNECTOR_OAUTH_PRESETS.outlookcalendar?.services).toEqual([
      'outlook', 'outlookcalendar', 'sharepoint', 'teams'
    ])
    expect(CONNECTOR_OAUTH_PRESETS.outlook_calendar).toBeUndefined()
  })

  it('renders dynamic OAuth configuration fields and requires a secret for confidential clients', () => {
    const html = renderToStaticMarkup(createElement(ProviderPanel, {
      provider: provider(),
      connections: [],
      oauthConfig: oauthConfig(),
      catalog: catalog(),
      port: 18_898,
      busy: false,
      onClose: () => undefined,
      onConnections: () => undefined,
      onOauthConfigs: () => undefined,
      onAction: async () => undefined,
      onNotice: () => undefined,
      setBusy: () => undefined
    }))

    expect(html).toContain('Exact callback URL')
    expect(html).toContain('OAuth client secret (enter again to update)')
    expect(html).toContain('Tenant')
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Save OAuth app<\/button>/)
    expect(oauthClientSecretRequired('client_secret_post')).toBe(true)
    expect(oauthClientSecretRequired('client_secret_basic')).toBe(true)
  })

  it('requires every host-authored required credential field', () => {
    const fields = calendarOAuthAuth().clientConfigFields
    expect(requiredConnectorFieldsComplete(fields, {})).toBe(true)
    expect(requiredConnectorFieldsComplete([
      ...fields,
      { key: 'audience', i18nKey: 'connectors.fields.audience', label: 'Audience', inputType: 'text', required: true, secret: false }
    ], {})).toBe(false)
    expect(requiredConnectorFieldsComplete([
      ...fields,
      { key: 'audience', i18nKey: 'connectors.fields.audience', label: 'Audience', inputType: 'text', required: true, secret: false }
    ], { audience: 'graph' })).toBe(true)
  })

  it('permits public OAuth clients to save an app configuration without a secret', () => {
    const html = renderToStaticMarkup(createElement(ProviderPanel, {
      provider: provider({ auth: [calendarOAuthAuth('none')] }),
      connections: [],
      oauthConfig: oauthConfig('none'),
      catalog: catalog(),
      port: 18_898,
      busy: false,
      onClose: () => undefined,
      onConnections: () => undefined,
      onOauthConfigs: () => undefined,
      onAction: async () => undefined,
      onNotice: () => undefined,
      setBusy: () => undefined
    }))

    const saveButton = html.match(/<button[^>]*>Save OAuth app<\/button>/)?.[0]
    expect(saveButton).toBeDefined()
    expect(saveButton).not.toContain('disabled=""')
    expect(oauthClientSecretRequired('none')).toBe(false)
  })

  it('offers explicit promotion for a non-default named account', () => {
    const html = renderToStaticMarkup(createElement(ProviderPanel, {
      provider: provider(),
      connections: [namedConnection()],
      oauthConfig: oauthConfig(),
      catalog: catalog(),
      port: 18_898,
      busy: false,
      onClose: () => undefined,
      onConnections: () => undefined,
      onOauthConfigs: () => undefined,
      onAction: async () => undefined,
      onNotice: () => undefined,
      setBusy: () => undefined
    }))

    expect(html).toContain('Make default')
    expect(html).toContain('Reauthorize')
  })

  it('renders policy rules and redacted run details', () => {
    const policy: OpenConnectorPolicy = {
      deployment: { allowedActions: [], blockedActions: [], allowedProxies: [], blockedProxies: ['*'] },
      runtime: { allowedActions: ['outlookcalendar.list_events'], blockedActions: ['teams.send_channel_message'], allowedProxies: [], blockedProxies: ['*'] }
    }
    const run: OpenConnectorRun = {
      id: 'run-1',
      service: 'teams',
      actionId: 'teams.send_channel_message',
      caller: 'http',
      startedAt: '2026-07-31T00:00:00.000Z',
      completedAt: '2026-07-31T00:00:01.000Z',
      durationMs: 1000,
      ok: false,
      inputSummary: { body: '[REDACTED]' },
      outputSummary: { status: 'blocked' },
      errorCode: 'policy_denied',
      errorMessage: 'The connector policy blocked this action.'
    }

    const policyHtml = renderToStaticMarkup(createElement(PolicyView, {
      policy,
      onPolicy: () => undefined,
      onNotice: () => undefined
    }))
    const runsHtml = renderToStaticMarkup(createElement(RunsView, {
      runs: [run],
      selected: run,
      onSelect: () => undefined
    }))

    expect(policyHtml).toContain('Save policy')
    expect(policyRuleLines(policy.runtime.allowedActions)).toBe('outlookcalendar.list_events')
    expect(policyRuleLines(policy.runtime.blockedActions)).toBe('teams.send_channel_message')
    expect(runsHtml).toContain('[REDACTED]')
    expect(runsHtml).toContain('policy_denied')
    expect(runsHtml).toContain('Service (for example feishu)')
    expect(runsHtml).toContain('All callers')
    expect(runsHtml).toContain('All results')
  })
})
