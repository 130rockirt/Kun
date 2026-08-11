import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildKnowledgeIndex, scanKnowledgeSources } from './knowledge-indexer.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

describe('vectorless knowledge index', () => {
  it('builds structural Markdown/text nodes and document reference edges deterministically', async () => {
    const root = await tempRoot('kun-kb-index-')
    await mkdir(join(root, 'guides'))
    await writeFile(join(root, 'README.md'), '# Overview\n\nSee [Setup](guides/setup.md).\n')
    await writeFile(join(root, 'guides', 'setup.md'), '# Setup\n\n## Install\n\nRun the installer.\n')
    await writeFile(join(root, 'notes.txt'), 'First paragraph.\n\nSecond paragraph.\n')

    const scan = await scanKnowledgeSources(root)
    const first = await buildKnowledgeIndex(scan, () => '2026-08-12T00:00:00.000Z')
    const second = await buildKnowledgeIndex(scan, () => '2026-08-12T00:00:00.000Z')

    expect(scan.files.map((file) => file.relativePath)).toEqual([
      'guides/setup.md', 'notes.txt', 'README.md'
    ])
    expect(first.nodes).toEqual(second.nodes)
    expect(Object.values(first.nodes)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'section', title: 'Setup' }),
      expect.objectContaining({ kind: 'section', title: 'Install' }),
      expect.objectContaining({ kind: 'range', title: 'Paragraph 2' })
    ]))
    expect(first.references).toHaveLength(1)
    expect(first.references[0]).toMatchObject({ label: 'Setup' })
  })

  it('skips symlinks so sources cannot escape the mounted root', async () => {
    const root = await tempRoot('kun-kb-safe-')
    const outside = await tempRoot('kun-kb-outside-')
    await writeFile(join(outside, 'secret.md'), '# Secret\n')
    await symlink(join(outside, 'secret.md'), join(root, 'linked.md'))
    await writeFile(join(root, 'safe.md'), '# Safe\n')

    const scan = await scanKnowledgeSources(root)
    expect(scan.files.map((file) => file.relativePath)).toEqual(['safe.md'])
  })
})
