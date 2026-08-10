import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { access, mkdtemp, readFile, rename, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ZipFile } from 'yazl'
import {
  MAX_RUNTIME_DOCUMENT_SOURCE_BYTES,
  type LegacyOfficeDocumentFormat,
  isOfficeDocumentName,
  officeDocumentPreviewFormatFromName
} from '../../shared/office-document'
import {
  isBenignOoxmlSchemaFailure,
  readLocalOfficeDocument,
  readWorkspaceOfficePreview
} from './office-document-service'
import {
  LIBREOFFICE_UNAVAILABLE_MESSAGE,
  type LegacyOfficeDocumentConversionDependencies
} from './office-document-legacy'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function ooxmlFixture(
  extension: 'docx' | 'xlsx' | 'pptx',
  contentTypeExtension: 'docx' | 'xlsx' | 'pptx' = extension
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'kun-office-document-'))
  roots.push(root)
  const filePath = join(root, `fixture.${extension}`)
  const mainContentType = {
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml'
  }[contentTypeExtension]
  const zip = new ZipFile()
  zip.addBuffer(Buffer.from(
    `<?xml version="1.0"?><Types><Override PartName="/main.xml" ContentType="${mainContentType}"/></Types>`
  ), '[Content_Types].xml')
  zip.addBuffer(Buffer.from('<root/>'), 'main.xml')
  await new Promise<void>((resolveWrite, rejectWrite) => {
    zip.outputStream
      .pipe(createWriteStream(filePath))
      .once('close', resolveWrite)
      .once('error', rejectWrite)
    zip.end()
  })
  return filePath
}

function successfulRun() {
  return vi.fn(async (args: string[]) => {
    if (args[0] === 'validate') return { stdout: '{"valid":true}', stderr: '', exitCode: 0 }
    if (args[2] === 'stats') return { stdout: '{"sheetCount":3}', stderr: '', exitCode: 0 }
    if (args[2] === 'html') return { stdout: '<html><body>Workbook</body></html>', stderr: '', exitCode: 0 }
    return { stdout: 'Sheet1\\nA1 = 42\\nA2 = =SUM(A1:A1)', stderr: '', exitCode: 0 }
  })
}

