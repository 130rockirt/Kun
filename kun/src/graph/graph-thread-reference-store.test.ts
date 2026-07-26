import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { GraphRunV1 } from '../contracts/graph.js'
import { FileGraphThreadReferenceStore } from './graph-thread-reference-store.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('FileGraphThreadReferenceStore', () => {
  it('forks immutable run high-water references without sharing mutable execution state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-graph-references-'))
    roots.push(root)
    let now = '2026-07-26T00:00:00.000Z'
    let seq = 10
    const list = async () => [{
      id: 'run_1',
      status: 'running',
      currentRevision: 2,
      lastEventSeq: seq,
      plans: [{ title: 'Durable graph' }]
    }] as GraphRunV1[]
    const references = new FileGraphThreadReferenceStore({
      path: join(root, 'references.json'),
      runs: { list } as never,
      nowIso: () => now,
      nextId: (prefix) => `${prefix}_${seq}`
    })
    const first = await references.fork('thread_source', 'thread_target')
    expect(first).toEqual([expect.objectContaining({
      sourceRunId: 'run_1',
      sourceThreadId: 'thread_source',
      targetThreadId: 'thread_target',
      graphRevision: 2,
      graphSeq: 10,
      statusAtFork: 'running'
    })])
    expect(await references.fork('thread_source', 'thread_target')).toEqual(first)

    seq = 11
    now = '2026-07-26T01:00:00.000Z'
    const advanced = await references.fork('thread_source', 'thread_target')
    expect(advanced[0]?.graphSeq).toBe(11)
    expect(await references.list('thread_target')).toHaveLength(2)
    expect(await references.referencedRunIds()).toEqual(new Set(['run_1']))

    await expect(references.compact('2026-07-26T00:30:00.000Z')).resolves.toBe(1)
    expect(await references.list('thread_target')).toHaveLength(1)
  })
})
