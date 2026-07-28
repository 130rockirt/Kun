import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildRuntimeCapabilityManifest } from '../contracts/capabilities.js'
import { ThreadSchema } from '../contracts/threads.js'
import { publishRuntimeDiscovery } from '../server/runtime-discovery.js'
import { KunTuiClient, TuiClientError, resolveTuiConnection } from './client.js'
import { testTuiGraphRun } from './graph-mode.test-support.js'
import type { TuiOptions } from './options.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function runtimeInfo(overrides: Record<string, unknown> = {}) {
  return {
    host: '127.0.0.1',
    port: 18899,
    dataDir: '/tmp/kun-data',
    model: 'model-a',
    approvalPolicy: 'on-request',
    sandboxMode: 'workspace-write',
    insecure: false,
    instanceId: 'gui-runtime',
    serviceVersion: '0.1.0',
    launchMode: 'gui',
    startedAt: '2026-07-22T00:00:00.000Z',
    pid: process.pid,
    capabilities: buildRuntimeCapabilityManifest({
      model: {
        id: 'model-a',
        inputModalities: ['text'],
        outputModalities: ['text'],
        supportsToolCalling: true,
        messageParts: ['text']
      }
    }),
    ...overrides
  }
}

function thread(overrides: Record<string, unknown> = {}) {
  return ThreadSchema.parse({
    id: 'thr_1',
    title: 'Terminal thread',
    workspace: '/tmp/project',
    model: 'model-a',
    mode: 'agent',
    status: 'idle',
    approvalPolicy: 'on-request',
    sandboxMode: 'workspace-write',
    relation: 'primary',
    createdAt: '2026-07-22T00:00:00.000Z',
    updatedAt: '2026-07-22T00:00:00.000Z',
    turns: [],
    ...overrides
  })
}

function options(overrides: Partial<TuiOptions> = {}): TuiOptions {
  return {
    runtimeToken: 'runtime-secret',
    dataDir: '/tmp/kun-data',
    workspace: '/tmp/project',
    continueLatest: false,
    noStart: false,
    help: false,
    ...overrides
  }
}

function modelSnapshot(revision = 1) {
  return {
    schemaVersion: 1 as const,
    revision,
    providers: [{
      id: 'provider-a', accountId: 'account:provider-a', name: 'Provider A',
      kind: 'http' as const, authType: 'api-key' as const,
      baseUrl: 'https://example.com/v1', endpointFormat: 'chat_completions' as const,
      configured: true, models: ['model-a'], selectedModel: 'model-a'
    }],
    defaultProviderId: 'provider-a',
    defaultAccountId: 'account:provider-a',
    defaultModel: 'model-a',
    proxy: { enabled: false, url: '' },
    routePools: [],
    localModelGateway: { enabled: false }
  }
}

describe('resolveTuiConnection', () => {
  it('uses an explicit URL and token without discovery', async () => {
    const fetchImpl = vi.fn(async () => Response.json(runtimeInfo({ instanceId: 'gui-runtime' }))) as unknown as typeof fetch

    const result = await resolveTuiConnection(options({
      url: 'http://127.0.0.1:18899',
      runtimeToken: 'explicit-secret'
    }), fetchImpl)
    expect(result).toMatchObject({ baseUrl: 'http://127.0.0.1:18899', discovered: false })
    expect(new Headers((fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]?.headers).get('authorization'))
      .toBe('Bearer explicit-secret')
  })

  it('discovers and validates a GUI-owned runtime', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-tui-client-'))
    roots.push(root)
    await publishRuntimeDiscovery(root, {
      instanceId: 'gui-runtime',
      pid: process.pid,
      startedAt: '2026-07-22T00:00:00.000Z',
      host: '127.0.0.1',
      port: 18899,
      baseUrl: 'http://127.0.0.1:18899',
      runtimeToken: 'discovered-secret',
      insecure: false
    })
    const fetchImpl = vi.fn(async () => Response.json(runtimeInfo())) as unknown as typeof fetch

    await expect(resolveTuiConnection(options({ dataDir: root, runtimeToken: '' }), fetchImpl)).resolves.toMatchObject({
      discovered: true,
      runtimeToken: 'discovered-secret'
    })
    expect(new Headers((fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]?.headers).get('authorization'))
      .toBe('Bearer discovered-secret')
  })

  it('rejects unsafe and stale discovery without exposing its token', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-tui-client-stale-'))
    roots.push(root)
    await publishRuntimeDiscovery(root, {
      instanceId: 'stale-runtime',
      pid: process.pid,
      startedAt: '2026-07-22T00:00:00.000Z',
      host: '127.0.0.1',
      port: 18899,
      baseUrl: 'http://127.0.0.1:18899',
      runtimeToken: 'must-not-leak',
      insecure: false
    })
    const fetchImpl = vi.fn(async () => Response.json(runtimeInfo({ pid: process.pid + 1 }))) as unknown as typeof fetch
    const error = await resolveTuiConnection(options({ dataDir: root, runtimeToken: '', noStart: true }), fetchImpl).catch((value) => value)
    expect(error).toBeInstanceOf(TuiClientError)
    expect(String(error)).toContain('stale')
    expect(String(error)).not.toContain('must-not-leak')
  })
})

