import { appendFile, mkdtemp, open, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  inspectJsonlTail,
  repairJsonlTail,
  type JsonlTailRepairOptions
} from '../src/services/thread-store-repair.js'

const roots: string[] = []

describe('JSONL tail repair', () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  it('backs up exact bytes and atomically removes only a malformed final record', async () => {
    const path = await makeFile(`${JSON.stringify({ text: '你好' })}\n{"broken":`)
    const original = await readFile(path)
    let backup: Buffer | undefined

    const result = await repairJsonlTail(path, {
      runExclusive: directExclusive,
      backup: async (snapshot) => {
        backup = Buffer.from(snapshot.contents)
        expect(snapshot.bytes).toBe(original.length)
      }
    })

    expect(result).toMatchObject({ status: 'repaired', validRecords: 1 })
    expect(backup).toEqual(original)
    expect((await readFile(path)).toString('utf8')).toBe(`${JSON.stringify({ text: '你好' })}\n`)
    expect((await readdir(dirname(path))).some((name) => name.includes('.repair.'))).toBe(false)
  })

  it('enforces the byte cap before allocating or reading the artifact', async () => {
    const path = await makeFile(`${JSON.stringify({ ok: true })}\n${'x'.repeat(128)}`)
    const result = await inspectJsonlTail(path, { maxBytes: 32 })
    expect(result).toMatchObject({ status: 'too_large', reason: 'max_bytes' })
  })

  it('rejects interior corruption and never invokes backup', async () => {
    const valid = JSON.stringify({ ok: true })
    const path = await makeFile(`${valid}\n{"broken":\n${valid}\n`)
    const backup = vi.fn()

    const result = await repairJsonlTail(path, { backup, runExclusive: directExclusive })

    expect(result).toMatchObject({ status: 'invalid', reason: 'interior_corruption' })
    expect(backup).not.toHaveBeenCalled()
    expect((await readFile(path)).toString('utf8')).toBe(`${valid}\n{"broken":\n${valid}\n`)
  })

  it('fails closed when the file changes during the backup callback', async () => {
    const valid = JSON.stringify({ ok: true })
    const path = await makeFile(`${valid}\n{"broken":`)
    const concurrent = `${JSON.stringify({ concurrent: true })}\n`

    const result = await repairJsonlTail(path, {
      runExclusive: directExclusive,
      backup: async () => {
        await appendFile(path, concurrent)
      }
    })

    expect(result).toMatchObject({ status: 'changed', reason: 'changed_after_backup' })
    expect((await readFile(path)).toString('utf8')).toContain(concurrent)
  })

  it('rejects invalid UTF-8 and a tail without a valid prefix', async () => {
    const root = await makeRoot()
    const invalidUtf8 = join(root, 'invalid.jsonl')
    await writeFile(invalidUtf8, Buffer.from([0xff, 0xfe]))
    expect(await inspectJsonlTail(invalidUtf8)).toMatchObject({ status: 'invalid', reason: 'invalid_utf8' })

    const noPrefix = join(root, 'no-prefix.jsonl')
    await writeFile(noPrefix, '{"broken":')
    expect(await inspectJsonlTail(noPrefix)).toMatchObject({ status: 'invalid', reason: 'no_valid_prefix' })
  })

  it('detects an append through an already-open descriptor across replacement', async () => {
    const valid = JSON.stringify({ ok: true })
    const path = await makeFile(`${valid}\n{"broken":`)
    const held = await open(path, 'a')
    const concurrent = `${JSON.stringify({ concurrent: true })}\n`
    let writer: Promise<void> | undefined

    const result = await repairJsonlTail(path, {
      runExclusive: directExclusive,
      backup: async () => {
        const original = await held.stat({ bigint: true })
        writer = (async () => {
          for (let attempt = 0; attempt < 10_000; attempt += 1) {
            const current = await open(path, 'r')
            try {
              const info = await current.stat({ bigint: true })
              if (info.ino !== original.ino || info.dev !== original.dev) {
                await held.writeFile(concurrent)
                await held.sync()
                return
              }
            } finally {
              await current.close()
            }
          }
          throw new Error('replacement was not observed')
        })()
      }
    })
    await writer
    await held.close()

    expect(result.status).toBe('changed')
    const target = (await readFile(path)).toString('utf8')
    const conflict = result.conflictPath
      ? (await readFile(result.conflictPath)).toString('utf8')
      : ''
    expect(`${target}\n${conflict}`).toContain(concurrent)
  }, 15_000)

  it('scans dense newline input without allocating a line collection', async () => {
    const root = await makeRoot()
    const path = join(root, 'dense.jsonl')
    await writeFile(path, Buffer.alloc(1_000_000, 0x0a))

    const result = await inspectJsonlTail(path, { maxRecords: 1 })

    expect(result).toMatchObject({ status: 'ok', validRecords: 0, bytes: 1_000_000 })
  })

  it('requires and holds a caller maintenance lock against cooperating rename writers', async () => {
    const valid = JSON.stringify({ ok: true })
    const path = await makeFile(`${valid}\n{"broken":`)
    await expect(repairJsonlTail(path, {
      backup: async () => undefined
    } as unknown as JsonlTailRepairOptions)).rejects.toThrow('maintenance_lock_required')

    const runExclusive = createExclusiveRunner()
    const backupEntered = deferred<void>()
    const releaseBackup = deferred<void>()
    const replacementPath = `${path}.external`
    const replacement = `${JSON.stringify({ external: true })}\n`
    await writeFile(replacementPath, replacement)
    let externalRenamed = false
    const repairing = repairJsonlTail(path, {
      runExclusive,
      backup: async () => {
        backupEntered.resolve()
        await releaseBackup.promise
      }
    })
    await backupEntered.promise
    const externalRename = runExclusive(path, async () => {
      await import('node:fs/promises').then((fs) => fs.rename(replacementPath, path))
      externalRenamed = true
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(externalRenamed).toBe(false)

    releaseBackup.resolve()
    expect(await repairing).toMatchObject({ status: 'repaired' })
    await externalRename
    expect(externalRenamed).toBe(true)
    expect((await readFile(path)).toString('utf8')).toBe(replacement)
  })
})

const directExclusive: JsonlTailRepairOptions['runExclusive'] = async (_path, operation) => operation()

function createExclusiveRunner(): JsonlTailRepairOptions['runExclusive'] {
  let tail = Promise.resolve()
  return async <T>(_path: string, operation: () => Promise<T>): Promise<T> => {
    const previous = tail
    let release!: () => void
    tail = new Promise<void>((resolve) => { release = resolve })
    await previous
    try {
      return await operation()
    } finally {
      release()
    }
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => { resolve = next })
  return { promise, resolve }
}

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'kun-jsonl-repair-'))
  roots.push(root)
  return root
}

async function makeFile(contents: string): Promise<string> {
  const root = await makeRoot()
  const path = join(root, 'events.jsonl')
  await writeFile(path, contents)
  return path
}
