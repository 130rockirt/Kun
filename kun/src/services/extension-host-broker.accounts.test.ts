import { describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  ExtensionManifestSchema,
  MediaCreateCacheTargetResultSchema,
  type MediaAnalyzeVisualFramesRequest,
  type MediaEmbedVisualQueryRequest,
  type ModelProviderAdapter
} from '@kun/extension-api'
import type { ExtensionToolHandler } from '../adapters/tool/extension-tool-provider.js'
import type { ExtensionBrokerRequest, ExtensionPrincipal as HostPrincipal } from '../extensions/host-process.js'
import { extensionWorkspaceKey } from '../extensions/paths.js'
import {
  ExtensionHostBroker,
  requiredExtensionBrokerPermission
} from './extension-host-broker.js'
import { ExtensionMediaHandleService } from './extension-media-handle-service.js'

const WORKSPACE_ROOT = resolve('/tmp/workspace')

const WORKSPACE_ID = extensionWorkspaceKey(WORKSPACE_ROOT)

const manifest = ExtensionManifestSchema.parse({
  manifestVersion: 1,
  apiVersion: '1.0.0',
  name: 'broker',
  publisher: 'acme',
  version: '1.0.0',
  engines: { kun: '>=0.1.0' },
  main: 'dist/extension.js',
  activationEvents: [
    'onCommand:hello',
    'onTool:summarize',
    'onProvider:echo',
    'onAuthentication:echo-auth'
  ],
  contributes: {
    commands: [{
      id: 'hello',
      title: 'Hello',
      inputSchema: { type: 'object' },
      outputSchema: {
        type: 'object',
        properties: { invoked: { type: 'boolean' } },
        required: ['invoked'],
        additionalProperties: false
      }
    }],
    tools: [{
      id: 'summarize',
      description: 'Summarize input',
      inputSchema: { type: 'object' },
      outputSchema: {
        type: 'object',
        properties: { summary: { type: 'string' } },
        required: ['summary'],
        additionalProperties: false
      },
      sideEffects: 'external'
    }],
    modelProviders: [{
      id: 'echo',
      displayName: 'Echo',
      authenticationProviderId: 'echo-auth',
      credentialHosts: ['api.example.test'],
      models: [{
        id: 'echo-1',
        displayName: 'Echo 1',
        capabilities: { input: ['text'], output: ['text'] }
      }]
    }],
    authentication: [{
      id: 'echo-auth',
      displayName: 'Echo API key',
      type: 'api-key'
    }],
    settings: [{
      id: 'general',
      title: 'General',
      properties: { mode: { type: 'string', default: 'safe' } }
    }]
  },
  permissions: [
    'commands.register',
    'tools.register',
    'providers.register',
    'ui.actions',
    'network:api.example.test'
  ],
  stateSchemaVersion: 1
})

const principal: HostPrincipal = {
  extensionId: 'acme.broker',
  version: '1.0.0',
  apiVersion: '1.0.0',
  lifecycleNonce: 'de7c65b3-f455-4199-aa83-1722fdf8309d',
  grantedPermissions: manifest.permissions,
  workspaceRoots: [WORKSPACE_ROOT],
  development: true
}

function request(method: string, params: unknown): ExtensionBrokerRequest {
  return {
    principal,
    method,
    params: JSON.parse(JSON.stringify(params ?? null)),
    signal: new AbortController().signal,
    requestId: `request_${method}`
  }
}

function createBroker(overrides: Record<string, unknown> = {}): ExtensionHostBroker {
  const state = new Map<string, unknown>()
  return new ExtensionHostBroker({
    agent: {} as never,
    profiles: { register: () => () => undefined } as never,
    tools: { register: vi.fn() } as never,
    modelProviders: { register: vi.fn() } as never,
    providerAccounts: {
      registerProvider: vi.fn(),
      unregisterProvider: vi.fn(),
      getAccount: vi.fn(),
      requireOwnedProvider: vi.fn(),
      validateBinding: vi.fn()
    } as never,
    accounts: {} as never,
    credentials: { protection: async () => ({ mode: 'encrypted-fallback' }) } as never,
    state: {
      read: async () => ({
        global: Object.fromEntries(state),
        workspaces: {}
      }),
      getGlobal: async (_id: string, key: string) => state.get(key),
      setGlobal: async (_id: string, key: string, value: unknown) => {
        if (value === undefined) state.delete(key)
        else state.set(key, value)
      }
    } as never,
    invokeExtension: vi.fn(async () => null),
    notifyExtension: vi.fn(async () => undefined),
    resolveManifest: async () => manifest,
    ...overrides
  } as never)
}

function cancellationContext() {
  return {
    cancellation: {
      isCancellationRequested: false,
      onCancellationRequested: () => ({ dispose() {} })
    }
  }
}

