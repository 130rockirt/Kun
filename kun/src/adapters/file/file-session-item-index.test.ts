import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { makeToolResultItem } from '../../domain/item.js'
import { FileSessionItemIndex } from './file-session-item-index.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('FileSessionItemIndex rebuild', () => {
  it('holds the source read lease across scanning and source validation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-item-index-'))
    roots.push(root)
    const sourcePath = join(root, 'messages.jsonl')
    const indexPath = join(root, 'messages-index.jsonl')
    const statePath = join(root, 'messages-index.state.json')
    const item = makeToolResultItem({
      id: 'result_1', threadId: 'thread_1', turnId: 'turn_1', callId: 'call_1',
      toolName: 'bash', output: { text: 'done' }, status: 'completed'
    })
    await writeFile(sourcePath, `${JSON.stringify(item)}\n`)
    let active = false
    let calls = 0

    const result = await new FileSessionItemIndex().rebuild({
      sourcePath,
      indexPath,
      statePath,
      withSourceRead: async (operation) => {
        calls += 1
        active = true
        try {
          return await operation()
        } finally {
          active = false
        }
      }
    })

    expect(calls).toBe(1)
    expect(active).toBe(false)
    expect(result).toMatchObject({ rawCount: 1, uniqueCount: 1 })
    expect(JSON.parse(await readFile(statePath, 'utf8'))).toMatchObject({ sourceBytes: expect.any(Number) })
  })

  it('rebuilds without a source read hook for direct callers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-item-index-direct-'))
    roots.push(root)
    const sourcePath = join(root, 'messages.jsonl')
    const item = makeToolResultItem({
      id: 'result_1', threadId: 'thread_1', turnId: 'turn_1', callId: 'call_1',
      toolName: 'bash', output: { text: 'done' }, status: 'completed'
    })
    await writeFile(sourcePath, `${JSON.stringify(item)}\n`)

    await expect(new FileSessionItemIndex().rebuild({
      sourcePath,
      indexPath: join(root, 'messages-index.jsonl'),
      statePath: join(root, 'messages-index.state.json')
    })).resolves.toMatchObject({ rawCount: 1, uniqueCount: 1 })
  })
})