describe('Office document intake', () => {
  it('verifies OOXML content, extracts semantics, hashes the source, and returns a visual preview', async () => {
    const filePath = await ooxmlFixture('xlsx')
    const source = await readFile(filePath)
    const runOfficeCli = successfulRun()
    const renderHtml = vi.fn(async () => ({
      dataBase64: Buffer.from('preview').toString('base64'),
      mimeType: 'image/webp' as const,
      byteSize: 7,
      width: 800,
      height: 600,
      wasCompressed: true
    }))

    const result = await readLocalOfficeDocument({ path: filePath }, {
      runOfficeCli,
      renderHtml
    })

    expect(result).toMatchObject({
      ok: true,
      path: filePath,
      name: 'fixture.xlsx',
      format: 'xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      sourceSha256: createHash('sha256').update(source).digest('hex'),
      documentText: expect.stringContaining('A1 = 42'),
      pageCount: 3,
      truncated: false,
      sanitizedHtml: expect.stringContaining('<body>Workbook</body>'),
      visualPreview: expect.objectContaining({
        mimeType: 'image/webp',
        byteSize: 7
      })
    })
    expect(runOfficeCli.mock.calls.map(([args]) => [args[0], args[2], ...args.slice(3)])).toEqual([
      ['validate', '--json'],
      ['view', 'text', '--max-lines', '4000'],
      ['view', 'stats', '--json'],
      ['view', 'html']
    ])
    expect(renderHtml).toHaveBeenCalledWith(expect.stringContaining('<body>Workbook</body>'))
  })

  it('uses OfficeCLI page render flags for a selected stable preview', async () => {
    const docxPath = await ooxmlFixture('docx')
    const pptxPath = await ooxmlFixture('pptx')
    const runOfficeCli = vi.fn(async (args: string[]) => {
      if (args[0] === 'validate') return { stdout: '{"valid":true}', stderr: '', exitCode: 0 }
      if (args[2] === 'stats') {
        return {
          stdout: args[1]?.endsWith('.docx') ? '{"pageCount":4}' : '{"slideCount":5}',
          stderr: '',
          exitCode: 0
        }
      }
      if (args[2] === 'html') return { stdout: '<html><body>Preview</body></html>', stderr: '', exitCode: 0 }
      return { stdout: 'Document content', stderr: '', exitCode: 0 }
    })
    const renderHtml = vi.fn(async () => ({
      dataBase64: Buffer.from('preview').toString('base64'),
      mimeType: 'image/webp' as const,
      byteSize: 7
    }))

    const docx = await readWorkspaceOfficePreview({ path: docxPath, page: 3 }, { runOfficeCli, renderHtml })
    const pptx = await readWorkspaceOfficePreview({ path: pptxPath, page: 4 }, { runOfficeCli, renderHtml })

    expect(docx).toMatchObject({ ok: true, pageCount: 4, previewSelection: { page: 3 } })
    expect(pptx).toMatchObject({ ok: true, pageCount: 5, previewSelection: { page: 4 } })
    const commands = runOfficeCli.mock.calls.map(([args]) => [args[0], args[2], ...args.slice(3)])
    expect(commands).toContainEqual(['view', 'html', '--page', '3'])
    expect(commands).toContainEqual(['view', 'html', '--page', '4'])
  })

  it('exposes and statically selects OfficeCLI worksheet tabs without enabling scripts', async () => {
    const filePath = await ooxmlFixture('xlsx')
    const runOfficeCli = vi.fn(async (args: string[]) => {
      if (args[0] === 'validate') return { stdout: '{"valid":true}', stderr: '', exitCode: 0 }
      if (args[2] === 'stats') return { stdout: '{"sheetCount":2}', stderr: '', exitCode: 0 }
      if (args[2] === 'html') {
        return {
          stdout: [
            '<html><head></head><body><div class="sheet-content active" data-sheet="0">Summary</div>',
            '<div class="sheet-content" data-sheet="1">Data</div>',
            '<div class="sheet-tabs"><div class="sheet-tab active" data-sheet="0" onclick="switchSheet(0)">Summary</div>',
            '<div class="sheet-tab" data-sheet="1" onclick="switchSheet(1)">Data</div></div><script>switchSheet()</script></body></html>'
          ].join(''),
          stderr: '',
          exitCode: 0
        }
      }
      return { stdout: 'Sheet content', stderr: '', exitCode: 0 }
    })

    const result = await readWorkspaceOfficePreview({ path: filePath, sheetIndex: 1 }, {
      runOfficeCli,
      renderHtml: vi.fn(async () => ({
        dataBase64: Buffer.from('preview').toString('base64'),
        mimeType: 'image/webp' as const,
        byteSize: 7
      }))
    })

    expect(result).toMatchObject({
      ok: true,
      sheetNames: ['Summary', 'Data'],
      previewSelection: { sheetIndex: 1 }
    })
    if (!result.ok) return
    expect(result.sanitizedHtml).toContain('data-kun-office-sheet="1"')
    expect(result.sanitizedHtml).toContain('.sheet-content[data-sheet="1"]{display:block!important}')
    expect(result.sanitizedHtml).not.toMatch(/<script|onclick=/i)
  })

  it('rejects an OOXML package whose declared content does not match its extension', async () => {
    const filePath = await ooxmlFixture('xlsx', 'docx')
    const runOfficeCli = successfulRun()

    const result = await readLocalOfficeDocument({ path: filePath }, {
      runOfficeCli,
      renderHtml: vi.fn()
    })

    expect(result).toMatchObject({
      ok: false,
      code: 'office_document_failed',
      message: expect.stringContaining('does not match the .xlsx')
    })
    expect(runOfficeCli).not.toHaveBeenCalled()
  })

  it('degrades to semantic-only output when visual rendering fails', async () => {
    const filePath = await ooxmlFixture('docx')
    const result = await readLocalOfficeDocument({ path: filePath }, {
      runOfficeCli: successfulRun(),
      renderHtml: vi.fn(async () => {
        throw new Error('renderer unavailable')
      })
    })

    expect(result).toMatchObject({
      ok: true,
      format: 'docx',
      documentText: expect.any(String),
      previewUnavailableReason: 'renderer unavailable'
    })
    if (result.ok) expect(result.visualPreview).toBeUndefined()
  })

  it('rejects oversized Office attachments before invoking OfficeCLI', async () => {
    const filePath = await ooxmlFixture('pptx')
    await truncate(filePath, MAX_RUNTIME_DOCUMENT_SOURCE_BYTES + 1)
    const runOfficeCli = successfulRun()

    const result = await readLocalOfficeDocument({ path: filePath }, {
      runOfficeCli,
      renderHtml: vi.fn()
    })

    expect(result).toMatchObject({ ok: false, code: 'file_too_large' })
    expect(runOfficeCli).not.toHaveBeenCalled()
  })

  it('soft-fails WPS undeclared schema attributes and continues text extraction (#1122)', async () => {
    const filePath = await ooxmlFixture('xlsx')
    const wpsSchemaFailure = JSON.stringify({
      success: false,
      data: {
        count: 1,
        errors: [{
          type: 'Schema',
          description:
            "The'http://www.wps.cn/officeDocument/2017/etCustomData:filterBottomFollowUsedRange' attribute is not declared.",
          path: '/x:worksheet[1]/x:autoFilter[1]',
          part: '/xl/worksheets/sheet1.xml'
        }]
      }
    })
    const runOfficeCli = vi.fn(async (args: string[]) => {
      if (args[0] === 'validate') {
        return { stdout: wpsSchemaFailure, stderr: '', exitCode: 1 }
      }
      if (args[2] === 'stats') return { stdout: '{"sheetCount":1}', stderr: '', exitCode: 0 }
      if (args[2] === 'html') return { stdout: '<html><body>WPS</body></html>', stderr: '', exitCode: 0 }
      return { stdout: 'Sheet1\\nA1 = ok', stderr: '', exitCode: 0 }
    })

    const result = await readLocalOfficeDocument({ path: filePath }, {
      runOfficeCli,
      renderHtml: vi.fn(async () => ({
        dataBase64: Buffer.from('p').toString('base64'),
        mimeType: 'image/webp' as const,
        byteSize: 1
      }))
    })

    expect(result).toMatchObject({
      ok: true,
      format: 'xlsx',
      documentText: expect.stringContaining('A1 = ok'),
      validationWarning: expect.stringContaining('filterBottomFollowUsedRange')
    })
    expect(runOfficeCli.mock.calls.map(([args]) => args[0])).toEqual([
      'validate',
      'view',
      'view',
      'view'
    ])
  })

  it('still rejects non-schema OfficeCLI validate failures', async () => {
    const filePath = await ooxmlFixture('xlsx')
    const runOfficeCli = vi.fn(async (args: string[]) => {
      if (args[0] === 'validate') {
        return {
          stdout: JSON.stringify({
            success: false,
            data: {
              count: 1,
              errors: [{ type: 'Package', description: 'Missing required part /xl/workbook.xml' }]
            }
          }),
          stderr: '',
          exitCode: 1
        }
      }
      return { stdout: 'should-not-run', stderr: '', exitCode: 0 }
    })

    const result = await readLocalOfficeDocument({ path: filePath }, {
      runOfficeCli,
      renderHtml: vi.fn()
    })

    expect(result).toMatchObject({
      ok: false,
      code: 'office_document_failed',
      message: expect.stringContaining('Office document validation failed')
    })
    expect(runOfficeCli).toHaveBeenCalledTimes(1)
  })

  it('sanitizes active OfficeCLI HTML before exposing or rendering it', async () => {
    const filePath = await ooxmlFixture('docx')
    const runOfficeCli = vi.fn(async (args: string[]) => {
      if (args[0] === 'validate') return { stdout: '{"valid":true}', stderr: '', exitCode: 0 }
      if (args[2] === 'stats') return { stdout: '{"pageCount":1}', stderr: '', exitCode: 0 }
      if (args[2] === 'html') {
        return {
          stdout: [
            '<html><head><style>@import url(https://example.test/a.css);.x{background:url(https://example.test/p.png);color:red}</style></head>',
            '<body onload="alert(1)"><script>alert(1)</script><form action="https://example.test"><input></form>',
            '<img src="https://example.test/image.png"><a href="https://example.test">external</a><a href="#safe">safe</a>',
            '<p class="x">Document</p></body></html>'
          ].join(''),
          stderr: '',
          exitCode: 0
        }
      }
      return { stdout: 'Document', stderr: '', exitCode: 0 }
    })
    const renderHtml = vi.fn(async () => ({
      dataBase64: Buffer.from('preview').toString('base64'),
      mimeType: 'image/webp' as const,
      byteSize: 7
    }))

    const result = await readLocalOfficeDocument({ path: filePath }, { runOfficeCli, renderHtml })

    expect(result).toMatchObject({ ok: true, sanitizedHtml: expect.any(String) })
    if (!result.ok) return
    expect(result.sanitizedHtml).not.toMatch(/<script|onload=|<form|<input|https:\/\//i)
    expect(result.sanitizedHtml).toContain('href="#safe"')
    expect(renderHtml).toHaveBeenCalledWith(result.sanitizedHtml)
  })

  it('returns a stable, actionable error when legacy preview conversion lacks LibreOffice', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-office-legacy-'))
    roots.push(root)
    const filePath = join(root, 'legacy.doc')
    const original = Buffer.from('legacy Office source')
    await writeFile(filePath, original)
    const runOfficeCli = vi.fn()

    const result = await readWorkspaceOfficePreview({ path: filePath }, {
      resolveLibreOfficeBinary: () => undefined,
      runOfficeCli
    })

    expect(result).toEqual({
      ok: false,
      code: 'libreoffice_unavailable',
      message: LIBREOFFICE_UNAVAILABLE_MESSAGE
    })
    expect(await readFile(filePath)).toEqual(original)
    expect(runOfficeCli).not.toHaveBeenCalled()
  })

  it('renders legacy sources from a temporary OOXML copy without modifying the source', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-office-legacy-'))
    roots.push(root)
    const legacyPath = join(root, 'legacy.doc')
    const original = Buffer.from('legacy Office source')
    await writeFile(legacyPath, original)
    const convertedPath = await ooxmlFixture('docx')
    const cleanup = vi.fn(async () => undefined)
    const convertLegacyDocument = vi.fn(async (
      _sourcePath: string,
      _sourceFormat: LegacyOfficeDocumentFormat,
      _dependencies: LegacyOfficeDocumentConversionDependencies
    ) => ({
      path: convertedPath,
      format: 'docx' as const,
      cleanup
    }))

    const result = await readWorkspaceOfficePreview({ path: legacyPath }, {
      convertLegacyDocument,
      runOfficeCli: successfulRun(),
      renderHtml: vi.fn(async () => ({
        dataBase64: Buffer.from('preview').toString('base64'),
        mimeType: 'image/webp' as const,
        byteSize: 7
      }))
    })

    expect(result).toMatchObject({
      ok: true,
      path: legacyPath,
      format: 'doc',
      mimeType: 'application/msword',
      convertedFromLegacy: true
    })
    expect(convertLegacyDocument).toHaveBeenCalledWith(
      expect.stringContaining('kun-office-source-'),
      'doc',
      expect.objectContaining({ signal: undefined })
    )
    const snapshotPath = convertLegacyDocument.mock.calls[0]?.[0]
    expect(snapshotPath).not.toBe(legacyPath)
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(await readFile(legacyPath)).toEqual(original)
    if (snapshotPath) await expect(access(snapshotPath)).rejects.toThrow()
  })

  it('renders from an immutable snapshot when the source is replaced mid-render', async () => {
    const filePath = await ooxmlFixture('xlsx')
    const source = await readFile(filePath)
    const replacement = Buffer.from('replacement written after the source snapshot')
    const replacementPath = `${filePath}.replacement`
    let snapshotPath = ''
    const runOfficeCli = vi.fn(async (args: string[]) => {
      const renderPath = args[1]
      if (!snapshotPath) snapshotPath = renderPath ?? ''
      expect(renderPath).toBe(snapshotPath)
      if (args[0] === 'validate') {
        await writeFile(replacementPath, replacement)
        await rename(replacementPath, filePath)
        return { stdout: '{"valid":true}', stderr: '', exitCode: 0 }
      }
      if (args[2] === 'stats') return { stdout: '{"sheetCount":1}', stderr: '', exitCode: 0 }
      if (args[2] === 'html') return { stdout: '<html><body>Snapshot</body></html>', stderr: '', exitCode: 0 }
      return { stdout: 'Snapshot semantic text', stderr: '', exitCode: 0 }
    })

    const result = await readWorkspaceOfficePreview({ path: filePath }, {
      runOfficeCli,
      renderHtml: vi.fn(async () => ({
        dataBase64: Buffer.from('preview').toString('base64'),
        mimeType: 'image/webp' as const,
        byteSize: 7
      }))
    })

    expect(result).toMatchObject({
      ok: true,
      sourceSha256: createHash('sha256').update(source).digest('hex'),
      documentText: 'Snapshot semantic text'
    })
    expect(snapshotPath).toContain('kun-office-source-')
    expect(snapshotPath).not.toBe(filePath)
    expect(await readFile(filePath)).toEqual(replacement)
    await expect(access(snapshotPath)).rejects.toThrow()
  })

  it('rejects a workspace preview that was rendered from a stale source SHA', async () => {
    const filePath = await ooxmlFixture('xlsx')
    const result = await readWorkspaceOfficePreview({
      path: filePath,
      expectedSha256: '0'.repeat(64)
    }, {
      runOfficeCli: successfulRun(),
      renderHtml: vi.fn(async () => ({
        dataBase64: Buffer.from('preview').toString('base64'),
        mimeType: 'image/webp' as const,
        byteSize: 7
      }))
    })

    expect(result).toEqual({
      ok: false,
      code: 'source_changed',
      message: 'Office document changed before its preview could be prepared.'
    })
  })
})