describe('ExtensionHostBroker', () => {
  it('completes PKCE only through the protected callback path and redacts session internals', async () => {
      const now = '2026-07-11T10:00:00.000Z'
      const completePkceAuthorization = vi.fn(async () => ({
        id: 'account_pkce',
        providerId: 'echo',
        ownerExtensionId: 'acme.broker',
        label: 'Echo account',
        authType: 'oauth-pkce' as const,
        status: 'connected' as const,
        metadata: {},
        createdAt: now,
        updatedAt: now
      }))
      const broker = createBroker({
        providerAccounts: {
          requireOwnedProvider: vi.fn(async () => ({
            id: 'echo', displayName: 'Echo', oauthPkce: {}
          }))
        },
        accounts: {
          beginPkceAuthorization: vi.fn(async () => ({
            transactionId: 'pkce_transaction',
            authorizationUrl: 'https://auth.example/authorize',
            expiresAt: '2099-07-11T10:10:00.000Z'
          })),
          completePkceAuthorization
        }
      })
      const accountPrincipal = {
        extensionId: 'acme.broker',
        extensionVersion: '1.0.0',
        permissions: ['accounts.manage:echo'],
        workspaceRoots: [],
        workspaceTrusted: false
      }
      const session = await broker.handlePrincipal({
        principal: accountPrincipal,
        method: 'authentication.createSession',
        params: {
          providerId: 'echo', authenticationProviderId: 'echo-auth', label: 'Echo account'
        },
        signal: new AbortController().signal,
        requestId: 'create-pkce-session'
      }) as { id: string; transactionId?: string; providerId?: string }
      expect(session).toMatchObject({
        status: 'pending',
        message: expect.stringMatching(/Settings > Extensions/)
      })
      expect(session).not.toHaveProperty('verificationUrl')
      expect(session).not.toHaveProperty('transactionId')
      expect(session).not.toHaveProperty('providerId')

      await expect(broker.handleTrustedManagement({
        principal: accountPrincipal,
        method: 'authentication.getSession',
        params: { sessionId: session.id },
        signal: new AbortController().signal,
        requestId: 'protected-get-pkce-session'
      })).resolves.toMatchObject({
        status: 'pending',
        verificationUrl: 'https://auth.example/authorize'
      })

      const completed = await broker.completePkceAccountSession({
        principal: accountPrincipal,
        sessionId: session.id,
        callbackUrl: 'https://callback.example/?code=authorization-code&state=expected-state'
      })
      expect(completed).toMatchObject({
        status: 'completed',
        account: { id: 'account_pkce', protection: 'encrypted-fallback' }
      })
      expect(completePkceAuthorization).toHaveBeenCalledWith(expect.objectContaining({
        transactionId: 'pkce_transaction',
        code: 'authorization-code',
        state: 'expected-state',
        protectedCallback: true
      }))
    })

  it('rejects raw-secret requests outside Node and before prompting without permission', async () => {
      const authorizeSecretReveal = vi.fn(async () => true)
      const revealSecret = vi.fn(async () => ({ apiKey: 'must-not-be-returned' }))
      const broker = createBroker({
        providerAccounts: {
          getAccount: vi.fn(async () => ({
            id: 'account_secret',
            providerId: 'echo',
            ownerExtensionId: 'acme.broker'
          }))
        },
        accounts: { revealSecret },
        authorizeSecretReveal
      })
      const viewPrincipal = {
        extensionId: 'acme.broker',
        extensionVersion: '1.0.0',
        permissions: ['accounts.secrets.read:echo'],
        workspaceRoots: ['/tmp/workspace'],
        workspaceTrusted: true,
        viewSessionId: 'view_secret',
        viewContributionId: 'secret'
      }

      await expect(broker.handlePrincipal({
        principal: viewPrincipal,
        method: 'authentication.revealSecret',
        params: { accountId: 'account_secret', operation: 'sign-request' },
        signal: new AbortController().signal,
        requestId: 'view-secret-request'
      })).rejects.toThrow(/Node Extension Host/)
      await expect(broker.handle(request('authentication.revealSecret', {
        accountId: 'account_secret', operation: 'sign-request'
      }))).rejects.toThrow(/Missing permission/)
      expect(authorizeSecretReveal).not.toHaveBeenCalled()
      expect(revealSecret).not.toHaveBeenCalled()
    })

  it('polls device authorization in the broker and projects completion through session polling', async () => {
      const now = '2026-07-11T10:00:00.000Z'
      let completeDevice!: (account: unknown) => void
      const completion = new Promise((resolve) => { completeDevice = resolve })
      const broker = createBroker({
        providerAccounts: {
          requireOwnedProvider: vi.fn(async () => ({
            id: 'echo', displayName: 'Echo', oauthDevice: {}
          }))
        },
        accounts: {
          beginDeviceAuthorization: vi.fn(async () => ({
            transactionId: 'device_transaction',
            verificationUri: 'https://auth.example/device',
            userCode: 'ABCD-EFGH',
            expiresAt: '2099-07-11T10:10:00.000Z'
          })),
          completeDeviceAuthorization: vi.fn(() => completion)
        }
      })
      const accountPrincipal = {
        extensionId: 'acme.broker',
        extensionVersion: '1.0.0',
        permissions: ['accounts.manage:echo'],
        workspaceRoots: [],
        workspaceTrusted: false
      }
      const session = await broker.handleTrustedManagement({
        principal: accountPrincipal,
        method: 'authentication.createSession',
        params: { providerId: 'echo', authenticationProviderId: 'echo-auth' },
        signal: new AbortController().signal,
        requestId: 'create-device-session'
      }) as { id: string }
      expect(session).toMatchObject({
        status: 'pending',
        verificationUrl: 'https://auth.example/device',
        userCode: 'ABCD-EFGH'
      })

      completeDevice({
        id: 'account_device',
        providerId: 'echo',
        ownerExtensionId: 'acme.broker',
        label: 'Echo',
        authType: 'oauth-device',
        status: 'connected',
        metadata: {},
        createdAt: now,
        updatedAt: now
      })
      await vi.waitFor(async () => {
        await expect(broker.handlePrincipal({
          principal: accountPrincipal,
          method: 'authentication.getSession',
          params: { sessionId: session.id },
          signal: new AbortController().signal,
          requestId: 'poll-device-session'
        })).resolves.toMatchObject({ status: 'completed', account: { id: 'account_device' } })
      })
    })
})
