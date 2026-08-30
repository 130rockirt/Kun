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
  it('keeps extension secrets protected, permission-gated, isolated, and unavailable to Views', async () => {
      const values = new Map<string, { clientSecret: string }>()
      const credentials = {
        protection: async () => ({ mode: 'encrypted-fallback' }),
        get: vi.fn(async (reference: string) => values.get(reference) ?? null),
        set: vi.fn(async (reference: string, value: { clientSecret: string }) => {
          values.set(reference, value)
        }),
        delete: vi.fn(async (reference: string) => {
          values.delete(reference)
        })
      }
      const broker = createBroker({ credentials })
      const secretPrincipal = {
        ...principal,
        grantedPermissions: [...principal.grantedPermissions, 'storage.secrets']
      }
      const secretRequest = (method: string, params: unknown, extensionId = secretPrincipal.extensionId) => ({
        principal: { ...secretPrincipal, extensionId },
        method,
        params: JSON.parse(JSON.stringify(params ?? null)),
        signal: new AbortController().signal,
        requestId: `request_${method}`
      })

      await expect(broker.handle(secretRequest('secrets.set', {
        key: 'relay-device-key',
        value: 'target-secret'
      }))).resolves.toBeNull()
      await expect(broker.handle(secretRequest('secrets.get', {
        key: 'relay-device-key'
      }))).resolves.toEqual({ found: true, value: 'target-secret' })
      await expect(broker.handle(secretRequest('secrets.get', {
        key: 'relay-device-key'
      }, 'other.extension'))).resolves.toEqual({ found: false })
      await expect(broker.handlePrincipal({
        principal: {
          extensionId: secretPrincipal.extensionId,
          extensionVersion: secretPrincipal.version,
          permissions: [...secretPrincipal.grantedPermissions],
          workspaceRoots: [],
          workspaceTrusted: false
        },
        method: 'secrets.get',
        params: { key: 'relay-device-key' },
        signal: new AbortController().signal,
        requestId: 'view-secret'
      })).rejects.toThrow(/Node Extension Host/i)
      await expect(broker.handle(secretRequest('secrets.delete', {
        key: 'relay-device-key'
      }))).resolves.toEqual({ deleted: true })
      expect(values.size).toBe(0)
    })

  it('keeps main-composer context attachment behind the authenticated desktop View boundary', async () => {
      const broker = createBroker()
      await expect(broker.handle(request('ui.attachComposerContext', {
        schemaVersion: 1,
        id: 'selection',
        title: 'Selection',
        summary: 'One selected item',
        reference: { itemIds: ['item-1'] },
        revision: 1,
        generation: 1
      }))).rejects.toThrow(/authenticated desktop Extension View/i)
    })

  it('routes declared configuration through the host-owned service and reserves internal state keys', async () => {
      const configuration = {
        get: vi.fn(async () => 'safe'),
        update: vi.fn(async () => ({ schemaVersion: 1, revision: 1, values: {} })),
        keys: vi.fn(async () => ['mode'])
      }
      const broker = createBroker({ configuration })
      await expect(broker.handle(request('configuration.get', {
        sectionId: 'general',
        key: 'mode'
      }))).resolves.toEqual({ found: true, value: 'safe' })
      await expect(broker.handle(request('configuration.update', {
        sectionId: 'general',
        key: 'mode',
        value: 'fast'
      }))).resolves.toBeNull()
      await expect(broker.handle(request('configuration.keys', {
        sectionId: 'general'
      }))).resolves.toEqual(['mode'])
      await expect(broker.handle(request('storage.get', {
        scope: 'global',
        key: '__kun_configuration_document_v1'
      }))).rejects.toThrow(/Reserved/)
      await expect(broker.handle(request('storage.set', {
        scope: 'global',
        key: 'visible',
        value: true
      }))).resolves.toBeNull()
      await expect(broker.handle(request('storage.keys', {
        scope: 'global'
      }))).resolves.toEqual(['visible'])
    })

  it('validates generatedArtifacts against the connection-bound owner and invocation workspace', async () => {
      let toolHandler: ExtensionToolHandler | undefined
      const artifact = {
        schemaVersion: 1 as const,
        artifactId: 'artifact_1234567890',
        ownerExtensionId: 'acme.broker',
        ownerExtensionVersion: '1.0.0',
        workspaceId: WORKSPACE_ID,
        mediaHandleId: 'media_123456789012',
        displayName: 'final.mp4',
        mediaKind: 'video' as const,
        mimeType: 'video/mp4',
        byteSize: 100,
        completionIdentity: 'identity_1234567890',
        availability: 'available' as const,
        provenance: { invocationId: 'invocation_1', operation: 'video-render' }
      }
      const validateToolResult = vi.fn(async () => [artifact])
      const broker = createBroker({
        artifacts: { validateToolResult } as never,
        invokeExtension: vi.fn(async () => ({
          content: { summary: 'done' },
          generatedArtifacts: [artifact]
        })),
        tools: {
          register: vi.fn(async (_principal, _declaration, handler) => {
            toolHandler = handler
            return {
              canonicalToolId: 'extension:acme.broker/summarize',
              modelAlias: 'ext_summary',
              dispose() {}
            }
          })
        }
      })
      await broker.handle(request('tools.register', manifest.contributes.tools[0]))
      const result = await toolHandler!({
        invocationId: 'invocation_1',
        canonicalToolId: 'extension:acme.broker/summarize',
        modelAlias: 'ext_summary',
        arguments: { text: 'hello' },
        threadId: 'thread_1',
        turnId: 'turn_1',
        workspace: WORKSPACE_ROOT,
        signal: new AbortController().signal,
        reportProgress: vi.fn(async () => undefined)
      })
      expect(validateToolResult).toHaveBeenCalledWith(
        expect.objectContaining({
          extensionId: 'acme.broker',
          extensionVersion: '1.0.0',
          workspaceRoots: [WORKSPACE_ROOT]
        }),
        WORKSPACE_ID,
        [artifact]
      )
      expect(result.output).toMatchObject({ generatedArtifacts: [artifact] })
      expect(JSON.stringify(result.output)).not.toContain(WORKSPACE_ROOT)
    })
})
