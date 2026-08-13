import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { InMemoryEventBus } from '../../../kun/src/adapters/in-memory-event-bus.js'
import { InMemorySessionStore } from '../../../kun/src/adapters/in-memory-session-store.js'
import { InMemoryThreadStore } from '../../../kun/src/adapters/in-memory-thread-store.js'
import { KnowledgeBaseService } from '../../../kun/src/knowledge/knowledge-base-service.js'
import { SequentialIdGenerator } from '../../../kun/src/ports/id-generator.js'
import { getThreadKnowledgeBases, reindexThreadKnowledgeBase } from '../../../kun/src/server/routes/knowledge-bases.js'
import { RuntimeEventRecorder } from '../../../kun/src/services/runtime-event-recorder.js'
import { ThreadService } from '../../../kun/src/services/thread-service.js'
import {
  kunThreadKnowledgeBaseReindexPath,
  kunThreadKnowledgeBasesPath
} from '../../shared/kun-endpoints'
import { formatComposerKnowledgeBaseMentionToken } from '../../renderer/src/lib/composer-file-references'
import { runtimeRequestPayloadSchema } from './app-ipc-schemas'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

function createThreadHarness() {
  const threadStore = new InMemoryThreadStore()
  const sessionStore = new InMemorySessionStore()
  const eventBus = new InMemoryEventBus()
  const events = new RuntimeEventRecorder({
    eventBus,
    sessionStore,
    allocateSeq: (threadId) => eventBus.allocateSeq(threadId),
    nowIso: () => '2026-08-14T00:00:00.000Z'
  })
  return {
    threadStore,
    threads: new ThreadService({
      threadStore,
      sessionStore,
      events,
      ids: new SequentialIdGenerator(),
      nowIso: () => '2026-08-14T00:00:00.000Z'
    })
  }
}

describe('knowledge-base end-to-end lifecycle', () => {
  it('mounts, admits routes, indexes, reindexes, forks, mentions, and reads cited evidence', async () => {
    const codeRoot = await tempRoot('kun-kb-e2e-code-')
    const knowledgeRoot = await tempRoot('kun-kb-e2e-docs-')
    const dataDir = await tempRoot('kun-kb-e2e-data-')
    await writeFile(join(knowledgeRoot, 'guide.md'), '# Deployment Guide\n\nUse the verified release checklist.\n')
    const harness = createThreadHarness()
    const thread = await harness.threads.create({
      title: 'Knowledge lifecycle',
      workspace: codeRoot,
      model: 'test',
      mode: 'agent'
    })
    const mount = {
      id: 'kb/deployment',
      root: knowledgeRoot,
      name: 'Deployment Docs',
      source: 'write-workspace' as const,
      access: 'read-only' as const
    }
    const updated = await harness.threads.update(thread.id, { knowledgeBases: [mount] })
    expect(updated.knowledgeBases).toEqual([mount])

    const statusPath = kunThreadKnowledgeBasesPath(thread.id)
    const reindexPath = kunThreadKnowledgeBaseReindexPath(thread.id, mount.id)
    expect(runtimeRequestPayloadSchema.parse({ path: statusPath, method: 'GET' }).path)
      .toBe(statusPath)
    expect(runtimeRequestPayloadSchema.parse({ path: reindexPath, method: 'POST' }).path)
      .toBe(reindexPath)

    const knowledge = new KnowledgeBaseService({
      dataDir,
      threadStore: harness.threadStore,
      nowIso: () => '2026-08-14T00:00:00.000Z'
    })
    const firstStatus = await getThreadKnowledgeBases(knowledge, thread.id)
    expect(firstStatus.status).toBe(200)
    expect(JSON.parse(firstStatus.body)).toMatchObject({
      mounts: [{ id: mount.id, access: 'read-only' }],
      statuses: [{ id: mount.id, state: 'pending' }]
    })
    const rebuilt = await reindexThreadKnowledgeBase(knowledge, thread.id, mount.id)
    expect(rebuilt.status).toBe(200)
    expect(JSON.parse(rebuilt.body)).toMatchObject({ id: mount.id, state: 'ready' })
    const readyStatus = await getThreadKnowledgeBases(knowledge, thread.id)
    expect(JSON.parse(readyStatus.body)).toMatchObject({
      statuses: [{ id: mount.id, state: 'ready', availableDocumentCount: 1 }]
    })

    const fork = await harness.threads.fork(thread.id)
    expect(fork.knowledgeBases).toEqual([mount])
    expect(formatComposerKnowledgeBaseMentionToken(mount.name)).toBe('@kb:"Deployment Docs"')

    const catalog = await knowledge.catalog(thread.id, 'release checklist')
    expect(catalog.matches[0]).toMatchObject({ mountId: mount.id })
    const document = (await knowledge.browse(thread.id, mount.id)).children
      .find((node) => node.relativePath === 'guide.md')
    expect(document).toBeTruthy()
    const section = (await knowledge.browse(thread.id, mount.id, document!.id)).children[0]
    const evidence = await knowledge.read(thread.id, mount.id, [section!.id])
    expect(evidence.notice).toContain('untrusted')
    expect(evidence.evidence[0]).toMatchObject({
      mountId: mount.id,
      relativePath: 'guide.md',
      location: { kind: 'text', lineStart: 1 },
      text: expect.stringContaining('verified release checklist')
    })
  })
})
