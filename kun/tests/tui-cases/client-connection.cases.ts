import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildRuntimeCapabilityManifest } from '../../src/contracts/capabilities.js'
import { ThreadSchema } from '../../src/contracts/threads.js'
import { publishRuntimeDiscovery } from '../../src/server/runtime-discovery.js'
import { KunTuiClient, TuiClientError, resolveTuiConnection } from '../../src/tui/client.js'
import { testTuiGraphRun } from '../../src/tui/graph-mode.test-support.js'
import type { TuiOptions } from '../../src/tui/options.js'

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

  it('reuses a discovered runtime when the bundled TUI build identity matches', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-tui-client-same-build-'))
    roots.push(root)
    const buildId = 'a'.repeat(64)
    await publishRuntimeDiscovery(root, {
      instanceId: 'same-build-runtime',
      pid: process.pid,
      startedAt: '2026-07-22T00:00:00.000Z',
      host: '127.0.0.1',
      port: 18899,
      baseUrl: 'http://127.0.0.1:18899',
      runtimeToken: 'same-build-secret',
      insecure: false,
      buildId
    })
    const fetchImpl = vi.fn(async () => Response.json(runtimeInfo({
      instanceId: 'same-build-runtime',
      buildId
    }))) as unknown as typeof fetch
    const ensureRuntime = vi.fn()

    await expect(resolveTuiConnection(
      options({ dataDir: root, runtimeToken: '' }),
      fetchImpl,
      { expectedBuildId: buildId, ensureRuntime }
    )).resolves.toMatchObject({
      discovered: true,
      runtimeInfo: { buildId }
    })
    expect(ensureRuntime).not.toHaveBeenCalled()
  })

  it('replaces a healthy older runtime before returning the TUI connection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-tui-client-replace-build-'))
    roots.push(root)
    const oldBuildId = 'a'.repeat(64)
    const expectedBuildId = 'b'.repeat(64)
    await publishRuntimeDiscovery(root, {
      instanceId: 'old-build-runtime',
      pid: process.pid,
      startedAt: '2026-07-22T00:00:00.000Z',
      host: '127.0.0.1',
      port: 18899,
      baseUrl: 'http://127.0.0.1:18899',
      runtimeToken: 'old-build-secret',
      insecure: false,
      buildId: oldBuildId
    })
    const fetchImpl = vi.fn(async () => Response.json(runtimeInfo({
      instanceId: 'old-build-runtime',
      buildId: oldBuildId
    }))) as unknown as typeof fetch
    const replacementInfo = runtimeInfo({
      instanceId: 'new-build-runtime',
      buildId: expectedBuildId
    })
    const ensureRuntime = vi.fn(async () => ({
      discovery: {
        version: 2,
        instanceId: 'new-build-runtime',
        pid: process.pid,
        startedAt: replacementInfo.startedAt,
        host: '127.0.0.1',
        port: 18900,
        baseUrl: 'http://127.0.0.1:18900',
        runtimeToken: 'new-build-secret',
        insecure: false,
        serviceVersion: '0.1.0',
        buildId: expectedBuildId,
        launchMode: 'shared'
      },
      info: replacementInfo
    }))

    await expect(resolveTuiConnection(
      options({ dataDir: root, runtimeToken: '' }),
      fetchImpl,
      { expectedBuildId, ensureRuntime: ensureRuntime as never }
    )).resolves.toMatchObject({
      baseUrl: 'http://127.0.0.1:18900',
      runtimeToken: 'new-build-secret',
      runtimeInfo: { buildId: expectedBuildId }
    })
    expect(ensureRuntime).toHaveBeenCalledWith({
      controlDir: expect.stringContaining('.kun'),
      dataDir: root,
      fetch: fetchImpl,
      expectedBuildId,
      runtimeFlavor: 'production'
    })
  })

  it('rejects a discovered build mismatch when --no-start is active', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-tui-client-no-start-build-'))
    roots.push(root)
    const oldBuildId = 'a'.repeat(64)
    const expectedBuildId = 'b'.repeat(64)
    await publishRuntimeDiscovery(root, {
      instanceId: 'old-build-runtime',
      pid: process.pid,
      startedAt: '2026-07-22T00:00:00.000Z',
      host: '127.0.0.1',
      port: 18899,
      baseUrl: 'http://127.0.0.1:18899',
      runtimeToken: 'old-build-secret',
      insecure: false,
      buildId: oldBuildId
    })
    const fetchImpl = vi.fn(async () => Response.json(runtimeInfo({
      instanceId: 'old-build-runtime',
      buildId: oldBuildId
    }))) as unknown as typeof fetch
    const ensureRuntime = vi.fn()

    const error = await resolveTuiConnection(
      options({ dataDir: root, runtimeToken: '', noStart: true }),
      fetchImpl,
      { expectedBuildId, ensureRuntime }
    ).catch((value) => value)

    expect(error).toBeInstanceOf(TuiClientError)
    expect(error).toMatchObject({ code: 'runtime_build_mismatch' })
    expect(String(error)).toContain('older application build')
    expect(ensureRuntime).not.toHaveBeenCalled()
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
