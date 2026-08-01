import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  OpenConnectorAdminClient,
  OpenConnectorAdminError
} from './open-connector-admin-client'
import type { OpenConnectorSidecar } from './open-connector-sidecar'

describe('OpenConnector admin client', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('maps the five China-first products and keeps admin authorization inside main', async () => {
    const requests: Array<{ url: string; authorization: string | null }> = []
    const client = createClient(async (input, init) => {
      requests.push({
        url: String(input),
        authorization: new Headers(init?.headers).get('authorization')
      })
      return Response.json([feishuProvider()])
    })

    const catalog = await client.catalog()

    expect(catalog.products).toHaveLength(5)
    expect(catalog.products.map((product) => product.id)).toEqual([
      'feishu', 'dingtalk', 'wecom', 'qq-mail', 'netease-mail'
    ])
    expect(catalog.products.find((product) => product.id === 'feishu')).toMatchObject({
      services: ['feishu'],
      region: 'cn',
      logoAssetKey: 'feishu',
      setupKind: 'device_registration_oauth',
      available: true
    })
    expect(catalog.providers[0]).toMatchObject({
      service: 'feishu',
      available: true,
      i18nKey: 'connectors.providers.feishu',
      actions: [{ sideEffect: 'read', i18nKey: 'connectors.actions.feishu.list_calendars' }]
    })
    expect(JSON.stringify(catalog)).not.toContain('admin-secret')
    expect(requests).toEqual([{
      url: 'http://127.0.0.1:18898/api/providers',
      authorization: 'Bearer admin-secret'
    }])
  })

  it('opens only official device-registration pages and never returns app secrets', async () => {
    const openExternal = vi.fn(async () => undefined)
    const client = createClient(async () => Response.json({
      flowId: '11111111-1111-4111-8111-111111111111',
      service: 'feishu',
      connectionName: 'work',
      status: 'pending',
      verificationUri: 'https://accounts.feishu.cn/open-apis/authen/v1/index',
      verificationUriComplete: 'https://accounts.feishu.cn/open-apis/authen/v1/index?code=safe-code',
      userCode: 'SAFE-CODE',
      expiresAt: '2099-01-01T00:00:00.000Z',
      intervalMs: 1500
    }), openExternal)

    const result = await client.startDeviceRegistration({ service: 'feishu', connectionName: 'work' })
    expect(openExternal).toHaveBeenCalledWith(result.verificationUriComplete)
    expect(JSON.stringify(result)).not.toMatch(/secret|clientId/i)

    const unsafe = createClient(async () => Response.json({
      ...result,
      verificationUriComplete: 'https://attacker.example/steal'
    }))
    await expect(unsafe.startDeviceRegistration({ service: 'feishu', connectionName: 'work' }))
      .rejects.toMatchObject({ code: 'unsafe_verification_url' })
  })

  it('opens only host-authored official setup pages for guided providers', async () => {
    const openExternal = vi.fn(async () => undefined)
    const client = createClient(async () => Response.json({}), openExternal)

    await expect(client.openSetupHelp('qq_mail')).resolves.toEqual({
      opened: true,
      host: 'help.mail.qq.com'
    })
    expect(openExternal).toHaveBeenCalledWith('https://help.mail.qq.com/detail/0/1087')
    await expect(client.openSetupHelp('gmail')).rejects.toMatchObject({ code: 'setup_help_not_found' })
  })

  it('promotes a named account through the fixed admin route', async () => {
    const requests: Array<{ path: string; method: string; body: unknown }> = []
    const client = createClient(async (input, init) => {
      requests.push({
        path: new URL(String(input)).pathname,
        method: init?.method ?? 'GET',
        body: JSON.parse(String(init?.body))
      })
      return Response.json({ ...oauthConnection(), connectionName: 'default', default: true })
    })

    await expect(client.setDefault({
      service: 'outlookcalendar',
      connectionName: 'work'
    })).resolves.toMatchObject({ connectionName: 'default', isDefault: true })
    expect(requests).toEqual([{
      path: '/api/connections/outlookcalendar/default',
      method: 'POST',
      body: { connectionName: 'work' }
    }])
  })

  it('opens only HTTPS OAuth URLs and returns a bounded host summary to renderer', async () => {
    const openExternal = vi.fn(async () => undefined)
    const client = createClient(async () => Response.json({
      authorizationUrl: 'https://login.example.test/oauth?state=private-state&client_id=private-client',
      state: 'private-state',
      expiresAt: '2099-01-01T00:00:00.000Z'
    }), openExternal)

    const result = await client.startOAuth({
      service: 'outlookcalendar',
      connectionName: 'work'
    })

    expect(openExternal).toHaveBeenCalledWith(
      'https://login.example.test/oauth?state=private-state&client_id=private-client'
    )
    expect(result).toMatchObject({
      service: 'outlookcalendar',
      connectionName: 'work',
      state: 'private-state',
      authorizationHost: 'login.example.test'
    })
    expect(result).not.toHaveProperty('authorizationUrl')

    const unsafe = createClient(async () => Response.json({
      authorizationUrl: 'http://127.0.0.1/steal',
      state: 'unsafe-state',
      expiresAt: '2099-01-01T00:00:00.000Z'
    }))
    await expect(unsafe.startOAuth({ service: 'gmail', connectionName: 'default' }))
      .rejects.toMatchObject({ code: 'unsafe_authorization_url' })
  })

  it('keeps reauthorization pending for an existing named account until that exact state completes', async () => {
    const requestedPaths: string[] = []
    const client = createClient(async (input) => {
      const url = new URL(String(input))
      requestedPaths.push(url.pathname)
      if (url.pathname === '/api/oauth/authorizations') {
        return Response.json({
          authorizationUrl: 'https://login.example.test/oauth?state=reauth-state',
          state: 'reauth-state',
          expiresAt: '2099-01-01T00:00:00.000Z'
        })
      }
      if (url.pathname === '/api/oauth/authorizations/reauth-state') {
        return Response.json({
          service: 'outlookcalendar',
          connectionName: 'work',
          state: 'reauth-state',
          status: 'pending',
          createdAt: '2026-07-31T00:00:00.000Z',
          expiresAt: '2099-01-01T00:00:00.000Z'
        })
      }
      if (url.pathname === '/api/connections') return Response.json([oauthConnection()])
      throw new Error(`Unexpected request: ${url.pathname}`)
    })

    await client.startOAuth({ service: 'outlookcalendar', connectionName: 'work' })
    await expect(client.pollOAuth({
      service: 'outlookcalendar',
      connectionName: 'work',
      state: 'reauth-state'
    })).resolves.toEqual({ status: 'pending' })

    expect(requestedPaths).not.toContain('/api/connections')
  })

  it('returns connected and terminal OAuth outcomes only for the matching authorization state', async () => {
    let status: 'connected' | 'denied' = 'connected'
    const client = createClient(async (input) => {
      const url = new URL(String(input))
      if (url.pathname === '/api/oauth/authorizations') {
        const state = status === 'connected' ? 'connected-state' : 'denied-state'
        return Response.json({
          authorizationUrl: `https://login.example.test/oauth?state=${state}`,
          state,
          expiresAt: '2099-01-01T00:00:00.000Z'
        })
      }
      if (url.pathname.startsWith('/api/oauth/authorizations/')) {
        const stateValue = url.pathname.split('/').at(-1)
        return Response.json({
          service: 'outlookcalendar',
          connectionName: 'work',
          state: stateValue,
          status,
          createdAt: '2026-07-31T00:00:00.000Z',
          expiresAt: '2099-01-01T00:00:00.000Z',
          completedAt: '2026-07-31T00:01:00.000Z',
          ...(status === 'denied'
            ? { errorCode: 'access_denied', errorMessage: 'OAuth authorization was denied by the provider.' }
            : {})
        })
      }
      if (url.pathname === '/api/connections') return Response.json([oauthConnection()])
      throw new Error(`Unexpected request: ${url.pathname}`)
    })

    await client.startOAuth({ service: 'outlookcalendar', connectionName: 'work' })
    await expect(client.pollOAuth({
      service: 'outlookcalendar', connectionName: 'work', state: 'connected-state'
    })).resolves.toMatchObject({ status: 'connected', connection: { id: 'oauth-connection' } })

    status = 'denied'
    await client.startOAuth({ service: 'outlookcalendar', connectionName: 'work' })
    await expect(client.pollOAuth({
      service: 'outlookcalendar', connectionName: 'work', state: 'denied-state'
    })).resolves.toEqual({
      status: 'denied',
      errorCode: 'access_denied',
      errorMessage: 'OAuth authorization was denied by the provider.'
    })
  })

  it('cancels only the state bound to the matching service and named account', async () => {
    const deletes: string[] = []
    const client = createClient(async (input, init) => {
      const url = new URL(String(input))
      if (url.pathname === '/api/oauth/authorizations') {
        return Response.json({
          authorizationUrl: 'https://login.example.test/oauth?state=cancel-state',
          state: 'cancel-state',
          expiresAt: '2099-01-01T00:00:00.000Z'
        })
      }
      if (url.pathname === '/api/oauth/authorizations/cancel-state' && init?.method === 'DELETE') {
        deletes.push(url.pathname)
        return Response.json({
          service: 'outlookcalendar',
          connectionName: 'work',
          state: 'cancel-state',
          status: 'cancelled',
          createdAt: '2026-07-31T00:00:00.000Z',
          expiresAt: '2099-01-01T00:00:00.000Z',
          completedAt: '2026-07-31T00:01:00.000Z',
          errorCode: 'oauth_authorization_cancelled',
          errorMessage: 'OAuth authorization was cancelled.'
        })
      }
      throw new Error(`Unexpected request: ${url.pathname}`)
    })

    await client.startOAuth({ service: 'outlookcalendar', connectionName: 'work' })
    await expect(client.cancelOAuth({
      service: 'outlookcalendar', connectionName: 'personal', state: 'cancel-state'
    })).resolves.toEqual({ status: 'expired' })
    expect(deletes).toEqual([])

    await expect(client.cancelOAuth({
      service: 'outlookcalendar', connectionName: 'work', state: 'cancel-state'
    })).resolves.toEqual({
      status: 'cancelled',
      errorCode: 'oauth_authorization_cancelled',
      errorMessage: 'OAuth authorization was cancelled.'
    })
    expect(deletes).toEqual(['/api/oauth/authorizations/cancel-state'])
  })

  it('expires bounded OAuth sessions locally without querying or matching an old connection', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-31T00:00:00.000Z'))
    let statusRequests = 0
    const client = createClient(async (input) => {
      const url = new URL(String(input))
      if (url.pathname === '/api/oauth/authorizations') {
        return Response.json({
          authorizationUrl: 'https://login.example.test/oauth?state=timeout-state',
          state: 'timeout-state',
          expiresAt: '2026-07-31T00:00:01.000Z'
        })
      }
      statusRequests += 1
      return Response.json([oauthConnection()])
    })

    await client.startOAuth({ service: 'outlookcalendar', connectionName: 'work' })
    vi.advanceTimersByTime(1_001)

    await expect(client.pollOAuth({
      service: 'outlookcalendar', connectionName: 'work', state: 'timeout-state'
    })).resolves.toEqual({ status: 'expired' })
    expect(statusRequests).toBe(0)
  })

  it('redacts credential-shaped values from upstream errors', async () => {
    const client = createClient(async () => Response.json({
      error: {
        code: 'oauth_failed',
        message: 'client_secret=very-secret Bearer bearer-secret access_token:token-secret'
      }
    }, { status: 400 }))

    let error: unknown
    try {
      await client.catalog()
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(OpenConnectorAdminError)
    expect((error as Error).message).toContain('oauth_failed:')
    expect((error as Error).message).not.toContain('very-secret')
    expect((error as Error).message).not.toContain('bearer-secret')
    expect((error as Error).message).not.toContain('token-secret')
    expect((error as Error).message).toContain('[REDACTED]')
  })
})

