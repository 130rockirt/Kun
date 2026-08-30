import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { RuntimeDiscoveryRecord } from '../server/runtime-discovery.js'
import { runRuntimeCommand } from './shared-runtime.js'

function discovery(): RuntimeDiscoveryRecord {
  return {
    version: 2,
    instanceId: 'runtime-hosting-command',
    pid: process.pid,
    startedAt: '2026-08-30T00:00:00.000Z',
    host: '127.0.0.1',
    port: 18899,
    baseUrl: 'http://127.0.0.1:18899',
    runtimeToken: 'secret',
    insecure: false,
    serviceVersion: '0.1.0',
    launchMode: 'shared'
  }
}

async function withDiscovery(
  run: (dataDir: string, record: RuntimeDiscoveryRecord) => Promise<void>
): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), 'kun-runtime-self-control-'))
  const record = discovery()
  await writeFile(join(dataDir, 'runtime.json'), `${JSON.stringify(record)}\n`, 'utf8')
  try {
    await run(dataDir, record)
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
}

describe('runtime command self-control', () => {
  it.each(['stop', 'restart'] as const)(
    'rejects same-instance %s before shutdown even when health is unavailable',
    async (command) => withDiscovery(async (dataDir, record) => {
      let stderr = ''
      const fetchMock = vi.fn(async (
        _input: string | URL | Request,
        _init?: RequestInit
      ) => new Response('', { status: 503 }))
      const exitCode = await runRuntimeCommand([command, '--data-dir', dataDir], {
        stdout: { write: () => undefined },
        stderr: { write: (chunk) => { stderr += chunk } },
        env: { KUN_RUNTIME_INSTANCE_ID: record.instanceId },
        fetch: fetchMock as unknown as typeof fetch
      })

      expect(exitCode).toBe(70)
      expect(stderr).toContain('runtime_self_control_forbidden')
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
    })
  )

  it.each([undefined, 'runtime-other'])(
    'preserves external lifecycle control for marker %s',
    async (hostedInstanceId) => withDiscovery(async (dataDir) => {
      const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) =>
        new Response('', { status: init?.method === 'POST' ? 503 : 503 }))
      await runRuntimeCommand(['stop', '--data-dir', dataDir], {
        stdout: { write: () => undefined },
        stderr: { write: () => undefined },
        env: hostedInstanceId ? { KUN_RUNTIME_INSTANCE_ID: hostedInstanceId } : {},
        fetch: fetchMock as unknown as typeof fetch
      })

      expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true)
    })
  )

  it('rechecks same-instance identity immediately before shutdown', async () => {
    await withDiscovery(async (dataDir, hostedRecord) => {
      const initialRecord = { ...hostedRecord, instanceId: 'runtime-other' }
      await writeFile(join(dataDir, 'runtime.json'), `${JSON.stringify(initialRecord)}\n`, 'utf8')
      let rewroteDiscovery = false
      const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        if (!rewroteDiscovery && init?.method !== 'POST') {
          rewroteDiscovery = true
          await writeFile(join(dataDir, 'runtime.json'), `${JSON.stringify(hostedRecord)}\n`, 'utf8')
        }
        return new Response('', { status: 503 })
      })
      let stderr = ''

      const exitCode = await runRuntimeCommand(['stop', '--data-dir', dataDir], {
        stdout: { write: () => undefined },
        stderr: { write: (chunk) => { stderr += chunk } },
        env: { KUN_RUNTIME_INSTANCE_ID: hostedRecord.instanceId },
        fetch: fetchMock as unknown as typeof fetch
      })

      expect(exitCode).toBe(70)
      expect(stderr).toContain('runtime_self_control_forbidden')
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
    })
  })
})