describe('KunTuiClient', () => {
  it('sends typed thread, turn, approval, and user-input requests', async () => {
    const calls: Array<{ path: string; method: string; body?: unknown; headers: Headers }> = []
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const parsed = new URL(String(url))
      calls.push({
        path: parsed.pathname,
        method: init?.method ?? 'GET',
        ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) } : {}),
        headers: new Headers(init?.headers)
      })
      if (parsed.pathname === '/v1/threads') return Response.json(thread(), { status: 201 })
      if (parsed.pathname.endsWith('/turns')) {
        return Response.json({ threadId: 'thr_1', turnId: 'turn_1', userMessageItemId: 'item_1' }, { status: 202 })
      }
      if (parsed.pathname.startsWith('/v1/approvals/')) {
        return Response.json({ approvalId: 'appr_1', decision: 'allow', status: 'allowed' })
      }
      return Response.json({ inputId: 'input_1', status: 'submitted', answers: [] })
    }) as unknown as typeof fetch
    const client = new KunTuiClient({ baseUrl: 'http://127.0.0.1:18899', runtimeToken: 'runtime-secret', fetch: fetchImpl })

    await client.createThread({ title: 'Terminal thread', workspace: '/tmp/project', model: 'model-a', mode: 'agent' })
    await client.startTurn('thr_1', { prompt: 'hello' })
    await client.decideApproval('appr_1', 'allow')
    await client.resolveUserInput('input_1', [{ id: 'q1', label: 'answer', value: 'answer' }])

    expect(calls.map((call) => [call.method, call.path])).toEqual([
      ['POST', '/v1/threads'],
      ['POST', '/v1/threads/thr_1/turns'],
      ['POST', '/v1/approvals/appr_1'],
      ['POST', '/v1/user-inputs/input_1']
    ])
    expect(calls.every((call) => call.headers.get('authorization') === 'Bearer runtime-secret')).toBe(true)
    expect(calls[2].headers.get('x-kun-approval-consent')).toMatch(/^v1\./)
  })

  it('accepts attachment metadata produced by the current GUI runtime', async () => {
    const sourceSha256 = 'a'.repeat(64)
    const fetchImpl = vi.fn(async () => Response.json({
      attachment: {
        id: 'att_current_gui',
        name: 'clipboard.png',
        kind: 'image',
        mimeType: 'image/png',
        byteSize: 16,
        hash: sourceSha256,
        width: 1,
        height: 1,
        sourceSha256,
        threadIds: [],
        workspaces: ['/tmp/project'],
        createdAt: '2026-07-26T00:00:00.000Z',
        updatedAt: '2026-07-26T00:00:00.000Z'
      }
    }, { status: 201 })) as unknown as typeof fetch
    const client = new KunTuiClient({
      baseUrl: 'http://127.0.0.1:18899',
      runtimeToken: 'runtime-secret',
      fetch: fetchImpl
    })

    await expect(client.uploadAttachment({
      name: 'clipboard.png',
      mimeType: 'image/png',
      dataBase64: 'iVBORw0KGgo='
    })).resolves.toMatchObject({
      attachment: {
        id: 'att_current_gui',
        sourceSha256
      }
    })

    await expect(client.getAttachment('att_current_gui')).resolves.toMatchObject({
      attachment: {
        id: 'att_current_gui',
        name: 'clipboard.png'
      }
    })
    expect(fetchImpl).toHaveBeenLastCalledWith(
      'http://127.0.0.1:18899/v1/attachments/att_current_gui',
      expect.objectContaining({ method: 'GET' })
    )
  })

  it('uses authenticated Graph availability, run, and steering routes', async () => {
    const run = testTuiGraphRun()
    const calls: Array<{ url: URL; method: string; body?: Record<string, unknown> }> = []
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const parsed = new URL(String(url))
      calls.push({
        url: parsed,
        method: init?.method ?? 'GET',
        ...(typeof init?.body === 'string'
          ? { body: JSON.parse(init.body) as Record<string, unknown> }
          : {})
      })
      if (parsed.pathname === '/v1/graphs/diagnostics') {
        return Response.json({ enabled: true })
      }
      if (parsed.pathname === '/v1/graphs') {
        return Response.json({ runs: [run] })
      }
      return Response.json(run)
    }) as unknown as typeof fetch
    const client = new KunTuiClient({
      baseUrl: 'http://127.0.0.1:18899',
      runtimeToken: 'runtime-secret',
      fetch: fetchImpl
    })

    await expect(client.graphAvailability()).resolves.toMatchObject({ enabled: true })
    await expect(client.listGraphRuns('thr_1')).resolves.toEqual([run])
    await expect(client.getGraphRun(run.id)).resolves.toEqual(run)
    await expect(client.steerGraphRun(run.id, 'Focus on Windows parity.')).resolves.toEqual(run)

    expect(calls.map((call) => [call.method, call.url.pathname])).toEqual([
      ['GET', '/v1/graphs/diagnostics'],
      ['GET', '/v1/graphs'],
      ['GET', '/v1/graphs/run_1'],
      ['POST', '/v1/graphs/run_1/steer']
    ])
    expect(calls[1]?.url.searchParams.get('thread_id')).toBe('thr_1')
    expect(calls[3]?.body).toMatchObject({
      target: { kind: 'run' },
      text: 'Focus on Windows parity.'
    })
    expect(String(calls[3]?.body?.commandId)).toMatch(/^tui_steer_/u)
  })

  it('redacts the known runtime token from structured server errors', async () => {
    const client = new KunTuiClient({
      baseUrl: 'http://127.0.0.1:18899',
      runtimeToken: 'runtime-secret',
      fetch: (async () => Response.json({ code: 'bad', message: 'token runtime-secret is invalid' }, { status: 400 })) as typeof fetch
    })
    const error = await client.runtimeInfo().catch((value) => value)
    expect(String(error)).toContain('[REDACTED]')
    expect(String(error)).not.toContain('runtime-secret')
  })

  it('follows refreshed discovery after the shared runtime address changes', async () => {
    const calls: Array<{ url: string; token: string | null }> = []
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const value = String(url)
      calls.push({
        url: value,
        token: new Headers(init?.headers).get('authorization')
      })
      if (value.includes(':18899/')) throw new Error('ECONNREFUSED')
      return Response.json({ threads: [] })
    }) as unknown as typeof fetch
    const resolveConnection = vi.fn(async () => ({
      baseUrl: 'http://127.0.0.1:18900',
      runtimeToken: 'second-token'
    }))
    const client = new KunTuiClient({
      baseUrl: 'http://127.0.0.1:18899',
      runtimeToken: 'first-token',
      fetch: fetchImpl,
      resolveConnection
    })

    await expect(client.listThreads()).resolves.toEqual([])

    expect(resolveConnection).toHaveBeenCalledOnce()
    expect(calls).toEqual([
      {
        url: 'http://127.0.0.1:18899/v1/threads',
        token: 'Bearer first-token'
      },
      {
        url: 'http://127.0.0.1:18900/v1/threads',
        token: 'Bearer second-token'
      }
    ])
  })

  it('reconnects from the last applied SSE sequence and ignores duplicates', async () => {
    const cursors: string[] = []
    const abort = new AbortController()
    const frames = [
      'id: 1\nevent: turn_started\ndata: {"kind":"turn_started","seq":1,"timestamp":"2026-07-22T00:00:00.000Z","threadId":"thr_1","turnId":"turn_1","status":"running"}\n\n',
      'id: 1\nevent: turn_started\ndata: {"kind":"turn_started","seq":1,"timestamp":"2026-07-22T00:00:00.000Z","threadId":"thr_1","turnId":"turn_1","status":"running"}\n\nid: 2\nevent: turn_completed\ndata: {"kind":"turn_completed","seq":2,"timestamp":"2026-07-22T00:00:01.000Z","threadId":"thr_1","turnId":"turn_1","status":"completed"}\n\n'
    ]
    let request = 0
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      cursors.push(new URL(String(url)).searchParams.get('since_seq') ?? '')
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(frames[request++] ?? ''))
          controller.close()
        }
      })
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
    }) as unknown as typeof fetch
    const client = new KunTuiClient({ baseUrl: 'http://127.0.0.1:18899', fetch: fetchImpl })
    const seqs: number[] = []

    await client.subscribeThreadEvents({
      threadId: 'thr_1',
      sinceSeq: 0,
      signal: abort.signal,
      onEvent: (event) => {
        seqs.push(event.seq)
        if (event.seq === 2) abort.abort()
      },
      sleep: async () => undefined
    })

    expect(cursors).toEqual(['0', '1'])
    expect(seqs).toEqual([1, 2])
  })

  it('stops reconnecting when another client permanently deletes the active session', async () => {
    const fetchImpl = vi.fn(async () => Response.json(
      { code: 'not_found', message: 'thread not found' },
      { status: 404 }
    )) as unknown as typeof fetch
    const errors: Error[] = []
    const client = new KunTuiClient({ baseUrl: 'http://127.0.0.1:18899', fetch: fetchImpl })

    await client.subscribeThreadEvents({
      threadId: 'thr_deleted',
      sinceSeq: 0,
      signal: new AbortController().signal,
      onEvent: () => undefined,
      onError: (error) => errors.push(error),
      sleep: async () => { throw new Error('terminal 404 must not retry') }
    })

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(errors[0]).toMatchObject({ status: 404 })
  })

  it('manages shared connections without putting credentials in the URL', async () => {
    const calls: Array<{ path: string; search: string; method: string; body?: unknown }> = []
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const parsed = new URL(String(url))
      calls.push({
        path: parsed.pathname,
        search: parsed.search,
        method: init?.method ?? 'GET',
        ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) } : {})
      })
      if (parsed.pathname.endsWith('/probe')) return Response.json({ ok: true, models: ['model-a'] })
      return Response.json(modelSnapshot(calls.length + 1))
    }) as unknown as typeof fetch
    const client = new KunTuiClient({ baseUrl: 'http://127.0.0.1:18899', fetch: fetchImpl })

    await client.connectModel({
      expectedRevision: 0,
      id: 'custom-provider',
      name: 'Custom Provider',
      baseUrl: 'https://models.example.test/v1',
      endpointFormat: 'responses',
      credential: 'custom-secret-value',
      models: ['custom-model'],
      selectedModel: 'custom-model',
      probe: true,
      select: true
    })
    await client.patchModel('provider-a', { expectedRevision: 1, name: 'Renamed' })
    await client.replaceModelCredential('provider-a', { expectedRevision: 2, credential: 'secret-value' })
    await client.probeModel('provider-a')
    await client.deleteModel('provider-a', 3)

    expect(calls.map((call) => [call.method, call.path])).toEqual([
      ['POST', '/v1/model-connections/connect'],
      ['PATCH', '/v1/model-connections/provider-a'],
      ['PUT', '/v1/model-connections/provider-a/credential'],
      ['POST', '/v1/model-connections/provider-a/probe'],
      ['DELETE', '/v1/model-connections/provider-a']
    ])
    expect(calls[0].search).not.toContain('custom-secret-value')
    expect(calls[0].body).toMatchObject({
      id: 'custom-provider',
      credential: 'custom-secret-value',
      models: ['custom-model'],
      probe: true
    })
    expect(calls[2].search).not.toContain('secret-value')
    expect(calls[2].body).toMatchObject({ credential: 'secret-value' })
    expect(calls[4].search).toBe('?expected_revision=3')
  })

  it('submits a Grok browser result in the authenticated request body only', async () => {
    const calls: Array<{ path: string; method: string; body?: unknown }> = []
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const parsed = new URL(String(url))
      calls.push({
        path: parsed.pathname,
        method: init?.method ?? 'GET',
        ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) } : {})
      })
      return Response.json({
        sessionId: 'oauth_1',
        provider: 'grok',
        status: 'pending',
        expiresAt: '2026-07-23T12:00:00.000Z'
      })
    }) as unknown as typeof fetch
    const client = new KunTuiClient({ baseUrl: 'http://127.0.0.1:18899', fetch: fetchImpl })
    const callback = 'http://127.0.0.1:32123/callback?code=secret-browser-code&state=state-1'

    await client.submitModelOAuth('oauth_1', callback)

    expect(calls).toEqual([{
      path: '/v1/model-connections/oauth/oauth_1/submit',
      method: 'POST',
      body: { code: callback }
    }])
    expect(calls[0]!.path).not.toContain('secret-browser-code')
  })

  it('applies model-connection SSE revisions and ignores replayed snapshots', async () => {
    const abort = new AbortController()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          `id: 2\nevent: model_connections\ndata: ${JSON.stringify(modelSnapshot(2))}\n\n` +
          `id: 2\nevent: model_connections\ndata: ${JSON.stringify(modelSnapshot(2))}\n\n`
        ))
        controller.close()
      }
    })
    const client = new KunTuiClient({
      baseUrl: 'http://127.0.0.1:18899',
      fetch: (async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } })) as typeof fetch
    })
    const revisions: number[] = []

    await client.subscribeModelConnections({
      sinceRevision: 1,
      signal: abort.signal,
      onSnapshot: (snapshot) => {
        revisions.push(snapshot.revision)
        abort.abort()
      },
      sleep: async () => undefined
    })

    expect(revisions).toEqual([2])
  })
})
