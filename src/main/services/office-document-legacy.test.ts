import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { convertLegacyOfficeDocument } from './office-document-legacy'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('legacy Office conversion', () => {
  it('uses a private output directory and leaves the source untouched', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-legacy-office-'))
    roots.push(root)
    const sourcePath = join(root, 'legacy.doc')
    const source = Buffer.from('legacy source bytes')
    await writeFile(sourcePath, source)
    const runLibreOffice = vi.fn(async (_binary: string, args: string[]) => {
      const outputIndex = args.indexOf('--outdir')
      const outputDirectory = args[outputIndex + 1]
      await writeFile(join(outputDirectory!, 'legacy.docx'), 'converted')
      return { stdout: '', stderr: '', exitCode: 0 }
    })

    const conversion = await convertLegacyOfficeDocument(sourcePath, 'doc', {
      temporaryDirectory: root,
      resolveLibreOfficeBinary: () => '/test/soffice',
      runLibreOffice
    })

    expect(conversion.format).toBe('docx')
    expect(conversion.path).not.toBe(sourcePath)
    expect(conversion.path).toContain('kun-office-preview-')
    expect(await readFile(conversion.path, 'utf8')).toBe('converted')
    expect(await readFile(sourcePath)).toEqual(source)
    expect(runLibreOffice).toHaveBeenCalledWith(
      '/test/soffice',
      expect.arrayContaining([
        expect.stringMatching(/^-env:UserInstallation=file:/),
        '--headless',
        '--convert-to',
        'docx',
        sourcePath
      ]),
      undefined
    )

    await conversion.cleanup()
    await expect(access(conversion.path)).rejects.toThrow()
  })
})
