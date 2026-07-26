import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createRuntimeDiscoveryRecord,
  publishRuntimeDiscovery,
  readRuntimeDiscovery,
  removeRuntimeDiscovery,
  runtimeDiscoveryPath,
  withRuntimeStartLock
} from './runtime-discovery.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'kun-runtime-discovery-'))
  roots.push(root)
  return root
}

function input(overrides: Partial<Parameters<typeof publishRuntimeDiscovery>[1]> = {}) {
  return {
    pid: process.pid,
    startedAt: '2026-07-22T00:00:00.000Z',
    host: '127.0.0.1',
    port: 18899,
    baseUrl: 'http://127.0.0.1:18899',
    runtimeToken: 'secret-token',
    insecure: false,
    ...overrides
  }
}

describe('runtime discovery', () => {
  it('creates a validated versioned record', () => {
    expect(createRuntimeDiscoveryRecord(input({ instanceId: 'server-a' }))).toEqual({
      version: 2,
      instanceId: 'server-a',
      pid: process.pid,
      startedAt: '2026-07-22T00:00:00.000Z',
      host: '127.0.0.1',
      port: 18899,
      baseUrl: 'http://127.0.0.1:18899',
      runtimeToken: 'secret-token',
      insecure: false,
      serviceVersion: '0.1.0',
      launchMode: 'foreground'
    })
  })

  it('atomically publishes an owner-only record', async () => {
    const root = await tempRoot()
    const record = await publishRuntimeDiscovery(root, input({ instanceId: 'server-a' }))

    expect(await readRuntimeDiscovery(root)).toEqual(record)
    expect(JSON.parse(await readFile(runtimeDiscoveryPath(root), 'utf8'))).toEqual(record)
    if (process.platform !== 'win32') {
      expect((await stat(runtimeDiscoveryPath(root))).mode & 0o777).toBe(0o600)
    }
  })

  it('treats malformed, oversized, and absent records as unavailable', async () => {
    const root = await tempRoot()
    expect(await readRuntimeDiscovery(root)).toBeNull()
    await writeFile(runtimeDiscoveryPath(root), '{broken', 'utf8')
    expect(await readRuntimeDiscovery(root)).toBeNull()
    await writeFile(runtimeDiscoveryPath(root), 'x'.repeat(65 * 1024), 'utf8')
    expect(await readRuntimeDiscovery(root)).toBeNull()
  })

  it('does not let an older server remove a replacement record', async () => {
    const root = await tempRoot()
    await publishRuntimeDiscovery(root, input({ instanceId: 'server-old' }))
    const replacement = await publishRuntimeDiscovery(root, input({
      instanceId: 'server-new',
      port: 18900,
      baseUrl: 'http://127.0.0.1:18900'
    }))

    expect(await removeRuntimeDiscovery(root, 'server-old')).toBe(false)
    expect(await readRuntimeDiscovery(root)).toEqual(replacement)
    expect(await removeRuntimeDiscovery(root, 'server-new')).toBe(true)
    expect(await readRuntimeDiscovery(root)).toBeNull()
  })

  it('serializes concurrent runtime elections for one data directory', async () => {
    const root = await tempRoot()
    let active = 0
    let peak = 0
    await Promise.all(Array.from({ length: 6 }, () => withRuntimeStartLock(root, async () => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 10))
      active -= 1
    })))
    expect(peak).toBe(1)
  })
})
