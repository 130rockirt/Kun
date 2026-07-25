import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  decodeWorkspaceTextPreview,
  listWorkspaceDirectory,
  readWorkspaceFile,
  writeWorkspaceFile
} from './workspace-files'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function createWorkspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'kun-workspace-files-'))
  temporaryDirectories.push(path)
  return path
}

describe('workspace text preview decoding', () => {
  it('decodes UTF-8 and strips its BOM', () => {
    expect(decodeWorkspaceTextPreview(Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('hello 世界', 'utf8')
    ]))).toBe('hello 世界')
  })

  it('decodes UTF-16 little-endian and big-endian BOM files', () => {
    const source = '工作表 A1'
    const littleEndian = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from(source, 'utf16le')
    ])
    const bigEndianBody = Buffer.from(source, 'utf16le')
    for (let index = 0; index + 1 < bigEndianBody.length; index += 2) {
      const first = bigEndianBody[index]
      bigEndianBody[index] = bigEndianBody[index + 1]
      bigEndianBody[index + 1] = first
    }
    const bigEndian = Buffer.concat([Buffer.from([0xfe, 0xff]), bigEndianBody])

    expect(decodeWorkspaceTextPreview(littleEndian)).toBe(source)
    expect(decodeWorkspaceTextPreview(bigEndian)).toBe(source)
  })

  it('keeps unknown NUL-containing binary files out of the text preview path', () => {
    expect(decodeWorkspaceTextPreview(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 1]))).toBeNull()
  })
})

describe('workspace file metadata and conflict-aware writes', () => {
  it('returns size and modification metadata without failing for directories', async () => {
    const workspaceRoot = await createWorkspace()
    await writeFile(join(workspaceRoot, 'note.md'), 'hello', 'utf8')
    await mkdir(join(workspaceRoot, 'docs'))

    const result = await listWorkspaceDirectory({ workspaceRoot })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'note.md', type: 'file', size: 5, mtimeMs: expect.any(Number) }),
      expect.objectContaining({ name: 'docs', type: 'directory', mtimeMs: expect.any(Number) })
    ]))
  })

  it('rejects stale writes and permits an explicit overwrite', async () => {
    const workspaceRoot = await createWorkspace()
    const path = join(workspaceRoot, 'note.md')
    await writeFile(path, 'first', 'utf8')
    const read = await readWorkspaceFile({ workspaceRoot, path: 'note.md' })
    expect(read.ok).toBe(true)
    if (!read.ok) return

    await writeFile(path, 'outside', 'utf8')
    const future = new Date(Date.now() + 2_000)
    await utimes(path, future, future)

    const conflict = await writeWorkspaceFile({
      workspaceRoot,
      path: 'note.md',
      content: 'editor',
      expectedMtimeMs: read.mtimeMs
    })
    expect(conflict).toEqual(expect.objectContaining({
      ok: false,
      code: 'modified_on_disk',
      mtimeMs: expect.any(Number)
    }))

    const forced = await writeWorkspaceFile({
      workspaceRoot,
      path: 'note.md',
      content: 'editor',
      expectedMtimeMs: read.mtimeMs,
      force: true
    })
    expect(forced).toEqual(expect.objectContaining({ ok: true, mtimeMs: expect.any(Number) }))
  })
})
