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
  it('routes owned job observation, replay subscriptions, and cancellation', async () => {
      const snapshot = {
        schemaVersion: 1 as const,
        id: 'job_12345678',
        kind: 'media.ffmpeg',
        kindSchemaVersion: 1,
        ownerExtensionId: 'acme.broker',
        ownerExtensionVersion: '1.0.0',
        workspaceId: WORKSPACE_ID,
        initiatingOperation: 'media.startFfmpegJob',
        state: 'completed' as const,
        executionAttempt: 1,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:01.000Z',
        terminalAt: '2026-01-01T00:00:01.000Z',
        latestCursor: 'cursor_12345678',
        result: { schemaVersion: 1 as const, generatedArtifacts: [] }
      }
      const jobs = {
        getOwned: vi.fn(async () => snapshot),
        listOwned: vi.fn(async () => ({ items: [snapshot], page: { hasMore: false } })),
        cancel: vi.fn(async () => ({ accepted: false, snapshot })),
        subscribe: vi.fn(async () => ({
          subscriptionId: 'jobsub_12345678',
          snapshot,
          replay: [],
          cursor: snapshot.latestCursor,
          gap: false,
          complete: true,
          close: vi.fn(),
          async *[Symbol.asyncIterator]() {}
        })),
        unsubscribe: vi.fn(() => true)
      }
      const broker = createBroker({ jobs })
      const principal = {
        extensionId: 'acme.broker',
        extensionVersion: '1.0.0',
        permissions: ['jobs.manage'],
        workspaceRoots: [WORKSPACE_ROOT],
        workspaceTrusted: true
      }
      const call = (method: string, params: unknown) => broker.handlePrincipal({
        principal,
        method,
        params: params as never,
        signal: new AbortController().signal,
        requestId: `request-${method}`
      })
      await expect(call('jobs.get', { jobId: snapshot.id })).resolves.toEqual(snapshot)
      await expect(call('jobs.list', {})).resolves.toMatchObject({ items: [snapshot] })
      await expect(call('jobs.subscribe', { jobId: snapshot.id })).resolves.toMatchObject({
        subscriptionId: 'jobsub_12345678', complete: true, gap: false
      })
      await expect(call('jobs.cancel', { jobId: snapshot.id })).resolves.toEqual({
        accepted: false, snapshot
      })
      const caller = { extensionId: 'acme.broker', workspaceIds: [WORKSPACE_ID] }
      expect(jobs.getOwned).toHaveBeenCalledWith(caller, snapshot.id)
      expect(jobs.listOwned).toHaveBeenCalledWith(caller, expect.any(Object))
      expect(jobs.subscribe).toHaveBeenCalledWith(caller, snapshot.id, undefined)
      expect(jobs.cancel).toHaveBeenCalledWith(caller, snapshot.id, undefined)
      expect(JSON.stringify(snapshot)).not.toContain(WORKSPACE_ROOT)
      await expect(broker.handlePrincipal({
        principal: { ...principal, permissions: [] },
        method: 'jobs.get',
        params: { jobId: snapshot.id },
        signal: new AbortController().signal,
        requestId: 'denied'
      })).rejects.toThrow(/jobs\.manage/)
    })

  it('routes commands and tools using only the connection-bound identity', async () => {
      let toolHandler: ExtensionToolHandler | undefined
      let broker!: ExtensionHostBroker
      const progress = vi.fn(async () => undefined)
      const invokeExtension = vi.fn(async (
        extensionId: string,
        _event: string,
        method: string,
        params: unknown
      ) => {
        expect(extensionId).toBe('acme.broker')
        if (method.startsWith('tools.invoke:')) {
          const invocationId = (params as { invocationId: string }).invocationId
          await broker.notification(principal, 'tools.progress', {
            invocationId,
            message: 'halfway',
            fraction: 0.5
          })
          return { content: { summary: 'done' } }
        }
        return { invoked: true }
      })
      broker = createBroker({
        invokeExtension,
        tools: {
          register: vi.fn(async (_principal, _declaration, handler) => {
            toolHandler = handler
            return { canonicalToolId: 'extension:acme.broker/summarize', modelAlias: 'ext_summary', dispose() {} }
          })
        }
      })

      const command = await broker.handle(request('commands.register', { id: 'hello' })) as { registrationId: string }
      await expect(broker.handle(request('commands.execute', {
        id: 'hello',
        args: { extensionId: 'forged.owner' }
      }))).resolves.toEqual({ invoked: true })
      expect(invokeExtension).toHaveBeenCalledWith(
        'acme.broker',
        'onCommand:hello',
        `commands.invoke:${command.registrationId}`,
        { extensionId: 'forged.owner' },
        expect.any(Object)
      )

      await broker.handle(request('tools.register', manifest.contributes.tools[0]))
      const result = await toolHandler!({
        invocationId: 'invocation_1',
        canonicalToolId: 'extension:acme.broker/summarize',
        modelAlias: 'ext_summary',
        arguments: { text: 'hello' },
        threadId: 'thread_1',
        turnId: 'turn_1',
        workspace: '/tmp/workspace',
        signal: new AbortController().signal,
        reportProgress: progress
      })
      expect(result).toEqual({
        output: { content: { summary: 'done' } },
        declaredOutput: { summary: 'done' },
        isError: false
      })
      expect(progress).toHaveBeenCalledWith({
        output: { type: 'extension_tool_progress', message: 'halfway', fraction: 0.5 }
      })
    })

  it('enforces manifest command schemas and rejects runtime declaration drift', async () => {
      const invokeExtension = vi.fn(async (_extensionId, _event, method) => {
        if (method.startsWith('commands.invoke:')) return { invoked: 'not-a-boolean' }
        return null
      })
      const tools = { register: vi.fn() }
      const modelProviders = { register: vi.fn() }
      const providerAccounts = {
        registerProvider: vi.fn(),
        unregisterProvider: vi.fn()
      }
      const broker = createBroker({ invokeExtension, tools, modelProviders, providerAccounts })

      await broker.handle(request('commands.register', { id: 'hello' }))
      await expect(broker.handle(request('commands.execute', {
        id: 'hello', args: 'invalid-command-input'
      }))).rejects.toThrow(/declared JSON Schema/)
      await expect(broker.handle(request('commands.execute', {
        id: 'hello', args: { valid: true }
      }))).rejects.toThrow(/command hello result does not match/)

      await expect(broker.handle(request('tools.register', {
        ...manifest.contributes.tools[0],
        sideEffects: 'none'
      }))).rejects.toThrow(/does not match its active manifest/)
      expect(tools.register).not.toHaveBeenCalled()

      await expect(broker.handle(request('modelProviders.register', {
        ...manifest.contributes.modelProviders[0],
        credentialHosts: []
      }))).rejects.toThrow(/does not match its active manifest/)
      expect(providerAccounts.registerProvider).not.toHaveBeenCalled()
      expect(modelProviders.register).not.toHaveBeenCalled()
    })

  it('disposes command-only extensions during broker shutdown', async () => {
      const broker = createBroker({
        invokeExtension: vi.fn(async () => ({ invoked: true }))
      })
      await broker.handle(request('commands.register', { id: 'hello' }))
      await expect(broker.handle(request('commands.execute', {
        id: 'hello', args: { valid: true }
      }))).resolves.toEqual({ invoked: true })

      await broker.dispose()

      await expect(broker.handle(request('commands.execute', {
        id: 'hello', args: { valid: true }
      }))).rejects.toThrow('command is not registered')
    })

  it('routes workspace commands to their owning Host and disposes one Host generation only', async () => {
      const workspaceA = resolve('/tmp/workspace-a')
      const workspaceB = resolve('/tmp/workspace-b')
      const principalA: HostPrincipal = {
        ...principal,
        lifecycleNonce: 'host-workspace-a',
        workspaceRoots: [workspaceA]
      }
      const principalB: HostPrincipal = {
        ...principal,
        lifecycleNonce: 'host-workspace-b',
        workspaceRoots: [workspaceB]
      }
      const disposeToolA = vi.fn()
      const disposeToolB = vi.fn()
      const invokeExtension = vi.fn(async (
        _extensionId: string,
        _event: string,
        _method: string,
        _params: unknown,
        options: { workspaceRoots?: string[] }
      ) => ({ invoked: options.workspaceRoots?.[0] === workspaceA }))
      const registerTool = vi.fn()
        .mockResolvedValueOnce({
          canonicalToolId: 'extension:acme.broker/summarize',
          modelAlias: 'ext_summary',
          dispose: disposeToolA
        })
        .mockResolvedValueOnce({
          canonicalToolId: 'extension:acme.broker/summarize',
          modelAlias: 'ext_summary',
          dispose: disposeToolB
        })
      const broker = createBroker({
        invokeExtension,
        tools: { register: registerTool }
      })
      const hostRequest = (owner: HostPrincipal, method: string, params: unknown) => broker.handle({
        principal: owner,
        method,
        params: JSON.parse(JSON.stringify(params)),
        signal: new AbortController().signal,
        requestId: `${owner.lifecycleNonce}-${method}`
      })
      await hostRequest(principalA, 'commands.register', { id: 'hello' })
      await hostRequest(principalB, 'commands.register', { id: 'hello' })
      await hostRequest(principalA, 'tools.register', manifest.contributes.tools[0])
      await hostRequest(principalB, 'tools.register', manifest.contributes.tools[0])

      const executeFromView = (workspace: string, sessionId: string) => broker.handlePrincipal({
        principal: {
          extensionId: principal.extensionId,
          extensionVersion: principal.version,
          permissions: principal.grantedPermissions,
          workspaceRoots: [workspace],
          workspaceTrusted: true,
          viewSessionId: sessionId
        },
        method: 'commands.execute',
        params: { id: 'hello', args: { valid: true } },
        signal: new AbortController().signal,
        requestId: `execute-${sessionId}`
      })

      await expect(executeFromView(workspaceA, 'view-a')).resolves.toEqual({ invoked: true })
      await expect(executeFromView(workspaceB, 'view-b')).resolves.toEqual({ invoked: false })
      expect(invokeExtension.mock.calls.at(-2)?.[4]).toMatchObject({ workspaceRoots: [workspaceA] })
      expect(invokeExtension.mock.calls.at(-1)?.[4]).toMatchObject({ workspaceRoots: [workspaceB] })

      await broker.disposeHost(principalA)

      expect(disposeToolA).toHaveBeenCalledTimes(1)
      expect(disposeToolB).not.toHaveBeenCalled()
      await expect(executeFromView(workspaceA, 'view-a-after-exit'))
        .rejects.toThrow('command is not registered')
      await expect(executeFromView(workspaceB, 'view-b-after-exit'))
        .resolves.toEqual({ invoked: false })
    })

  it('disposes broker registrations only in the revoked extension workspace', async () => {
      const workspaceA = resolve('/tmp/workspace-a')
      const workspaceB = resolve('/tmp/workspace-b')
      const invokeExtension = vi.fn(async (
        _extensionId: string,
        _event: string,
        _method: string,
        _params: unknown,
        options: { workspaceRoots?: string[] }
      ) => ({ invoked: options.workspaceRoots?.[0] === workspaceA }))
      const broker = createBroker({ invokeExtension })
      const register = (workspaceRoot: string, lifecycleNonce: string) => broker.handle({
        principal: { ...principal, lifecycleNonce, workspaceRoots: [workspaceRoot] },
        method: 'commands.register',
        params: { id: 'hello' },
        signal: new AbortController().signal,
        requestId: `register-${lifecycleNonce}`
      })
      await register(workspaceA, 'host-workspace-a')
      await register(workspaceB, 'host-workspace-b')
      const execute = (workspaceRoot: string) => broker.handlePrincipal({
        principal: {
          extensionId: principal.extensionId,
          extensionVersion: principal.version,
          permissions: principal.grantedPermissions,
          workspaceRoots: [workspaceRoot],
          workspaceTrusted: true,
          viewSessionId: `view-${workspaceRoot}`
        },
        method: 'commands.execute',
        params: { id: 'hello', args: { valid: true } },
        signal: new AbortController().signal,
        requestId: `execute-${workspaceRoot}`
      })

      await broker.disposeExtensionWorkspace(
        principal.extensionId,
        extensionWorkspaceKey(workspaceA)
      )

      await expect(execute(workspaceA)).rejects.toThrow('command is not registered')
      await expect(execute(workspaceB)).resolves.toEqual({ invoked: false })
    })
})
