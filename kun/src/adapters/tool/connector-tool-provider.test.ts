import { createHmac } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { InMemoryArtifactStore } from '../../artifacts/artifact-store.js'
import { ConnectorsCapabilityConfig } from '../../contracts/capabilities.js'
import type { ToolHostContext } from '../../ports/tool-host.js'
import { CapabilityRegistry } from './capability-registry.js'
import {
  CONNECTOR_INSTANCE_PROOF_KEY_ENV,
  CONNECTOR_RUNTIME_TOKEN_ENV,
  ConnectorHttpClient,
  ConnectorOutcomeUnknownError
} from './connector-client.js'
import { buildConnectorToolProviders } from './connector-tool-provider.js'
import { LocalToolHost } from './local-tool-host.js'

const config = ConnectorsCapabilityConfig.parse({
  enabled: true,
  baseUrl: 'http://127.0.0.1:18898',
  timeoutMs: 1_000,
  maxResultBytes: 2 * 1024 * 1024,
  maxSearchResults: 5,
  maxFileBytes: 1024 * 1024
})

function healthResponse(): Response {
  return success({
    ok: true,
    runtime: 'open-connector',
    runtimeVersion: '0.2.0',
    protocolVersion: '1'
  })
}

function success(data: unknown, status = 200): Response {
  return Response.json({ success: true, message: 'OK', data, meta: {} }, { status })
}

function failure(errorCode: string, message: string, status = 400): Response {
  return Response.json({ success: false, message, data: null, errorCode, meta: {} }, { status })
}

function action(sideEffect: 'read' | 'write' | 'send' | 'delete' | 'unknown' | undefined) {
  return {
    id: 'mail.send',
    service: 'mail',
    name: 'send',
    description: 'Send or inspect mail.',
    ...(sideEffect ? { sideEffect } : {}),
    requiredScopes: ['mail'],
    providerPermissions: ['mail'],
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
    followUpActions: [],
    asyncLifecycle: null,
    execution: {
      locallyExecutable: true,
      catalogOnly: false,
      requiredAuthTypes: ['oauth2'],
      noAuthRunnable: false,
      needsCredential: true
    }
  }
}

function context(input: Partial<ToolHostContext> = {}): ToolHostContext {
  return {
    threadId: 'thread_connector',
    turnId: 'turn_connector',
    workspace: '/workspace',
    approvalPolicy: 'auto',
    sandboxMode: 'workspace-write',
    abortSignal: new AbortController().signal,
    awaitApproval: vi.fn(async () => 'allow' as const),
    ...input
  }
}

function createFetchRouter(
  route: (url: URL, init: RequestInit) => Response | Promise<Response>
): typeof fetch {
  return vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
    if (url.pathname === '/v1/health') return healthResponse()
    return route(url, init ?? {})
  }) as unknown as typeof fetch
}