function createClient(
  fetchImpl: typeof fetch,
  openExternal: (url: string) => Promise<void> = async () => undefined
): OpenConnectorAdminClient {
  const sidecar = {
    baseUrl: 'http://127.0.0.1:18898',
    adminToken: 'admin-secret',
    start: async () => ({ state: 'running' })
  } as unknown as OpenConnectorSidecar
  return new OpenConnectorAdminClient(sidecar, {
    port: () => 18_898,
    openExternal,
    fetchImpl
  })
}

function outlookCalendarProvider(): Record<string, unknown> {
  return {
    service: 'outlookcalendar',
    displayName: 'Outlook Calendar',
    description: 'Microsoft 365 calendar workflows.',
    categories: ['Calendar'],
    authTypes: ['oauth2'],
    auth: [{
      type: 'oauth2',
      authorizationUrl: 'https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize',
      tokenUrl: 'https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token',
      scopes: ['Calendars.Read'],
      tokenEndpointAuthMethod: 'client_secret_post',
      clientConfigFields: [{
        key: 'tenant',
        label: 'Tenant',
        inputType: 'text',
        required: true,
        secret: false,
        defaultValue: 'common'
      }]
    }],
    homepageUrl: 'https://www.microsoft.com/microsoft-365/outlook/outlook-calendar',
    actions: [{
      id: 'outlookcalendar.list_calendars',
      service: 'outlookcalendar',
      name: 'list_calendars',
      description: 'List calendars.',
      sideEffect: 'read',
      requiredScopes: ['Calendars.Read'],
      providerPermissions: ['Calendars.Read'],
      execution: { locallyExecutable: true }
    }],
    execution: {
      actionCount: 1,
      locallyExecutableActionCount: 1,
      catalogOnlyActionCount: 0
    }
  }
}

function feishuProvider(): Record<string, unknown> {
  const base = outlookCalendarProvider()
  return {
    ...base,
    service: 'feishu',
    displayName: 'Feishu',
    description: 'Feishu collaboration workflows.',
    categories: ['collaboration'],
    actions: [{
      id: 'feishu.list_calendars',
      service: 'feishu',
      name: 'list_calendars',
      description: 'List calendars.',
      sideEffect: 'read',
      requiredScopes: [],
      providerPermissions: [],
      execution: { locallyExecutable: true }
    }]
  }
}

function oauthConnection(): Record<string, unknown> {
  return {
    id: 'oauth-connection',
    service: 'outlookcalendar',
    connectionName: 'work',
    authType: 'oauth2',
    configured: true,
    virtual: false,
    default: false,
    profile: {
      accountId: 'account-id',
      displayName: 'Work account',
      grantedScopes: ['Calendars.Read']
    }
  }
}