describe('Office preview format classification', () => {
  it('recognizes legacy preview formats without widening attachment intake', () => {
    expect(officeDocumentPreviewFormatFromName('report.DOC')).toBe('doc')
    expect(officeDocumentPreviewFormatFromName('sheet.xls')).toBe('xls')
    expect(officeDocumentPreviewFormatFromName('slides.ppt')).toBe('ppt')
    expect(isOfficeDocumentName('report.doc')).toBe(false)
    expect(isOfficeDocumentName('report.docx')).toBe(true)
  })
})

describe('isBenignOoxmlSchemaFailure', () => {
  it('accepts Schema undeclared-attribute errors from WPS packages', () => {
    expect(isBenignOoxmlSchemaFailure({
      exitCode: 1,
      stdout: JSON.stringify({
        success: false,
        data: {
          errors: [{
            type: 'Schema',
            description:
              "The'http://www.wps.cn/officeDocument/2017/etCustomData:filterBottomFollowUsedRange' attribute is not declared."
          }]
        }
      }),
      stderr: ''
    })).toBe(true)
  })

  it('rejects package-structure validate failures', () => {
    expect(isBenignOoxmlSchemaFailure({
      exitCode: 1,
      stdout: JSON.stringify({
        success: false,
        data: { errors: [{ type: 'Package', description: 'Corrupt ZIP central directory' }] }
      }),
      stderr: ''
    })).toBe(false)
  })
})
