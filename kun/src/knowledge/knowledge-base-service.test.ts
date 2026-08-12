import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { finished } from 'node:stream/promises'
import { afterEach, describe, expect, it } from 'vitest'
import * as yazl from 'yazl'
import { KnowledgeBaseMountsSchema } from '../contracts/threads.js'
import { createThreadRecord, normalizeKnowledgeBaseMounts } from '../domain/thread.js'
import { KnowledgeBaseError, KnowledgeBaseService } from './knowledge-base-service.js'
import { KnowledgeOfficeExtractorRegistry } from './knowledge-office-extractor.js'
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

  it('reuses SHA-keyed Office artifacts, reports formats, and refuses stale evidence', async () => {
    const root = await tempRoot('kun-kb-office-service-')
    const dataDir = await tempRoot('kun-kb-office-data-')
    const path = join(root, 'report.docx')
    await writeMinimalDocx(path, 'first')
    let extractedText = '# Summary\n\nOriginal Office evidence.'
    let calls = 0
    const officeExtractor = new KnowledgeOfficeExtractorRegistry({
      officeCli: {
        run: async () => {
          calls += 1
          return { stdout: extractedText, stderr: '', exitCode: 0 }
        }
      }
    })
    const mount = { id: 'kb_office', root, name: 'Office', source: 'write-workspace', access: 'read-only' } as const
    const thread = createThreadRecord({
      id: 'thr_office_kb', title: 'Office KB', workspace: await tempRoot('kun-office-code-'),
      model: 'test', knowledgeBases: [mount]
    })
    const service = new KnowledgeBaseService({
      dataDir,
      threadStore: { get: async () => thread },
      officeExtractor
    })

    const firstCatalog = await service.catalog(thread.id, 'Original')
    expect(firstCatalog.mounts[0]?.status).toMatchObject({
      state: 'ready',
      availableDocumentCount: 1,
      unavailableDocumentCount: 0,
      formatCounts: { docx: 1 }
    })
    const document = (await service.browse(thread.id, mount.id)).children.find((node) => node.kind === 'document')!
    const section = (await service.browse(thread.id, mount.id, document.id)).children[0]!
    const range = (await service.browse(thread.id, mount.id, section.id)).children[0]!
    const firstEvidence = await service.read(thread.id, mount.id, [range.id])
    expect(firstEvidence.evidence[0]).toMatchObject({
      relativePath: 'report.docx',
      format: 'docx',
      sourceSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      location: { kind: 'word', paragraphStart: 2, paragraphEnd: 2 },
      text: 'Original Office evidence.'
    })

    await service.reindex(thread.id, mount.id)
    expect(calls).toBe(1)
    extractedText = '# Summary\n\nUpdated Office evidence.'
    await writeMinimalDocx(path, 'second')
    await expect(service.read(thread.id, mount.id, [range.id])).rejects.toMatchObject({
      code: 'unavailable'
    } satisfies Partial<KnowledgeBaseError>)
    await service.reindex(thread.id, mount.id)
    expect(calls).toBe(2)
    const updatedEvidence = await service.read(thread.id, mount.id, [range.id])
    expect(updatedEvidence.evidence[0]?.text).toBe('Updated Office evidence.')

    const artifactMounts = await readdir(join(dataDir, 'knowledge-artifacts'))
    const artifactFiles = await readdir(join(dataDir, 'knowledge-artifacts', artifactMounts[0]!))
    expect(artifactFiles).toHaveLength(1)
  })

  it('treats schema-v1 indexes as rebuildable derived cache', async () => {
    const root = await tempRoot('kun-kb-v1-root-')
    const dataDir = await tempRoot('kun-kb-v1-data-')
    await writeFile(join(root, 'guide.md'), '# Current source\n')
    const key = createHash('sha256').update(root).digest('hex')
    const indexDirectory = join(dataDir, 'knowledge-indexes')
    await mkdir(indexDirectory)
    await writeFile(join(indexDirectory, `${key}.json`), JSON.stringify({
      version: 1,
      root,
      fingerprint: 'old',
      builtAt: '2020-01-01T00:00:00.000Z',
      rootNodeId: 'old-root',
      documents: [],
      nodes: {},
      references: [],
      diagnostics: []
    }))
    const mount = { id: 'kb_v1', root, name: 'V1', source: 'write-workspace', access: 'read-only' } as const
    const thread = createThreadRecord({
      id: 'thr_v1', title: 'V1', workspace: await tempRoot('kun-kb-v1-code-'), model: 'test', knowledgeBases: [mount]
    })
    const service = new KnowledgeBaseService({ dataDir, threadStore: { get: async () => thread } })
    const catalog = await service.catalog(thread.id, 'Current')
    expect(catalog.matches.some((match) => match.node.title === 'Current source')).toBe(true)
    const stored = JSON.parse(await readFile(join(indexDirectory, `${key}.json`), 'utf8')) as { version: number }
    expect(stored.version).toBe(2)
  })

  it('keeps usable sources ready when an optional Office extractor is unavailable', async () => {
    const root = await tempRoot('kun-kb-partial-root-')
    const dataDir = await tempRoot('kun-kb-partial-data-')
    await writeFile(join(root, 'notes.md'), '# Usable notes\n')
    await writeMinimalDocx(join(root, 'requires-officecli.docx'), 'content')
    const mount = { id: 'kb_partial', root, name: 'Partial', source: 'write-workspace', access: 'read-only' } as const
    const thread = createThreadRecord({
      id: 'thr_partial', title: 'Partial', workspace: await tempRoot('kun-kb-partial-code-'), model: 'test', knowledgeBases: [mount]
    })
    const service = new KnowledgeBaseService({ dataDir, threadStore: { get: async () => thread } })
    const catalog = await service.catalog(thread.id, 'Usable')
    expect(catalog.matches.some((match) => match.node.title === 'Usable notes')).toBe(true)
    expect(catalog.mounts[0]?.status).toMatchObject({
      state: 'ready',
      availableDocumentCount: 1,
      unavailableDocumentCount: 1,
      formatCounts: { markdown: 1, docx: 1 },
      diagnostics: expect.arrayContaining([expect.stringContaining('OfficeCLI is required')])
    })
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

async function writeMinimalDocx(path: string, marker: string): Promise<void> {
  const zip = new yazl.ZipFile()
  zip.addBuffer(Buffer.from(
    '<?xml version="1.0"?><Types><Override ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
  ), '[Content_Types].xml')
  zip.addBuffer(Buffer.from(marker), 'word/document.xml')
  const output = createWriteStream(path)
  zip.outputStream.pipe(output)
  zip.end()
  await finished(output)
}
