import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import type { Mode, OpenMode, PathLike } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createThreadRecord } from '../src/domain/thread.js'

const swap = vi.hoisted(() => ({
  target: '',
  unreadableTarget: '',
  mutationPath: '',
  secondaryMutationPath: '',
  action: 'replace_target' as 'replace_target'
    | 'rewrite_other'
    | 'replace_other_with_file'
    | 'create_unrelated'
    | 'create_normal_activity',
  replacement: Buffer.alloc(0),
  performed: false
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    open: async (path: PathLike, flags: OpenMode, mode?: Mode) => {
      if (String(path) === swap.unreadableTarget && flags === 'r') {
        throw new Error('simulated unreadable artifact')
      }
      const handle = await actual.open(path, flags, mode)
      if (String(path) !== swap.target || flags !== 'r') return handle
      const read = handle.read.bind(handle) as (...args: unknown[]) => Promise<unknown>
      return new Proxy(handle, {
        get(target, property) {
          if (property === 'read') {
            return async (...args: unknown[]) => {
              if (!swap.performed) {
                if (swap.action === 'replace_target') {
                  const temporary = `${swap.target}.replacement`
                  await actual.writeFile(temporary, swap.replacement)
                  await actual.rename(temporary, swap.target)
                } else if (swap.action === 'rewrite_other') {
                  await actual.writeFile(swap.mutationPath, swap.replacement)
                } else if (swap.action === 'replace_other_with_file') {
                  await actual.unlink(swap.mutationPath)
                  await actual.writeFile(swap.mutationPath, swap.replacement)
                } else if (swap.action === 'create_unrelated') {
                  await actual.mkdir(swap.mutationPath, { recursive: true })
                  await actual.writeFile(`${swap.mutationPath}/created.json`, swap.replacement)
                } else {
                  const backgroundRoot = `${swap.mutationPath}/background-shells`
                  await actual.mkdir(backgroundRoot, { recursive: true })
                  await actual.writeFile(`${backgroundRoot}/shell.log`, swap.replacement)
                  await actual.writeFile(`${swap.mutationPath}/thread.json`, swap.replacement)
                  await actual.mkdir(swap.secondaryMutationPath, { recursive: true })
                  await actual.writeFile(
                    `${swap.secondaryMutationPath}/att_abcdefabcdefabcdefabcdef.json`,
                    swap.replacement
                  )
                  await actual.writeFile(
                    `${swap.secondaryMutationPath}/att_abcdefabcdefabcdefabcdef.bin`,
                    swap.replacement
                  )
                }
                swap.performed = true
              }
              return read(...args)
            }
          }
          const value = Reflect.get(target, property, target) as unknown
          return typeof value === 'function' ? value.bind(target) : value
        }
      })
    }
  }
})

import { scanThreadStore } from '../src/services/thread-store-doctor.js'

const roots: string[] = []
const NOW = '2026-07-18T00:00:00.000Z'

