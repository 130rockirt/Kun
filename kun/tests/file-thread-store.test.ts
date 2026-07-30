import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FileThreadStore } from '../src/adapters/file/file-thread-store.js'
import { createThreadRecord } from '../src/domain/thread.js'

describe('FileThreadStore permission migration', () => {
  const cleanup: string[] = []

  afterEach(async () => {
    await Promise.all(
      cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true }))
    )
  })

  it('normalizes a legacy thread without a reviewer to user without widening its policy', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'kun-file-thread-reviewer-'))
    cleanup.push(dataDir)
    const thread = createThreadRecord({
      id: 'thr_legacy_reviewer',
      title: 'Legacy reviewer',
      workspace: '/tmp/project',
      model: 'deepseek-chat',
      approvalPolicy: 'never',
      sandboxMode: 'read-only',
      createdAt: '2026-07-29T00:00:00.000Z'
    })
    const { approvalReviewer: _reviewer, ...legacy } = thread
    const threadDir = join(dataDir, 'threads', thread.id)
    await mkdir(threadDir, { recursive: true })
    await writeFile(join(threadDir, 'thread.json'), JSON.stringify(legacy), 'utf8')
    await writeFile(
      join(dataDir, 'threads', 'index.json'),
      JSON.stringify({ order: [thread.id], updatedAt: thread.updatedAt }),
      'utf8'
    )

    const store = new FileThreadStore({ dataDir })
    await expect(store.get(thread.id)).resolves.toMatchObject({
      approvalPolicy: 'never',
      sandboxMode: 'read-only',
      approvalReviewer: 'user'
    })
    await expect(store.list({ includeArchived: true })).resolves.toMatchObject([
      {
        id: thread.id,
        approvalPolicy: 'never',
        sandboxMode: 'read-only',
        approvalReviewer: 'user'
      }
    ])
  })
})
