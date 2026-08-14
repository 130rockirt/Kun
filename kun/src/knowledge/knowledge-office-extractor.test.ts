import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { finished } from 'node:stream/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as xlsx from 'xlsx'
import * as yazl from 'yazl'
import {
  extractPresentationKnowledge,
  extractWordKnowledge
} from './knowledge-office-cli.js'
import { KnowledgeOfficeExtractorRegistry } from './knowledge-office-extractor.js'
import { withConvertedLegacyOffice } from './knowledge-office-legacy.js'
import { validateModernOfficeArchive } from './knowledge-office-source.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

describe('Office knowledge extraction', () => {
  it('extracts sparse worksheet ranges, formulas, merges, and literal cell text', async () => {
    const root = await tempRoot('kun-kb-sheet-')
    const path = join(root, 'book.xlsx')
    const workbook = xlsx.utils.book_new()
    const sheet = xlsx.utils.aoa_to_sheet([
      ['Name', 'Value', 'Formula'],
      ['<script>alert(1)</script>', 2, { t: 'n', v: 4, f: 'B2*2' }]
    ])
    sheet['!merges'] = [xlsx.utils.decode_range('A2:B2')]
    xlsx.utils.book_append_sheet(workbook, sheet, '数据')
    await writeFile(path, xlsx.write(workbook, { type: 'buffer', bookType: 'xlsx' }))
    const info = await stat(path)
    const source = { absolutePath: path, relativePath: 'book.xlsx', size: info.size, mtimeMs: info.mtimeMs }
    const artifact = await new KnowledgeOfficeExtractorRegistry().extract(source, await sha256(path))

    expect(artifact).toMatchObject({ format: 'xlsx', truncated: false })
    expect(artifact.chunks).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'worksheet', title: '数据' }),
      expect.objectContaining({
        kind: 'cell-range',
        location: expect.objectContaining({ kind: 'spreadsheet', sheetName: '数据', range: 'A1:C2' }),
        text: expect.stringContaining('<script>alert(1)</script>')
      })
    ]))
    expect(artifact.chunks.find((chunk) => chunk.kind === 'cell-range')?.text).toContain('[formula: =B2*2]')

    const legacyPath = join(root, 'book.xls')
    await writeFile(legacyPath, xlsx.write(workbook, { type: 'buffer', bookType: 'biff8' }))
    const legacyInfo = await stat(legacyPath)
    const legacy = await new KnowledgeOfficeExtractorRegistry().extract({
      absolutePath: legacyPath,
      relativePath: 'book.xls',
      size: legacyInfo.size,
      mtimeMs: legacyInfo.mtimeMs
    }, await sha256(legacyPath))
    expect(legacy).toMatchObject({ format: 'xls' })
    expect(legacy.chunks.some((chunk) => chunk.kind === 'cell-range')).toBe(true)
  })

  it('creates stable Word paragraph and PowerPoint slide locations without inventing pages', async () => {
    const root = await tempRoot('kun-kb-cli-')
    const path = join(root, 'report.docx')
    await writeFile(path, 'placeholder')
    const source = { absolutePath: path, relativePath: 'report.docx', size: 11, mtimeMs: 1 }
    const wordRunner = { run: vi.fn(async () => ({
      stdout: '# 概览\n\nFirst paragraph.\n\nSecond paragraph.', stderr: '', exitCode: 0
    })) }
    const word = await extractWordKnowledge(source, 'a'.repeat(64), 'docx', wordRunner)
    expect(word.chunks).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'section', title: '概览', location: { kind: 'word', paragraphStart: 1, paragraphEnd: 1 } }),
      expect.objectContaining({ kind: 'range', location: { kind: 'word', paragraphStart: 2, paragraphEnd: 3 } })
    ]))
    expect(word.chunks.some((chunk) => 'pageStart' in chunk.location)).toBe(false)

    const presentationRunner = { run: vi.fn(async () => ({
      stdout: 'Slide 1: Intro\nWelcome\nSlide 2: Results\nRevenue grew', stderr: '', exitCode: 0
    })) }
    const presentation = await extractPresentationKnowledge(source, 'b'.repeat(64), 'pptx', presentationRunner)
    expect(presentation.chunks.map((chunk) => chunk.location)).toEqual([
      { kind: 'presentation', slideStart: 1, slideEnd: 1 },
      { kind: 'presentation', slideStart: 2, slideEnd: 2 }
    ])
  })

  it('rejects presentations without stable slide markers', async () => {
    const runner = { run: vi.fn(async () => ({ stdout: 'Unnumbered outline', stderr: '', exitCode: 0 })) }
    await expect(extractPresentationKnowledge({
      absolutePath: '/tmp/deck.pptx', relativePath: 'deck.pptx', size: 1, mtimeMs: 1
    }, 'c'.repeat(64), 'pptx', runner)).rejects.toThrow(/stable Slide markers/)
  })

  it('marks bounded Word output as truncated instead of publishing unbounded evidence', async () => {
    const runner = { run: vi.fn(async () => ({
      stdout: Array.from({ length: 4_001 }, (_, index) => `Paragraph ${index + 1}`).join('\n\n'),
      stderr: '',
      exitCode: 0
    })) }
    const artifact = await extractWordKnowledge({
      absolutePath: '/tmp/report.docx', relativePath: 'report.docx', size: 1, mtimeMs: 1
    }, 'd'.repeat(64), 'docx', runner)
    expect(artifact.truncated).toBe(true)
    expect(artifact.chunks.at(-1)?.location).toMatchObject({ paragraphEnd: 4_000 })
  })

  it('converts legacy documents in a private directory and always removes conversion output', async () => {
    const root = await tempRoot('kun-kb-legacy-')
    const temporaryDirectory = join(root, 'temporary')
    const original = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 1, 2, 3])
    const run = vi.fn(async (_binary: string, args: readonly string[]) => {
      const outputDirectory = args[args.indexOf('--outdir') + 1]!
      const convertedFormat = args[args.indexOf('--convert-to') + 1] as 'docx' | 'pptx'
      await writeMinimalOoxml(join(outputDirectory, `source.${convertedFormat}`), convertedFormat)
      return { stdout: '', stderr: '', exitCode: 0 }
    })
    for (const format of ['doc', 'ppt'] as const) {
      const source = join(root, `legacy.${format}`)
      await writeFile(source, original)
      const convertedFormat = format === 'doc' ? 'docx' : 'pptx'
      const value = await withConvertedLegacyOffice(source, format, {
        temporaryDirectory,
        resolveBinary: async () => '/mock/soffice',
        run
      }, undefined, async (converted) => {
        await validateModernOfficeArchive(converted, convertedFormat)
        return 'indexed'
      })
      expect(value).toBe('indexed')
      expect(await readFile(source)).toEqual(original)
    }
    expect(await readdir(temporaryDirectory)).toEqual([])
  })

  it('returns actionable dependency errors for unavailable OfficeCLI and LibreOffice', async () => {
    const root = await tempRoot('kun-kb-missing-office-')
    const docxPath = join(root, 'report.docx')
    await writeMinimalOoxml(docxPath, 'docx')
    const docxInfo = await stat(docxPath)
    await expect(new KnowledgeOfficeExtractorRegistry().extract({
      absolutePath: docxPath, relativePath: 'report.docx', size: docxInfo.size, mtimeMs: docxInfo.mtimeMs
    }, await sha256(docxPath))).rejects.toThrow(/OfficeCLI is required/)

    const docPath = join(root, 'report.doc')
    await writeFile(docPath, Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))
    await expect(withConvertedLegacyOffice(docPath, 'doc', {
      resolveBinary: async () => undefined
    }, undefined, async () => undefined)).rejects.toThrow(/LibreOffice is required/)
  })

  it('rejects corrupt and macro-enabled OOXML before OfficeCLI receives content', async () => {
    const root = await tempRoot('kun-kb-invalid-office-')
    const corrupt = join(root, 'corrupt.docx')
    await writeFile(corrupt, Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]))
    const corruptInfo = await stat(corrupt)
    const runner = { run: vi.fn(async () => ({ stdout: 'text', stderr: '', exitCode: 0 })) }
    await expect(new KnowledgeOfficeExtractorRegistry({ officeCli: runner }).extract({
      absolutePath: corrupt, relativePath: 'corrupt.docx', size: corruptInfo.size, mtimeMs: corruptInfo.mtimeMs
    }, await sha256(corrupt))).rejects.toThrow()

    const macro = join(root, 'macro.docx')
    await writeMinimalOoxml(macro, 'docx', 'macro')
    const macroInfo = await stat(macro)
    await expect(new KnowledgeOfficeExtractorRegistry({ officeCli: runner }).extract({
      absolutePath: macro, relativePath: 'macro.docx', size: macroInfo.size, mtimeMs: macroInfo.mtimeMs
    }, await sha256(macro))).rejects.toThrow(/Macro-enabled/)
    expect(runner.run).not.toHaveBeenCalled()
  })

  it('cleans legacy snapshots when conversion fails', async () => {
    const root = await tempRoot('kun-kb-legacy-fail-')
    const temporaryDirectory = join(root, 'temporary')
    const source = join(root, 'legacy.doc')
    const original = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
    await writeFile(source, original)
    await expect(withConvertedLegacyOffice(source, 'doc', {
      temporaryDirectory,
      resolveBinary: async () => '/mock/soffice',
      run: async () => { throw new Error('conversion aborted') }
    }, undefined, async () => undefined)).rejects.toThrow(/conversion aborted/)
    expect(await readdir(temporaryDirectory)).toEqual([])
    expect(await readFile(source)).toEqual(original)
  })
})

async function writeMinimalOoxml(path: string, format: 'docx' | 'pptx', marker = ''): Promise<void> {
  const contentType = format === 'docx'
    ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'
    : 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml'
  const zip = new yazl.ZipFile()
  const macroType = marker === 'macro'
    ? '<Override ContentType="application/vnd.ms-word.document.macroEnabled.main+xml"/>'
    : ''
  zip.addBuffer(Buffer.from(`<?xml version="1.0"?><Types><Override ContentType="${contentType}"/>${macroType}</Types>`), '[Content_Types].xml')
  zip.addBuffer(Buffer.from(marker || 'content'), format === 'docx' ? 'word/document.xml' : 'ppt/presentation.xml')
  const output = createWriteStream(path)
  zip.outputStream.pipe(output)
  zip.end()
  await finished(output)
}

async function sha256(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}
