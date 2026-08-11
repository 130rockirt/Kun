import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { InMemoryEventBus } from '../adapters/in-memory-event-bus.js'
import { InMemorySessionStore } from '../adapters/in-memory-session-store.js'
import { InMemoryThreadStore } from '../adapters/in-memory-thread-store.js'
import { SequentialIdGenerator } from '../ports/id-generator.js'
import { RuntimeEventRecorder } from './runtime-event-recorder.js'
import { ThreadService } from './thread-service.js'

const nowIso = () => '2026-08-12T00:00:00.000Z'

function createHarness() {
  const threadStore = new InMemoryThreadStore()
  const sessionStore = new InMemorySessionStore()
  const eventBus = new InMemoryEventBus()
  const events = new RuntimeEventRecorder({
    eventBus,
    sessionStore,
    allocateSeq: (threadId) => eventBus.allocateSeq(threadId),
    nowIso
  })
  return {
    threadStore,
    service: new ThreadService({
      threadStore,
      sessionStore,
      events,
      ids: new SequentialIdGenerator(),
      nowIso
    })
  }
}

const codeRoot = resolve('fixtures/knowledge-code')
const docsRoot = resolve('fixtures/knowledge-docs')
const notesRoot = resolve('fixtures/knowledge-notes')

describe('ThreadService knowledge-base persistence', () => {
  it('persists mounts through create, update, summary, and fork', async () => {
    const harness = createHarness()
    const docs = {
      id: 'kb_docs', root: docsRoot, name: 'Docs',
      source: 'write-workspace' as const, access: 'read-only' as const
    }
    const notes = {
      id: 'kb_notes', root: notesRoot, name: 'Notes',
      source: 'write-workspace' as const, access: 'read-only' as const
    }
    const thread = await harness.service.create({
      workspace: codeRoot,
      title: 'Knowledge task',
      model: 'test',
      mode: 'agent',
      knowledgeBases: [docs]
    })
    expect((await harness.threadStore.get(thread.id))?.knowledgeBases).toEqual([docs])
    expect((await harness.service.list()).find((candidate) => candidate.id === thread.id)?.knowledgeBases)
      .toEqual([docs])

    const updated = await harness.service.update(thread.id, { knowledgeBases: [docs, notes] })
    expect(updated.knowledgeBases).toEqual([docs, notes])
    const fork = await harness.service.fork(thread.id)
    expect(fork.knowledgeBases).toEqual([docs, notes])
  })

  it('rejects mount mutation while a thread is running', async () => {
    const harness = createHarness()
    const thread = await harness.service.create({
      workspace: codeRoot,
      title: 'Running task',
      model: 'test',
      mode: 'agent'
    })
    await harness.threadStore.upsert({ ...thread, status: 'running' })

    await expect(harness.service.update(thread.id, {
      knowledgeBases: [{
        id: 'kb_docs', root: docsRoot, name: 'Docs',
        source: 'write-workspace', access: 'read-only'
      }]
    })).rejects.toThrow(/while the thread is running/i)
  })
})
