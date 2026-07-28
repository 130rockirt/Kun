import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { waitForWorkspaceCheckpoint } from './workspace-checkpoint-gate.js'

describe('waitForWorkspaceCheckpoint', () => {
  const cleanup: string[] = []

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })))
  })

  it('waits through pending state and returns a ready checkpoint id', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'kun-checkpoint-gate-'))
    cleanup.push(dataDir)
    const checkpointId = 'gcp_pending_1'
    const root = join(dataDir, 'git-checkpoint-gates')
    const path = join(root, `${Buffer.from(checkpointId).toString('base64url')}.json`)
    await mkdir(root, { recursive: true })
    await writeFile(path, JSON.stringify({
      version: 1,
      checkpointId,
      status: 'pending'
    }))

    const waiting = waitForWorkspaceCheckpoint(
      dataDir,
      checkpointId,
      new AbortController().signal,
      { pollMs: 1, timeoutMs: 1_000 }
    )
    await writeFile(path, JSON.stringify({
      version: 1,
      checkpointId,
      status: 'ready'
    }))

    await expect(waiting).resolves.toBe(checkpointId)
  })

  it('releases the mutation gate without a rollback id when capture fails', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'kun-checkpoint-gate-'))
    cleanup.push(dataDir)
    const checkpointId = 'gcp_failed_1'
    const root = join(dataDir, 'git-checkpoint-gates')
    await mkdir(root, { recursive: true })
    await writeFile(
      join(root, `${Buffer.from(checkpointId).toString('base64url')}.json`),
      JSON.stringify({ version: 1, checkpointId, status: 'failed' })
    )

    await expect(waitForWorkspaceCheckpoint(
      dataDir,
      checkpointId,
      new AbortController().signal,
      { pollMs: 1, timeoutMs: 100 }
    )).resolves.toBeNull()
  })
})
