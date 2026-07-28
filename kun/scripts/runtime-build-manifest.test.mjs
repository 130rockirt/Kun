import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  computeRuntimeBuildId,
  writeRuntimeBuildManifest
} from './write-runtime-build-manifest.mjs'

test('runtime build identity is stable for identical output and changes with emitted JavaScript', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kun-runtime-build-manifest-'))
  try {
    await writeFile(join(root, 'a.js'), 'export const a = 1\n', 'utf8')
    await writeFile(join(root, 'b.js'), 'export const b = 2\n', 'utf8')
    const first = await computeRuntimeBuildId(root)
    const second = await computeRuntimeBuildId(root)
    assert.equal(second, first)

    await writeFile(join(root, 'b.js'), 'export const b = 3\n', 'utf8')
    assert.notEqual(await computeRuntimeBuildId(root), first)

    const manifest = await writeRuntimeBuildManifest(root)
    assert.equal(manifest.buildId, await computeRuntimeBuildId(root))
    assert.deepEqual(
      JSON.parse(await readFile(join(root, 'runtime-build.json'), 'utf8')),
      manifest
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('runtime build manifest rejects an output directory without JavaScript', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kun-runtime-build-manifest-empty-'))
  try {
    await assert.rejects(computeRuntimeBuildId(root), /no emitted JavaScript/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
