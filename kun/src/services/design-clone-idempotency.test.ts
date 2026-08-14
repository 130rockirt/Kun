import { describe, expect, it } from 'vitest'
import { InMemoryEventBus } from '../adapters/in-memory-event-bus.js'
import { InMemorySessionStore } from '../adapters/in-memory-session-store.js'
import { InMemoryThreadStore } from '../adapters/in-memory-thread-store.js'
import { createThreadRecord } from '../domain/thread.js'
import { SequentialIdGenerator } from '../ports/id-generator.js'
import { RuntimeEventRecorder } from './runtime-event-recorder.js'
import { ThreadService } from './thread-service.js'

function harness() {
  const threadStore = new InMemoryThreadStore()
  const sessionStore = new InMemorySessionStore()
  const eventBus = new InMemoryEventBus()
  const nowIso = () => '2026-08-12T12:00:00.000Z'
  const events = new RuntimeEventRecorder({
    eventBus, sessionStore, allocateSeq: (id) => eventBus.allocateSeq(id), nowIso
  })
  const threads = new ThreadService({
    threadStore, sessionStore, events, ids: new SequentialIdGenerator(), nowIso
  })
  return { threadStore, threads }
}

function source() {
  return createThreadRecord({
    id: 'thr_source', title: 'Design source', workspace: '/tmp/workspace', model: 'test',
    agentSurface: 'code',
    designProfile: {
      version: 1,
      documentTarget: { documentId: 'doc_source', boardArtifactId: 'board_source' },
      outputMedium: 'html', target: 'web', preset: 'none', presetSource: 'none',
      context: { tone: [] }, lockedAtTurnId: 'turn_design'
    }
  })
}

describe('Design clone operation idempotency', () => {
  it('returns one fork for retries and rejects operation reuse with another target', async () => {
    const state = harness()
    await state.threadStore.upsert(source())
    const options = {
      designDocumentTarget: { documentId: 'doc_clone', boardArtifactId: 'board_source' },
      designCloneOperationId: 'design-clone-fork-1'
    }
    const first = await state.threads.fork('thr_source', options)
    const retry = await state.threads.fork('thr_source', options)

    expect(retry.id).toBe(first.id)
    expect(retry.designCloneOperation).toEqual({
      operationId: options.designCloneOperationId, kind: 'fork', sourceId: 'thr_source'
    })
    await expect(state.threads.fork('thr_source', {
      ...options,
      designDocumentTarget: { documentId: 'doc_other', boardArtifactId: 'board_source' }
    })).rejects.toThrow(/different target/i)
  })

  it('returns one resumed thread for retries with the same source, workspace, and target', async () => {
    const state = harness()
    await state.threadStore.upsert(source())
    const options = {
      workspace: '/tmp/workspace',
      designDocumentTarget: { documentId: 'doc_resumed', boardArtifactId: 'board_source' },
      designCloneOperationId: 'design-clone-resume-1'
    }
    const first = await state.threads.resumeSession('thr_source', options)
    const retry = await state.threads.resumeSession('thr_source', options)

    expect(retry.thread.id).toBe(first.thread.id)
    expect(retry.thread.designCloneOperation).toEqual({
      operationId: options.designCloneOperationId, kind: 'resume', sourceId: 'thr_source'
    })
  })
})
