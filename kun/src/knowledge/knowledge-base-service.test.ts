import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { KnowledgeBaseMountsSchema } from '../contracts/threads.js'
import { createThreadRecord, normalizeKnowledgeBaseMounts } from '../domain/thread.js'
import { KnowledgeBaseError, KnowledgeBaseService } from './knowledge-base-service.js'
import { buildKnowledgeLocalTools } from './knowledge-tools.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

describe('knowledge-base service and tools', () => {
  it('indexes, catalogs, navigates, reads cited evidence, and detects stale sources', async () => {
    const root = await tempRoot('kun-kb-service-')
    const dataDir = await tempRoot('kun-kb-data-')
    await writeFile(join(root, 'guide.md'), '# Setup Guide\n\nInstall the local package.\n')
    const mount = { id: 'kb_guide', root, name: 'Guide', source: 'write-workspace', access: 'read-only' } as const
    const thread = createThreadRecord({
      id: 'thr_kb', title: 'KB', workspace: await tempRoot('kun-code-'),
      model: 'test', knowledgeBases: [mount]
    })
    const service = new KnowledgeBaseService({
      dataDir,
      threadStore: { get: async (id) => id === thread.id ? thread : null },
      nowIso: () => '2026-08-12T00:00:00.000Z'
    })

    const catalog = await service.catalog(thread.id, 'setup')
    expect(catalog.mounts[0]).toMatchObject({ id: mount.id, status: { state: 'ready' } })
    expect(catalog.matches[0]?.node.title).toBe('Setup Guide')
    const rootView = await service.browse(thread.id, mount.id)
    const document = rootView.children.find((node) => node.kind === 'document')
    expect(document).toBeTruthy()
    const documentView = await service.browse(thread.id, mount.id, document!.id)
    const section = documentView.children.find((node) => node.title === 'Setup Guide')
    const evidence = await service.read(thread.id, mount.id, [section!.id])
    expect(evidence.notice).toContain('untrusted')
    expect(evidence.evidence[0]).toMatchObject({
      relativePath: 'guide.md',
      location: { kind: 'text', lineStart: 1 }
    })
    expect(evidence.evidence[0]?.text).toContain('Install the local package')

    await writeFile(join(root, 'guide.md'), '# Setup Guide\n\nInstall the updated local package.\n')
    const status = await service.listForThread(thread.id)
    expect(status.statuses[0]?.state).toBe('stale')
    await service.reindex(thread.id, mount.id)
  })

  it('authorizes only mounted ids, exposes no path arguments, and advertises only with mounts', async () => {
    const root = await tempRoot('kun-kb-tools-')
    const dataDir = await tempRoot('kun-kb-tool-data-')
    const thread = createThreadRecord({
      id: 'thr_tools', title: 'Tools', workspace: await tempRoot('kun-code-'), model: 'test',
      knowledgeBases: [{ id: 'kb_docs', root, name: 'Docs', source: 'write-workspace', access: 'read-only' }]
    })
    const service = new KnowledgeBaseService({
      dataDir,
      threadStore: { get: async () => thread }
    })
    await expect(service.browse(thread.id, 'kb_unknown')).rejects.toMatchObject({
      code: 'not_found'
    } satisfies Partial<KnowledgeBaseError>)
    const tools = buildKnowledgeLocalTools(service)
    expect(tools.map((tool) => tool.name)).toEqual([
      'knowledge_catalog', 'knowledge_browse', 'knowledge_read'
    ])
    expect(JSON.stringify(tools.map((tool) => tool.inputSchema))).not.toMatch(/root|path/i)
    const context = {
      threadId: thread.id, turnId: 'turn_1', workspace: thread.workspace,
      knowledgeBases: thread.knowledgeBases,
      approvalPolicy: 'auto', sandboxMode: 'workspace-write'
    } as Parameters<NonNullable<(typeof tools)[number]['shouldAdvertise']>>[0]
    expect(tools.every((tool) => tool.sideEffect === 'read-only')).toBe(true)
    expect(tools.every((tool) => tool.shouldAdvertise?.(context) === true)).toBe(true)
    expect(tools.every((tool) => tool.shouldAdvertise?.({ ...context, knowledgeBases: [] }) === false)).toBe(true)
  })
})

describe('knowledge-base mount contracts', () => {
  it('rejects duplicate and overlapping roots while keeping mounts read-only', () => {
    expect(() => KnowledgeBaseMountsSchema.parse([
      { id: 'same', root: '/tmp/a', name: 'A', source: 'write-workspace', access: 'read-only' },
      { id: 'same', root: '/tmp/b', name: 'B', source: 'write-workspace', access: 'read-only' }
    ])).toThrow()
    expect(() => normalizeKnowledgeBaseMounts([
      { id: 'a', root: '/tmp/docs', name: 'A', source: 'write-workspace', access: 'read-only' },
      { id: 'b', root: '/tmp/docs/nested', name: 'B', source: 'write-workspace', access: 'read-only' }
    ], '/tmp/code')).toThrow(/overlap/i)
  })
})