describe('OpenConnector tool provider', () => {
  it('filters and bounds app discovery instead of flooding the model with the full catalog', async () => {
    const fetcher = createFetchRouter((url) => {
      if (url.pathname === '/v1/providers') {
        return success(Array.from({ length: 7 }, (_, index) => ({
          service: `mail_${index}`,
          displayName: `Mail ${index}`,
          iconUrl: null,
          homepageUrl: null,
          categories: [{ id: 'Communication', displayName: 'Communication' }],
          authTypes: ['oauth2']
        })))
      }
      return failure('not_found', 'missing', 404)
    })
    const built = await buildConnectorToolProviders(config, {
      runtimeToken: 'runtime-secret',
      fetcher,
      healthPollIntervalMs: 60_000
    })
    try {
      const tool = built.providers[0]!.tools.find((candidate) => candidate.name === 'connector_list_apps')!
      const result = await tool.execute({ query: 'communication', limit: 2 }, context())
      expect(result.output).toMatchObject({ returned: 2, total_matches: 7 })
      expect((result.output as { apps: unknown[] }).apps).toHaveLength(2)
      const request = vi.mocked(fetcher).mock.calls.find(([input]) =>
        new URL(String(input)).pathname === '/v1/providers'
      )
      expect(new URL(String(request?.[0])).searchParams.get('q')).toBe('communication')
    } finally {
      built.close()
    }
  })

  it('keeps the model catalog small and hides mutation/file tools in Plan mode', async () => {
    const fetcher = createFetchRouter((url) => {
      if (url.pathname === '/v1/actions/search') {
        return success([{
          id: 'mail.send',
          service: 'mail',
          name: 'send',
          description: 'Send mail.',
          sideEffect: 'send',
          authenticated: true,
          inputSchema: { type: 'object', properties: { body: { type: 'string' } } },
          outputSchema: { type: 'object' }
        }])
      }
      return failure('not_found', 'missing', 404)
    })
    const built = await buildConnectorToolProviders(config, {
      runtimeToken: 'runtime-secret',
      fetcher,
      healthPollIntervalMs: 60_000
    })
    try {
      const registry = new CapabilityRegistry(built.providers)
      const planTools = registry.listTools(context({ threadMode: 'plan' })).map((tool) => tool.name)
      expect(planTools).toEqual([
        'connector_list_apps',
        'connector_list_connections',
        'connector_search_actions',
        'connector_get_action',
        'connector_read_action'
      ])
      expect(planTools).not.toContain('connector_execute_action')
      expect(planTools).not.toContain('connector_upload_file')
      expect(planTools).not.toContain('connector_save_file')

      const search = built.providers[0]!.tools.find((tool) => tool.name === 'connector_search_actions')!
      const result = await search.execute({ query: 'mail', limit: 50 }, context())
      expect(result.output).toMatchObject({
        actions: [{ id: 'mail.send', sideEffect: 'send' }],
        returned: 1,
        max_results: 5
      })
      expect(JSON.stringify(result.output)).not.toContain('properties')
      const searchRequest = vi.mocked(fetcher).mock.calls.find(([input]) =>
        new URL(String(input)).pathname === '/v1/actions/search'
      )
      expect(new URL(String(searchRequest?.[0])).searchParams.get('limit')).toBe('5')
    } finally {
      built.close()
    }
  })

  it('refuses unknown and mutating Actions through connector_read_action', async () => {
    const fetcher = createFetchRouter((url, init) => {
      if (url.pathname === '/v1/actions/mail.send' && init.method === 'GET') {
        return success(action(undefined))
      }
      if (url.pathname === '/v1/actions/mail.send' && init.method === 'POST') {
        return success({ sent: true })
      }
      return failure('not_found', 'missing', 404)
    })
    const built = await buildConnectorToolProviders(config, {
      runtimeToken: 'runtime-secret',
      fetcher,
      healthPollIntervalMs: 60_000
    })
    try {
      const tool = built.providers[0]!.tools.find((candidate) => candidate.name === 'connector_read_action')!
      const result = await tool.execute({ action_id: 'mail.send', input: {} }, context())
      expect(result).toMatchObject({
        isError: true,
        output: {
          code: 'connector_action_not_read_only',
          side_effect: 'unknown'
        }
      })
      expect(vi.mocked(fetcher).mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0)
    } finally {
      built.close()
    }
  })

  it('runs explicitly read-only Actions without approval and offloads large results', async () => {
    const large = 'x'.repeat(140 * 1024)
    const fetcher = createFetchRouter((url, init) => {
      if (url.pathname === '/v1/actions/mail.send' && init.method === 'GET') {
        return success(action('read'))
      }
      if (url.pathname === '/v1/actions/mail.send' && init.method === 'POST') {
        return success({ content: large })
      }
      return failure('not_found', 'missing', 404)
    })
    const built = await buildConnectorToolProviders(config, {
      runtimeToken: 'runtime-secret',
      fetcher,
      healthPollIntervalMs: 60_000
    })
    try {
      const host = new LocalToolHost({ registry: new CapabilityRegistry(built.providers) })
      const awaitApproval = vi.fn(async (
        _approval: Parameters<ToolHostContext['awaitApproval']>[0]
      ) => 'allow' as const)
      const store = new InMemoryArtifactStore(() => '2026-07-31T00:00:00.000Z')
      const result = await host.execute({
        callId: 'call_read',
        toolName: 'connector_read_action',
        arguments: { action_id: 'mail.send' }
      }, context({ awaitApproval, artifactStore: store }))

      expect(awaitApproval).not.toHaveBeenCalled()
      expect(result.item).toMatchObject({
        kind: 'tool_result',
        output: {
          artifactId: expect.stringMatching(/^art_/),
          byteSize: expect.any(Number),
          truncated: true
        }
      })
    } finally {
      built.close()
    }
  })

  it('always reviews mutations in Full access and derives a stable idempotency key from the call id', async () => {
    const seenKeys: string[] = []
    const fetcher = createFetchRouter((url, init) => {
      if (url.pathname === '/v1/actions/mail.send' && init.method === 'GET') {
        return success(action('send'))
      }
      if (url.pathname === '/v1/actions/mail.send' && init.method === 'POST') {
        seenKeys.push(new Headers(init.headers).get('idempotency-key') ?? '')
        return success({ sent: true })
      }
      return failure('not_found', 'missing', 404)
    })
    const built = await buildConnectorToolProviders(config, {
      runtimeToken: 'runtime-secret',
      fetcher,
      healthPollIntervalMs: 60_000
    })
    try {
      const host = new LocalToolHost({ registry: new CapabilityRegistry(built.providers) })
      const awaitApproval = vi.fn(async (
        _approval: Parameters<ToolHostContext['awaitApproval']>[0]
      ) => 'allow' as const)
      const result = await host.execute({
        callId: 'call_send_1',
        toolName: 'connector_execute_action',
        arguments: { action_id: 'mail.send', input: { to: 'user@example.com' } }
      }, context({
        approvalPolicy: 'auto',
        sandboxMode: 'danger-full-access',
        awaitApproval
      }))

      expect(awaitApproval).toHaveBeenCalledOnce()
      expect(awaitApproval.mock.calls[0]?.[0]).toMatchObject({
        action: {
          kind: 'external-effect',
          providerKind: 'connector',
          targets: [{ kind: 'recipient', value: 'user@example.com' }]
        }
      })
      expect(result.item).toMatchObject({ output: { action_id: 'mail.send', side_effect: 'send' } })
      expect(seenKeys).toHaveLength(1)
      expect(seenKeys[0]).toMatch(/^kun-[a-f0-9]{64}$/)
    } finally {
      built.close()
    }
  })

  it('records ambiguous action outcomes and refuses an automatic replay', async () => {
    const fetcher = createFetchRouter((url, init) => {
      if (url.pathname === '/v1/actions/mail.send' && init.method === 'GET') {
        return success(action('send'))
      }
      if (url.pathname === '/v1/actions/mail.send' && init.method === 'POST') {
        throw new TypeError('socket reset after dispatch')
      }
      return failure('not_found', 'missing', 404)
    })
    const built = await buildConnectorToolProviders(config, {
      runtimeToken: 'runtime-secret',
      fetcher,
      healthPollIntervalMs: 60_000
    })
    try {
      const host = new LocalToolHost({ registry: new CapabilityRegistry(built.providers) })
      const call = {
        callId: 'call_ambiguous',
        toolName: 'connector_execute_action',
        arguments: { action_id: 'mail.send', input: { to: 'user@example.com' } }
      }
      const first = await host.execute(call, context({ sandboxMode: 'danger-full-access' }))
      expect(first.item).toMatchObject({
        isError: true,
        output: { error: expect.stringContaining('verify the external system') }
      })
      const second = await host.execute(call, context({ sandboxMode: 'danger-full-access' }))
      expect(second.item).toMatchObject({
        isError: true,
        output: {
          code: 'tool_outcome_unknown',
          error: expect.stringContaining('will not be retried automatically')
        }
      })
      expect(vi.mocked(fetcher).mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
    } finally {
      built.close()
    }
  })

  it('confines uploads to workspace paths even in Full access', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-connector-workspace-'))
    const outside = await mkdtemp(join(tmpdir(), 'kun-connector-outside-'))
    try {
      const outsideFile = join(outside, 'secret.txt')
      await writeFile(outsideFile, 'secret')
      const fetcher = createFetchRouter(() => success({
        fileId: 'file_1',
        downloadUrl: 'http://127.0.0.1:18898/v1/files/file_1',
        sizeBytes: 6,
        name: 'secret.txt',
        mimeType: 'text/plain'
      }))
      const built = await buildConnectorToolProviders(config, {
        runtimeToken: 'runtime-secret',
        fetcher,
        healthPollIntervalMs: 60_000
      })
      try {
        const host = new LocalToolHost({ registry: new CapabilityRegistry(built.providers) })
        const result = await host.execute({
          callId: 'call_upload',
          toolName: 'connector_upload_file',
          arguments: { path: outsideFile }
        }, context({
          workspace: root,
          sandboxMode: 'danger-full-access'
        }))
        expect(result.item).toMatchObject({
          isError: true,
          output: { error: expect.stringContaining('escapes the workspace') }
        })
        expect(vi.mocked(fetcher).mock.calls.filter(([input]) =>
          new URL(String(input)).pathname === '/v1/files'
        )).toHaveLength(0)
      } finally {
        built.close()
      }
    } finally {
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(outside, { recursive: true, force: true })
      ])
    }
  })

  it('uploads an in-workspace regular file only after explicit approval', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-connector-upload-'))
    try {
      await writeFile(join(root, 'report.txt'), 'approved upload')
      let uploadedFile: File | null = null
      const fetcher = createFetchRouter(async (url, init) => {
        if (url.pathname === '/v1/files' && init.method === 'POST') {
          const form = init.body as FormData
          const file = form.get('file')
          uploadedFile = file instanceof File ? file : null
          return success({
            fileId: 'file_approved',
            downloadUrl: 'http://127.0.0.1:18898/v1/files/file_approved',
            sizeBytes: 15,
            name: 'report.txt',
            mimeType: 'text/plain'
          })
        }
        return failure('not_found', 'missing', 404)
      })
      const built = await buildConnectorToolProviders(config, {
        runtimeToken: 'runtime-secret',
        fetcher,
        healthPollIntervalMs: 60_000
      })
      try {
        const host = new LocalToolHost({ registry: new CapabilityRegistry(built.providers) })
        const awaitApproval = vi.fn(async () => 'allow' as const)
        const result = await host.execute({
          callId: 'call_upload_approved',
          toolName: 'connector_upload_file',
          arguments: { path: 'report.txt', mime_type: 'text/plain' }
        }, context({
          workspace: root,
          sandboxMode: 'danger-full-access',
          awaitApproval
        }))

        expect(awaitApproval).toHaveBeenCalledOnce()
        expect(result.item).toMatchObject({
          isError: false,
          output: {
            source_path: 'report.txt',
            file: { fileId: 'file_approved', sizeBytes: 15 }
          }
        })
        expect(uploadedFile).toMatchObject({ name: 'report.txt', type: 'text/plain', size: 15 })
        await expect(uploadedFile!.text()).resolves.toBe('approved upload')
      } finally {
        built.close()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects an upload path redirected outside the workspace while approval is pending', async (testContext) => {
    const parent = await mkdtemp(join(tmpdir(), 'kun-connector-upload-swap-'))
    const root = join(parent, 'workspace')
    const outside = join(parent, 'outside')
    const uploadPath = join(root, 'report.txt')
    const outsideFile = join(outside, 'secret.txt')
    let symlinkError: unknown
    try {
      await Promise.all([mkdir(root), mkdir(outside)])
      await Promise.all([
        writeFile(uploadPath, 'safe'),
        writeFile(outsideFile, 'must not upload')
      ])
      const fetcher = createFetchRouter(() => success({
        fileId: 'file_unsafe',
        downloadUrl: 'http://127.0.0.1:18898/v1/files/file_unsafe',
        sizeBytes: 15,
        name: 'secret.txt',
        mimeType: 'text/plain'
      }))
      const built = await buildConnectorToolProviders(config, {
        runtimeToken: 'runtime-secret',
        fetcher,
        healthPollIntervalMs: 60_000
      })
      try {
        const host = new LocalToolHost({ registry: new CapabilityRegistry(built.providers) })
        const result = await host.execute({
          callId: 'call_upload_swap',
          toolName: 'connector_upload_file',
          arguments: { path: 'report.txt' }
        }, context({
          workspace: root,
          sandboxMode: 'danger-full-access',
          awaitApproval: async () => {
            await rm(uploadPath)
            try {
              await symlink(outsideFile, uploadPath, 'file')
            } catch (error) {
              symlinkError = error
              return 'deny'
            }
            return 'allow'
          }
        }))

        if (symlinkError) {
          testContext.skip()
          return
        }
        expect(result.item).toMatchObject({
          isError: true,
          output: { error: expect.stringContaining('escapes the workspace') }
        })
        expect(vi.mocked(fetcher).mock.calls.filter(([input]) =>
          new URL(String(input)).pathname === '/v1/files'
        )).toHaveLength(0)
      } finally {
        built.close()
      }
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  })

  it('downloads only into the workspace after file-change approval', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-connector-download-'))
    try {
      const fetcher = createFetchRouter((url) => {
        if (url.pathname === '/v1/files/file_1') {
          return new Response('downloaded', {
            headers: {
              'content-type': 'text/plain',
              'content-disposition': 'attachment; filename="report.txt"'
            }
          })
        }
        return failure('not_found', 'missing', 404)
      })
      const built = await buildConnectorToolProviders(config, {
        runtimeToken: 'runtime-secret',
        fetcher,
        healthPollIntervalMs: 60_000
      })
      try {
        const host = new LocalToolHost({ registry: new CapabilityRegistry(built.providers) })
        const awaitApproval = vi.fn(async () => 'allow' as const)
        const result = await host.execute({
          callId: 'call_save',
          toolName: 'connector_save_file',
          arguments: { file_id: 'file_1', path: 'downloads/report.txt' }
        }, context({
          workspace: root,
          sandboxMode: 'danger-full-access',
          awaitApproval
        }))
        expect(awaitApproval).toHaveBeenCalledOnce()
        expect(result.item).toMatchObject({
          output: { path: 'downloads/report.txt', bytes_written: 10 }
        })
        await expect(readFile(join(root, 'downloads/report.txt'), 'utf8')).resolves.toBe('downloaded')
      } finally {
        built.close()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects a download destination redirected outside the workspace during transit', async (testContext) => {
    const parent = await mkdtemp(join(tmpdir(), 'kun-connector-download-swap-'))
    const root = join(parent, 'workspace')
    const downloads = join(root, 'downloads')
    const displaced = join(root, 'downloads-before-swap')
    const outside = join(parent, 'outside')
    const protectedTarget = join(outside, 'report.txt')
    let symlinkError: unknown
    try {
      await Promise.all([mkdir(downloads, { recursive: true }), mkdir(outside)])
      await writeFile(protectedTarget, 'must survive')
      const fetcher = createFetchRouter(async (url) => {
        if (url.pathname === '/v1/files/file_1') {
          await rename(downloads, displaced)
          try {
            await symlink(outside, downloads, process.platform === 'win32' ? 'junction' : 'dir')
          } catch (error) {
            symlinkError = error
          }
          return new Response('downloaded', {
            headers: { 'content-type': 'text/plain' }
          })
        }
        return failure('not_found', 'missing', 404)
      })
      const built = await buildConnectorToolProviders(config, {
        runtimeToken: 'runtime-secret',
        fetcher,
        healthPollIntervalMs: 60_000
      })
      try {
        const host = new LocalToolHost({ registry: new CapabilityRegistry(built.providers) })
        const result = await host.execute({
          callId: 'call_save_swap',
          toolName: 'connector_save_file',
          arguments: { file_id: 'file_1', path: 'downloads/report.txt', overwrite: true }
        }, context({
          workspace: root,
          sandboxMode: 'danger-full-access',
          awaitApproval: vi.fn(async () => 'allow' as const)
        }))

        if (symlinkError) {
          testContext.skip()
          return
        }
        expect(result.item).toMatchObject({
          isError: true,
          output: { error: expect.stringContaining('escapes the workspace') }
        })
        await expect(readFile(protectedTarget, 'utf8')).resolves.toBe('must survive')
      } finally {
        built.close()
      }
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  })
})

describe('Connector HTTP client diagnostics', () => {
  it('proves the owned loopback instance before sending the runtime bearer token', async () => {
    const proofKey = 'ab'.repeat(32)
    const fetcher = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.pathname === '/health') {
        const challenge = url.searchParams.get('challenge') ?? ''
        return Response.json({
          ok: true,
          runtime: 'open-connector',
          runtimeVersion: '0.2.0',
          protocolVersion: '1',
          instanceProof: createHmac('sha256', Buffer.from(proofKey, 'hex')).update(challenge).digest('hex')
        })
      }
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer runtime-secret')
      return healthResponse()
    }) as unknown as typeof fetch
    const client = new ConnectorHttpClient({
      config,
      runtimeToken: 'runtime-secret',
      instanceProofKey: proofKey,
      fetcher
    })

    await expect(client.probeHealth()).resolves.toBe(true)
    const proofRequest = vi.mocked(fetcher).mock.calls[0]
    expect(new Headers(proofRequest?.[1]?.headers).has('authorization')).toBe(false)
  })

  it('does not disclose the bearer token to a process that fails instance proof', async () => {
    const fetcher = vi.fn(async () => Response.json({
      ok: true,
      runtime: 'open-connector',
      runtimeVersion: 'attacker',
      protocolVersion: '1',
      instanceProof: '00'.repeat(32)
    })) as unknown as typeof fetch
    const client = new ConnectorHttpClient({
      config,
      runtimeToken: 'runtime-secret',
      instanceProofKey: 'ab'.repeat(32),
      fetcher
    })

    await expect(client.probeHealth()).resolves.toBe(false)
    expect(vi.mocked(fetcher)).toHaveBeenCalledOnce()
    expect(new Headers(vi.mocked(fetcher).mock.calls[0]?.[1]?.headers).has('authorization')).toBe(false)
    expect(client.diagnostics().lastError).toContain('not the OpenConnector instance')
  })

  it('pins uploaded transit URLs to the configured loopback origin', async () => {
    const fetcher = createFetchRouter((url) => {
      if (url.pathname === '/v1/files') {
        return success({
          fileId: 'file_safe',
          downloadUrl: 'https://attacker.invalid/secret',
          sizeBytes: 3,
          name: 'a.txt',
          mimeType: 'text/plain'
        })
      }
      return failure('not_found', 'missing', 404)
    })
    const client = new ConnectorHttpClient({ config, runtimeToken: 'runtime-secret', fetcher })
    const uploaded = await client.uploadFile({
      content: Buffer.from('abc'),
      name: 'a.txt',
      mimeType: 'text/plain'
    })
    expect(uploaded.downloadUrl).toBe('http://127.0.0.1:18898/v1/files/file_safe')
  })

  it('marks an unavailable sidecar without throwing into runtime construction and recovers on a later probe', async () => {
    let online = false
    const fetcher = vi.fn(async () => {
      if (!online) throw new TypeError('connection refused')
      return healthResponse()
    }) as unknown as typeof fetch
    const built = await buildConnectorToolProviders(config, {
      runtimeToken: 'runtime-secret',
      fetcher,
      healthPollIntervalMs: 60_000
    })
    try {
      expect(built.diagnostics()).toMatchObject({ available: false, configured: true })
      expect(new CapabilityRegistry(built.providers).listTools(context())).toEqual([])
      online = true
      await expect(built.client.probeHealth()).resolves.toBe(true)
      expect(new CapabilityRegistry(built.providers).listTools(context())).not.toEqual([])
    } finally {
      built.close()
    }
  })

  it('keeps tools unavailable for an incompatible sidecar protocol', async () => {
    const fetcher = vi.fn(async () => success({
      ok: true,
      runtime: 'open-connector',
      runtimeVersion: '0.3.0',
      protocolVersion: '2'
    })) as unknown as typeof fetch
    const built = await buildConnectorToolProviders(config, {
      runtimeToken: 'runtime-secret',
      fetcher,
      healthPollIntervalMs: 60_000
    })
    try {
      expect(built.diagnostics()).toMatchObject({
        available: false,
        lastError: expect.stringContaining('runtime contract')
      })
      expect(new CapabilityRegistry(built.providers).listTools(context())).toEqual([])
    } finally {
      built.close()
    }
  })

  it('classifies an aborted mutating request as outcome-unknown', async () => {
    const fetcher = vi.fn((_input: URL | RequestInfo, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
      })
    ) as unknown as typeof fetch
    const client = new ConnectorHttpClient({ config, runtimeToken: 'runtime-secret', fetcher })
    const abort = new AbortController()
    const pending = client.executeAction({
      actionId: 'mail.send',
      actionInput: {},
      idempotencyKey: 'kun-test',
      outcomeMayBeUnknown: true,
      signal: abort.signal
    })
    abort.abort(new Error('cancelled'))
    await expect(pending).rejects.toBeInstanceOf(ConnectorOutcomeUnknownError)
  })

  it('requires an origin-only literal loopback base URL', () => {
    expect(() => ConnectorsCapabilityConfig.parse({
      enabled: true,
      baseUrl: 'https://example.com/open-connector'
    })).toThrow(/loopback HTTP URL/)
    expect(() => ConnectorsCapabilityConfig.parse({
      enabled: true,
      baseUrl: 'http://127.0.0.1:18898/proxy'
    })).toThrow(/loopback HTTP URL/)
  })

  it('captures connector authority once, scrubs process.env, and reuses it after a hot rebuild', async () => {
    const runtimeToken = 'runtime-authority-for-test'
    const proofKey = 'cd'.repeat(32)
    process.env[CONNECTOR_RUNTIME_TOKEN_ENV] = runtimeToken
    process.env[CONNECTOR_INSTANCE_PROOF_KEY_ENV] = proofKey
    const fetcher = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.pathname === '/health') {
        expect(new Headers(init?.headers).has('authorization')).toBe(false)
        const challenge = url.searchParams.get('challenge') ?? ''
        return Response.json({
          ok: true,
          runtime: 'open-connector',
          runtimeVersion: '0.3.0',
          protocolVersion: '1',
          instanceProof: createHmac('sha256', Buffer.from(proofKey, 'hex'))
            .update(challenge)
            .digest('hex')
        })
      }
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${runtimeToken}`)
      return healthResponse()
    }) as unknown as typeof fetch

    const first = await buildConnectorToolProviders(config, {
      fetcher,
      healthPollIntervalMs: 60_000
    })
    expect(process.env[CONNECTOR_RUNTIME_TOKEN_ENV]).toBeUndefined()
    expect(process.env[CONNECTOR_INSTANCE_PROOF_KEY_ENV]).toBeUndefined()
    expect({ ...process.env }).not.toHaveProperty(CONNECTOR_RUNTIME_TOKEN_ENV)
    expect({ ...process.env }).not.toHaveProperty(CONNECTOR_INSTANCE_PROOF_KEY_ENV)
    first.close()

    const rebuilt = await buildConnectorToolProviders(config, {
      fetcher,
      healthPollIntervalMs: 60_000
    })
    expect(rebuilt.diagnostics()).toMatchObject({ configured: true, available: true })
    rebuilt.close()
  })
})
