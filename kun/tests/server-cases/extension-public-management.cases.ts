import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseExtensionManifest } from '@kun/extension-api'
import {
  ExtensionPaths,
  ExtensionRegistry,
  manifestCompatibilityReport,
  type DevelopmentExtensionRecord
} from '../../src/extensions/index.js'
import { ExtensionViewSessionService } from '../../src/services/extension-view-session-service.js'
import { extensionProviderId } from '../../src/services/extension-provider-account-store.js'
import type { ExtensionAgentEvent } from '../../src/services/extension-agent-service.js'
import type { ServerRuntime } from '../../src/server/routes/server-runtime.js'
import {
  buildExtensionPublicRouter,
  EXTENSION_SESSION_ID_HEADER,
  EXTENSION_SESSION_NONCE_HEADER
} from '../../src/server/routes/extension-public.js'
import {
  WORKSPACE_ROOT,
  createFixture,
  createSession,
  dispatchJson,
  dispatchRaw,
  runtimeHeaders,
  sessionHeaders
} from './extension-public-fixture.js'

describe('extension public routes', () => {
  it('cancels a pending Webview SDK request by session and request identity', async () => {
    const fixture = await createFixture()
    fixture.broker.handlePrincipal.mockImplementation(({ signal }: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
      })
    )
    const router = buildExtensionPublicRouter(fixture.runtime)
    const created = await createSession(router)
    const headers = sessionHeaders(created.body.sessionId, created.body.nonce)
    const pending = dispatchJson(
      router,
      'POST',
      `/v1/extensions/view-sessions/${created.body.sessionId}/requests`,
      { requestId: 'request-cancel-1', method: 'ui.getTheme', params: {}, timeoutMs: 10_000 },
      headers
    )
    await vi.waitFor(() => expect(fixture.broker.handlePrincipal).toHaveBeenCalled())

    const cancelled = await dispatchJson(
      router,
      'POST',
      `/v1/extensions/view-sessions/${created.body.sessionId}/requests/request-cancel-1/cancel`,
      undefined,
      headers
    )
    expect(cancelled).toMatchObject({ status: 200, body: { cancelled: true } })
    await expect(pending).resolves.toMatchObject({
      status: 408,
      body: { code: 'request_cancelled' }
    })
  })

  it('exposes headless tool/provider/account projections while keeping direct tools behind ToolHost', async () => {
    const fixture = await createFixture()
    const router = buildExtensionPublicRouter(fixture.runtime)
    const created = await createSession(router)
    const headers = sessionHeaders(created.body.sessionId, created.body.nonce)

    const tools = await dispatchJson(router, 'GET', '/v1/extensions/tools', undefined, headers)
    expect(tools).toMatchObject({
      status: 200,
      body: { tools: [{ localId: 'echo', sideEffect: 'none' }] }
    })
    const directInvoke = router.match('POST', '/v1/extensions/tools/tool-id/invoke')
    expect(directInvoke).toBeUndefined()

    const providers = await dispatchJson(router, 'GET', '/v1/extensions/providers', undefined, headers)
    expect(providers.status).toBe(200)
    expect(providers.body.providers[0]).toMatchObject({
      id: 'ext-provider',
      ownerExtensionId: 'acme.dashboard'
    })
    expect(providers.body.providers[0]).not.toHaveProperty('apiKey')

    const accounts = await dispatchJson(router, 'GET', '/v1/extensions/accounts', undefined, headers)
    expect(accounts.status).toBe(200)
    expect(accounts.body.accounts[0]).toMatchObject({
      id: 'account-1',
      providerId: 'ext-provider',
      authenticationType: 'api-key'
    })
    expect(JSON.stringify(accounts.body)).not.toContain('credentialRef')
    expect(JSON.stringify(accounts.body)).not.toContain('super-secret')
  })

  it('keeps trusted account management extension-owned and secret-redacted', async () => {
    const fixture = await createFixture()
    const router = buildExtensionPublicRouter(fixture.runtime)

    const listed = await dispatchJson(
      router,
      'GET',
      '/v1/extensions/accounts?extension_id=acme.dashboard&provider_id=provider&include_unavailable=false',
      undefined,
      runtimeHeaders()
    )
    expect(listed).toMatchObject({ status: 200, body: { accounts: [{ id: 'account-1' }] } })

    fixture.broker.handleTrustedManagement.mockResolvedValue({
      id: 'account-session-created',
      status: 'pending',
      verificationUrl: 'https://auth.example/authorize'
    })
    const accountSession = await dispatchJson(
      router,
      'POST',
      '/v1/extensions/accounts/sessions',
      {
        extensionId: 'acme.dashboard',
        extensionVersion: '1.0.0',
        providerId: 'provider',
        authenticationProviderId: 'key-auth',
        workspaceRoot: '/workspace'
      },
      runtimeHeaders()
    )
    expect(accountSession).toMatchObject({
      status: 201,
      body: { session: { id: 'account-session-created', status: 'pending' } }
    })
    expect(fixture.manager.activate).toHaveBeenCalledWith(
      'acme.dashboard',
      'onAuthentication:key-auth',
      { workspaceRoot: WORKSPACE_ROOT }
    )
    expect(fixture.broker.handleTrustedManagement).toHaveBeenCalledWith(expect.objectContaining({
      principal: expect.objectContaining({
        extensionId: 'acme.dashboard',
        extensionVersion: '1.0.0',
        workspaceRoots: [WORKSPACE_ROOT]
      }),
      method: 'authentication.createSession'
    }))

    const created = await dispatchJson(router, 'POST', '/v1/extensions/accounts/api-key', {
      extensionId: 'acme.dashboard',
      extensionVersion: '1.0.0',
      providerId: 'provider',
      authenticationProviderId: 'key-auth',
      label: 'Protected account',
      secret: 'sk-never-project-this'
    }, runtimeHeaders())
    expect(created.status).toBe(201)
    expect(JSON.stringify(created.body)).not.toContain('sk-never-project-this')
    expect(fixture.accounts.createApiKeyAccount).toHaveBeenCalledWith(expect.objectContaining({
      providerId: fixture.canonicalProviderId,
      apiKey: 'sk-never-project-this',
      protectedInput: true,
      principal: expect.objectContaining({ extensionId: 'acme.dashboard' })
    }))

    fixture.broker.completePkceAccountSession.mockResolvedValue({
      id: 'account-session-123456',
      status: 'completed',
      account: created.body.account
    })
    const completed = await dispatchJson(
      router,
      'POST',
      '/v1/extensions/accounts/sessions/account-session-123456/complete',
      {
        extensionId: 'acme.dashboard',
        extensionVersion: '1.0.0',
        callbackUrl: 'https://callback.example/?code=protected-code&state=protected-state'
      },
      runtimeHeaders()
    )
    expect(completed).toMatchObject({ status: 200, body: { session: { status: 'completed' } } })
    expect(fixture.broker.completePkceAccountSession).toHaveBeenCalledWith(expect.objectContaining({
      principal: expect.objectContaining({ extensionId: 'acme.dashboard' }),
      sessionId: 'account-session-123456',
      callbackUrl: 'https://callback.example/?code=protected-code&state=protected-state'
    }))

    const renamed = await dispatchJson(
      router,
      'PATCH',
      '/v1/extensions/accounts/account-1/label',
      {
        extensionId: 'acme.dashboard',
        extensionVersion: '1.0.0',
        providerId: 'provider',
        label: 'Renamed account'
      },
      runtimeHeaders()
    )
    expect(renamed).toMatchObject({
      status: 200,
      body: { account: { id: 'account-1', label: 'Renamed account' } }
    })
    expect(fixture.accounts.renameAccount).toHaveBeenCalledWith(expect.objectContaining({
      accountId: 'account-1',
      label: 'Renamed account',
      principal: expect.objectContaining({ extensionId: 'acme.dashboard' })
    }))

    const replaced = await dispatchJson(
      router,
      'PUT',
      '/v1/extensions/accounts/account-1/api-key',
      {
        extensionId: 'acme.dashboard',
        extensionVersion: '1.0.0',
        providerId: 'provider',
        secret: 'replacement-never-project-this'
      },
      runtimeHeaders()
    )
    expect(replaced.status).toBe(200)
    expect(JSON.stringify(replaced.body)).not.toContain('replacement-never-project-this')
    expect(fixture.accounts.replaceApiKeyAccount).toHaveBeenCalledWith(expect.objectContaining({
      accountId: 'account-1',
      apiKey: 'replacement-never-project-this',
      protectedInput: true,
      principal: expect.objectContaining({ extensionId: 'acme.dashboard' })
    }))

    const deleted = await dispatchJson(
      router,
      'DELETE',
      '/v1/extensions/accounts/account-1',
      {
        extensionId: 'acme.dashboard',
        extensionVersion: '1.0.0',
        providerId: 'provider'
      },
      runtimeHeaders()
    )
    expect(deleted).toMatchObject({ status: 200, body: { deleted: true } })

    const wrongOwner = await dispatchJson(
      router,
      'DELETE',
      '/v1/extensions/accounts/account-1',
      {
        extensionId: 'other.extension',
        extensionVersion: '1.0.0',
        providerId: 'provider'
      },
      runtimeHeaders()
    )
    expect(wrongOwner.status).toBe(404)
  })

  it('discovers and persists an exact acknowledged extension provider binding', async () => {
    const fixture = await createFixture()
    const router = buildExtensionPublicRouter(fixture.runtime)

    const unauthorized = await dispatchJson(router, 'GET', '/v1/extensions/model-providers')
    expect(unauthorized.status).toBe(401)

    const catalog = await dispatchJson(
      router,
      'GET',
      '/v1/extensions/model-providers?workspace_root=%2Fworkspace',
      undefined,
      runtimeHeaders()
    )
    expect(catalog).toMatchObject({
      status: 200,
      body: {
        providers: [{
          extensionId: 'acme.dashboard',
          extensionVersion: '1.0.0',
          localProviderId: 'provider',
          providerId: fixture.canonicalProviderId,
          selectable: true,
          accounts: [{ id: 'account-1' }],
          binding: null,
          dataAccess: {
            categories: [
              'conversation-history',
              'system-and-mode-instructions',
              'attachments',
              'tool-schemas'
            ],
            requiresAcknowledgement: true
          }
        }]
      }
    })
    expect(JSON.stringify(catalog.body)).not.toContain('credentialRef')

    const missingAcknowledgement = await dispatchJson(
      router,
      'PUT',
      '/v1/extensions/model-providers/binding',
      {
        extensionId: 'acme.dashboard',
        extensionVersion: '1.0.0',
        providerId: 'provider',
        accountId: 'account-1',
        modelId: 'custom-model',
        workspaceRoot: '/workspace',
        acknowledgedDataAccess: false
      },
      runtimeHeaders()
    )
    expect(missingAcknowledgement.status).toBe(400)

    const staleVersion = await dispatchJson(
      router,
      'PUT',
      '/v1/extensions/model-providers/binding',
      {
        extensionId: 'acme.dashboard',
        extensionVersion: '0.9.0',
        providerId: 'provider',
        accountId: 'account-1',
        modelId: 'custom-model',
        workspaceRoot: '/workspace',
        acknowledgedDataAccess: true
      },
      runtimeHeaders()
    )
    expect(staleVersion.status).toBe(409)

    const saved = await dispatchJson(
      router,
      'PUT',
      '/v1/extensions/model-providers/binding',
      {
        extensionId: 'acme.dashboard',
        extensionVersion: '1.0.0',
        providerId: 'provider',
        accountId: 'account-1',
        modelId: 'custom-model',
        workspaceRoot: '/workspace',
        acknowledgedDataAccess: true
      },
      runtimeHeaders()
    )
    expect(saved).toMatchObject({
      status: 200,
      body: { binding: {
        providerId: fixture.canonicalProviderId,
        accountId: 'account-1',
        modelId: 'custom-model',
        ownerExtensionVersion: '1.0.0'
      } }
    })
    expect(fixture.providerAccounts.setBinding).toHaveBeenCalledWith(expect.objectContaining({
      ownerExtensionId: 'acme.dashboard',
      ownerExtensionVersion: '1.0.0',
      binding: {
        providerId: fixture.canonicalProviderId,
        accountId: 'account-1',
        modelId: 'custom-model'
      }
    }))
  })
})