describe('scanThreadStore replacement detection', () => {
  afterEach(async () => {
    swap.target = ''
    swap.unreadableTarget = ''
    swap.mutationPath = ''
    swap.secondaryMutationPath = ''
    swap.action = 'replace_target'
    swap.replacement = Buffer.alloc(0)
    swap.performed = false
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  it('reports changed when the path is atomically replaced after handle fstat', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-thread-store-doctor-race-'))
    roots.push(root)
    const thread = createThreadRecord({
      id: 'thr_replaced',
      title: 'Replaced',
      workspace: root,
      model: 'deepseek-chat',
      createdAt: NOW
    })
    const threadRoot = join(root, 'threads', thread.id)
    await mkdir(threadRoot, { recursive: true })
    await writeFile(join(threadRoot, 'metadata.jsonl'), `${JSON.stringify({
      kind: 'thread_metadata', version: 1, timestamp: NOW, thread
    })}\n`)
    await writeFile(join(threadRoot, 'messages.jsonl'), '')
    swap.target = join(threadRoot, 'events.jsonl')
    await writeFile(swap.target, `${JSON.stringify({
      kind: 'heartbeat', seq: 1, timestamp: NOW, threadId: thread.id
    })}\n`)
    swap.replacement = Buffer.from(`${JSON.stringify({
      kind: 'heartbeat', seq: 2, timestamp: NOW, threadId: thread.id
    })}\n`)

    const report = await scanThreadStore({ dataDir: root })

    expect(swap.performed).toBe(true)
    expect(report.complete).toBe(false)
    expect(report.threads[0]?.events).toBe('changed')
  })

  it('invalidates the report when an earlier artifact changes during a later read', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-thread-store-doctor-stability-'))
    roots.push(root)
    const thread = createThreadRecord({
      id: 'thr_late_mutation',
      title: 'Late mutation',
      workspace: root,
      model: 'deepseek-chat',
      createdAt: NOW
    })
    const threadRoot = join(root, 'threads', thread.id)
    await mkdir(threadRoot, { recursive: true })
    await writeFile(join(threadRoot, 'metadata.jsonl'), `${JSON.stringify({
      kind: 'thread_metadata', version: 1, timestamp: NOW, thread
    })}\n`)
    const messagesPath = join(threadRoot, 'messages.jsonl')
    await writeFile(messagesPath, `${JSON.stringify({
      id: 'item_1',
      turnId: 'turn_1',
      threadId: thread.id,
      role: 'user',
      status: 'completed',
      createdAt: NOW,
      kind: 'user_message',
      text: 'before'
    })}\n`)
    swap.target = join(threadRoot, 'events.jsonl')
    await writeFile(swap.target, `${JSON.stringify({
      kind: 'heartbeat', seq: 1, timestamp: NOW, threadId: thread.id
    })}\n`)
    swap.action = 'rewrite_other'
    swap.mutationPath = messagesPath
    swap.replacement = Buffer.from('{"broken":')

    const report = await scanThreadStore({ dataDir: root })

    expect(swap.performed).toBe(true)
    expect(report.threads[0]?.messages).toBe('ok')
    expect(report.threads[0]?.events).toBe('ok')
    expect(report.complete).toBe(false)
    expect(report.issues).toContainEqual(expect.objectContaining({
      code: 'store_changed_during_scan'
    }))
  })

  it('invalidates the report when an inspected symlink becomes a regular file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-thread-store-doctor-symlink-race-'))
    roots.push(root)
    const thread = createThreadRecord({
      id: 'thr_symlink_replaced',
      title: 'Symlink replaced',
      workspace: root,
      model: 'deepseek-chat',
      createdAt: NOW
    })
    const threadRoot = join(root, 'threads', thread.id)
    await mkdir(threadRoot, { recursive: true })
    await writeFile(join(threadRoot, 'metadata.jsonl'), `${JSON.stringify({
      kind: 'thread_metadata', version: 1, timestamp: NOW, thread
    })}\n`)
    const messagesTarget = join(threadRoot, 'messages-target.jsonl')
    await writeFile(messagesTarget, '')
    const messagesPath = join(threadRoot, 'messages.jsonl')
    await symlink(messagesTarget, messagesPath)
    swap.target = join(threadRoot, 'events.jsonl')
    await writeFile(swap.target, `${JSON.stringify({
      kind: 'heartbeat', seq: 1, timestamp: NOW, threadId: thread.id
    })}\n`)
    swap.action = 'replace_other_with_file'
    swap.mutationPath = messagesPath
    swap.replacement = Buffer.alloc(0)

    const report = await scanThreadStore({ dataDir: root })

    expect(swap.performed).toBe(true)
    expect(report.threads[0]?.messages).toBe('invalid')
    expect(report.complete).toBe(false)
    expect(report.issues).toContainEqual(expect.objectContaining({
      code: 'store_changed_during_scan'
    }))
  })

  it('tracks an unreadable file identity and detects its later replacement', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-thread-store-doctor-unreadable-race-'))
    roots.push(root)
    const thread = createThreadRecord({
      id: 'thr_unreadable_replaced',
      title: 'Unreadable replaced',
      workspace: root,
      model: 'deepseek-chat',
      createdAt: NOW
    })
    const threadRoot = join(root, 'threads', thread.id)
    await mkdir(threadRoot, { recursive: true })
    await writeFile(join(threadRoot, 'metadata.jsonl'), `${JSON.stringify({
      kind: 'thread_metadata', version: 1, timestamp: NOW, thread
    })}\n`)
    const messagesPath = join(threadRoot, 'messages.jsonl')
    await writeFile(messagesPath, 'before')
    swap.unreadableTarget = messagesPath
    swap.target = join(threadRoot, 'events.jsonl')
    await writeFile(swap.target, `${JSON.stringify({
      kind: 'heartbeat', seq: 1, timestamp: NOW, threadId: thread.id
    })}\n`)
    swap.action = 'replace_other_with_file'
    swap.mutationPath = messagesPath
    swap.replacement = Buffer.from('after')

    const report = await scanThreadStore({ dataDir: root })

    expect(swap.performed).toBe(true)
    expect(report.threads[0]?.messages).toBe('invalid')
    expect(report.complete).toBe(false)
    expect(report.issues).toContainEqual(expect.objectContaining({
      code: 'store_changed_during_scan'
    }))
  })

  it('ignores unrelated sibling data-directory activity during the scan', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-thread-store-doctor-unrelated-'))
    roots.push(root)
    const thread = createThreadRecord({
      id: 'thr_unrelated_activity',
      title: 'Unrelated activity',
      workspace: root,
      model: 'deepseek-chat',
      createdAt: NOW
    })
    const threadRoot = join(root, 'threads', thread.id)
    await mkdir(threadRoot, { recursive: true })
    await writeFile(join(threadRoot, 'metadata.jsonl'), `${JSON.stringify({
      kind: 'thread_metadata', version: 1, timestamp: NOW, thread
    })}\n`)
    await writeFile(join(threadRoot, 'messages.jsonl'), '')
    swap.target = join(threadRoot, 'events.jsonl')
    await writeFile(swap.target, `${JSON.stringify({
      kind: 'heartbeat', seq: 1, timestamp: NOW, threadId: thread.id
    })}\n`)
    swap.action = 'create_unrelated'
    swap.mutationPath = join(root, 'artifacts')
    swap.replacement = Buffer.from('{"artifact":true}\n')

    const report = await scanThreadStore({ dataDir: root })

    expect(swap.performed).toBe(true)
    expect(report.complete).toBe(true)
    expect(report.issues).not.toContainEqual(expect.objectContaining({
      code: 'store_changed_during_scan'
    }))
  })

  it('ignores normal background-shell, legacy, and unrelated attachment activity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-thread-store-doctor-normal-activity-'))
    roots.push(root)
    const thread = createThreadRecord({
      id: 'thr_normal_activity',
      title: 'Normal activity',
      workspace: root,
      model: 'deepseek-chat',
      createdAt: NOW
    })
    const threadRoot = join(root, 'threads', thread.id)
    await mkdir(threadRoot, { recursive: true })
    await writeFile(join(threadRoot, 'metadata.jsonl'), `${JSON.stringify({
      kind: 'thread_metadata', version: 1, timestamp: NOW, thread
    })}\n`)
    await writeFile(join(threadRoot, 'messages.jsonl'), '')
    swap.target = join(threadRoot, 'events.jsonl')
    await writeFile(swap.target, `${JSON.stringify({
      kind: 'heartbeat', seq: 1, timestamp: NOW, threadId: thread.id
    })}\n`)
    swap.action = 'create_normal_activity'
    swap.mutationPath = threadRoot
    swap.secondaryMutationPath = join(root, 'attachments')
    swap.replacement = Buffer.from('{"background":true}\n')

    const report = await scanThreadStore({ dataDir: root })

    expect(swap.performed).toBe(true)
    expect(report.complete).toBe(true)
    expect(report.issues).not.toContainEqual(expect.objectContaining({
      code: 'store_changed_during_scan'
    }))
  })
})
