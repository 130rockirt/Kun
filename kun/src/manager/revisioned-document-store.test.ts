import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RevisionConflictError, RevisionedDocumentStore } from './revisioned-document-store.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(initial?: string) {
  const root = await mkdtemp(join(tmpdir(), 'kun-manager-documents-'))
  roots.push(root)
  const settingsPath = join(root, 'Kun', 'kun-settings.json')
  if (initial !== undefined) {
    await mkdir(join(root, 'Kun'), { recursive: true })
    await writeFile(settingsPath, initial, 'utf8')
  }
  return {
    settingsPath,
    store: new RevisionedDocumentStore({
      settingsPath,
      clientStatePath: join(root, 'control', 'shared-client-state.json')
    })
  }
}

describe('revisioned manager documents', () => {
  it('adopts the existing production settings file in place', async () => {
    const { store, settingsPath } = await fixture('{"version":1}\n')
    const snapshot = await store.read('settings')
    expect(snapshot).toEqual({ revision: 1, value: '{"version":1}\n' })
    const committed = await store.write({
      key: 'settings',
      expectedRevision: snapshot.revision,
      value: '{"version":1,"locale":"zh-CN"}\n'
    })
    expect(committed.revision).toBe(2)
    expect(await readFile(settingsPath, 'utf8')).toBe(committed.value)
  })

  it('rejects stale compare-and-swap writes', async () => {
    const { store } = await fixture()
    await store.write({ key: 'client-state', expectedRevision: 0, value: '{"a":1}\n' })
    await expect(store.write({
      key: 'client-state',
      expectedRevision: 0,
      value: '{"a":2}\n'
    })).rejects.toBeInstanceOf(RevisionConflictError)
  })
})
