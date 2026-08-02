import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { testGraphConfig } from './graph-test-fixtures.test-support.js'
import { GraphAttemptLeaseManager } from './graph-attempt-leases.js'
import { FileGraphWriteCoordinator } from './graph-write-coordinator.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })
  ))
})

describe('GraphAttemptLeaseManager', () => {
  it('treats a concurrently accepted persisted lease as already integrated', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-graph-attempt-lease-'))
    roots.push(root)
    const workspace = join(root, 'workspace')
    await mkdir(workspace, { recursive: true })
    const config = testGraphConfig({ writeIsolation: { mode: 'lease' } })
    const writes = new FileGraphWriteCoordinator({
      rootDir: join(root, 'writes'),
      config: () => config
    })
    const manager = new GraphAttemptLeaseManager({ writes, config: () => config })
    const claim = await writes.acquire({
      runId: 'run_1',
      nodeId: 'node_1',
      attemptId: 'attempt_1',
      workspaceRoot: workspace,
      scopes: []
    })
    if (!claim.acquired) throw new Error('expected the test lease to be acquired')

    manager.track('attempt_1', claim.lease)
    await writes.release(claim.lease.leaseId, 'accepted')

    await expect(manager.integrate('attempt_1')).resolves.toBe('applied')
  })
})
