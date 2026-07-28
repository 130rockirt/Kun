import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  readRuntimeBuildIdForEntry,
  runtimeBuildManifestPathForEntry
} from './runtime-build-identity.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('runtime build identity', () => {
  it('resolves and reads the manifest adjacent to a built CLI entry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-runtime-build-id-'))
    roots.push(root)
    const entry = join(root, 'dist', 'cli', 'serve-entry.js')
    const buildId = 'a'.repeat(64)
    await mkdir(join(root, 'dist', 'cli'), { recursive: true })
    await writeFile(entry, '', 'utf8')
    await writeFile(
      join(root, 'dist', 'runtime-build.json'),
      JSON.stringify({ version: 1, buildId }),
      'utf8'
    )

    expect(runtimeBuildManifestPathForEntry(entry)).toBe(
      join(root, 'dist', 'runtime-build.json')
    )
    await expect(readRuntimeBuildIdForEntry(entry)).resolves.toBe(buildId)
  })

  it('returns undefined for missing, malformed, or invalid manifests', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-runtime-build-id-invalid-'))
    roots.push(root)
    const entry = join(root, 'dist', 'cli', 'serve-entry.js')
    await mkdir(join(root, 'dist', 'cli'), { recursive: true })
    await writeFile(entry, '', 'utf8')

    await expect(readRuntimeBuildIdForEntry(entry)).resolves.toBeUndefined()
    await writeFile(join(root, 'dist', 'runtime-build.json'), '{broken', 'utf8')
    await expect(readRuntimeBuildIdForEntry(entry)).resolves.toBeUndefined()
    await writeFile(
      join(root, 'dist', 'runtime-build.json'),
      JSON.stringify({ version: 1, buildId: 'not-a-hash' }),
      'utf8'
    )
    await expect(readRuntimeBuildIdForEntry(entry)).resolves.toBeUndefined()
  })
})
