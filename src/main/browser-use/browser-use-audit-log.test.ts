import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { appendBrowserUseAuditLine } from './browser-use-audit-log'

describe('Browser Use audit log', () => {
  it('rotates bounded archives before appending and keeps restrictive permissions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-browser-audit-'))
    const directory = join(root, 'browser-use')
    const auditPath = join(directory, 'audit.jsonl')
    try {
      await mkdir(directory, { mode: 0o755 })
      await writeFile(auditPath, '', { mode: 0o644 })
      for (const id of [1, 2, 3, 4]) {
        await appendBrowserUseAuditLine(
          auditPath,
          JSON.stringify({ id, padding: 'x'.repeat(48) }),
          { maxFileBytes: 96, maxArchives: 2 }
        )
      }

      expect(await readFile(auditPath, 'utf8')).toContain('"id":4')
      expect(await readFile(`${auditPath}.1`, 'utf8')).toContain('"id":3')
      expect(await readFile(`${auditPath}.2`, 'utf8')).toContain('"id":2')
      await expect(stat(`${auditPath}.3`)).rejects.toMatchObject({ code: 'ENOENT' })

      if (process.platform !== 'win32') {
        expect((await stat(directory)).mode & 0o777).toBe(0o700)
        for (const path of [auditPath, `${auditPath}.1`, `${auditPath}.2`]) {
          expect((await stat(path)).mode & 0o777).toBe(0o600)
          expect((await stat(path)).size).toBeLessThanOrEqual(96)
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refuses a single record that would exceed the hard file limit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-browser-audit-'))
    try {
      await expect(appendBrowserUseAuditLine(
        join(root, 'browser-use', 'audit.jsonl'),
        'x'.repeat(101),
        { maxFileBytes: 100 }
      )).rejects.toThrow('record exceeds the host file limit')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('drops an oversized legacy current file instead of retaining it as an archive', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-browser-audit-'))
    const auditPath = join(root, 'browser-use', 'audit.jsonl')
    try {
      await mkdir(join(root, 'browser-use'))
      await writeFile(auditPath, 'x'.repeat(101))
      await appendBrowserUseAuditLine(auditPath, '{"id":1}', { maxFileBytes: 100 })
      expect(await readFile(auditPath, 'utf8')).toBe('{"id":1}\n')
      await expect(stat(`${auditPath}.1`)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
