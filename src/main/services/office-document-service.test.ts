import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { access, mkdir, mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises'
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
  readLocalOfficeDocument
} from './office-document-service'
import { readWorkspaceOfficePreview } from './office-workspace-preview-service'
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

async function legacyFixture(extension: LegacyOfficeDocumentFormat): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'kun-office-legacy-'))
  roots.push(root)
  const filePath = join(root, `fixture.${extension}`)
  const marker = {
    doc: 'WordDocument',
    xls: 'Workbook',
    ppt: 'PowerPoint Document'
  }[extension]
  const source = Buffer.alloc(2_048)
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(source)
  Buffer.from(`${marker}\0`, 'utf16le').copy(source, 512)
  await writeFile(filePath, source)
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

  it('returns modern workspace bytes without invoking OfficeCLI', async () => {
    const docxPath = await ooxmlFixture('docx')
    const pptxPath = await ooxmlFixture('pptx')

    const docx = await readWorkspaceOfficePreview({ path: docxPath })
    const pptx = await readWorkspaceOfficePreview({ path: pptxPath })

    expect(docx).toMatchObject({ ok: true, sourceFormat: 'docx', renderFormat: 'docx', viewer: 'word' })
    expect(pptx).toMatchObject({ ok: true, sourceFormat: 'pptx', renderFormat: 'pptx', viewer: 'presentation' })
    if (docx.ok) expect(Buffer.from(docx.data)).toEqual(await readFile(docxPath))
    if (pptx.ok) expect(Buffer.from(pptx.data)).toEqual(await readFile(pptxPath))
  })

  it('returns XLSX bytes for browser-side worksheet navigation', async () => {
    const filePath = await ooxmlFixture('xlsx')
    const result = await readWorkspaceOfficePreview({ path: filePath })

    expect(result).toMatchObject({
      ok: true,
      sourceFormat: 'xlsx',
      renderFormat: 'xlsx',
      viewer: 'spreadsheet'
    })
  })

  it('rejects empty, oversized, non-file, and disguised workspace sources', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-office-invalid-'))
    roots.push(root)
    const empty = join(root, 'empty.xlsx')
    const oversized = join(root, 'large.pptx')
    const disguised = join(root, 'disguised.docx')
    const directory = join(root, 'directory.docx')
    await writeFile(empty, '')
    await writeFile(disguised, 'not an OOXML package')
    await writeFile(oversized, 'x')
    await truncate(oversized, MAX_RUNTIME_DOCUMENT_SOURCE_BYTES + 1)
    await mkdir(directory)

    await expect(readWorkspaceOfficePreview({ path: empty })).resolves.toMatchObject({
      ok: false,
      code: 'empty_file'
    })
    await expect(readWorkspaceOfficePreview({ path: oversized })).resolves.toMatchObject({
      ok: false,
      code: 'file_too_large'
    })
    await expect(readWorkspaceOfficePreview({ path: directory })).resolves.toMatchObject({
      ok: false,
      code: 'not_a_file'
    })
    await expect(readWorkspaceOfficePreview({ path: disguised })).resolves.toMatchObject({
      ok: false,
      code: 'invalid_office_document'
    })
  })

  it('reports password-protected OOXML compound packages explicitly', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kun-office-encrypted-'))
    roots.push(root)
    const filePath = join(root, 'protected.docx')
    const source = Buffer.alloc(2_048)
    Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(source)
    Buffer.from('EncryptedPackage\0', 'utf16le').copy(source, 512)
    Buffer.from('EncryptionInfo\0', 'utf16le').copy(source, 1_024)
    await writeFile(filePath, source)

    await expect(readWorkspaceOfficePreview({ path: filePath })).resolves.toEqual({
      ok: false,
      code: 'encrypted_office_document',
      message: 'Password-protected or encrypted Office documents cannot be previewed.'
    })
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
    const filePath = await legacyFixture('doc')
    const original = await readFile(filePath)

    const result = await readWorkspaceOfficePreview({ path: filePath }, {
      resolveLibreOfficeBinary: () => undefined
    })

    expect(result).toEqual({
      ok: false,
      code: 'libreoffice_unavailable',
      message: LIBREOFFICE_UNAVAILABLE_MESSAGE
    })
    expect(await readFile(filePath)).toEqual(original)
  })

  it('renders legacy sources from a temporary OOXML copy without modifying the source', async () => {
    const legacyPath = await legacyFixture('doc')
    const original = await readFile(legacyPath)
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
      convertLegacyDocument
    })

    expect(result).toMatchObject({
      ok: true,
      path: legacyPath,
      sourceFormat: 'doc',
      renderFormat: 'docx',
      viewer: 'word',
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

  it('maps PPT to PPTX and cleans conversion resources when converted validation fails', async () => {
    const legacyPath = await legacyFixture('ppt')
    const original = await readFile(legacyPath)
    const invalidConvertedPath = await ooxmlFixture('xlsx')
    const cleanup = vi.fn(async () => undefined)
    const convertLegacyDocument = vi.fn(async () => ({
      path: invalidConvertedPath,
      format: 'pptx' as const,
      cleanup
    }))

    const result = await readWorkspaceOfficePreview({ path: legacyPath }, {
      convertLegacyDocument
    })

    expect(result).toMatchObject({
      ok: false,
      code: 'invalid_office_document',
      message: expect.stringContaining('does not match the .pptx')
    })
    expect(convertLegacyDocument).toHaveBeenCalledWith(
      expect.stringContaining('kun-office-source-'),
      'ppt',
      expect.any(Object)
    )
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(await readFile(legacyPath)).toEqual(original)
  })

  it('passes legacy XLS bytes directly to the spreadsheet viewer', async () => {
    const filePath = await legacyFixture('xls')
    const source = await readFile(filePath)
    const resolveLibreOfficeBinary = vi.fn()

    const result = await readWorkspaceOfficePreview({ path: filePath }, {
      resolveLibreOfficeBinary
    })

    expect(result).toMatchObject({
      ok: true,
      sourceFormat: 'xls',
      renderFormat: 'xls',
      viewer: 'spreadsheet'
    })
    if (result.ok) expect(Buffer.from(result.data)).toEqual(source)
    expect(resolveLibreOfficeBinary).not.toHaveBeenCalled()
  })

  it('rejects a workspace preview that was rendered from a stale source SHA', async () => {
    const filePath = await ooxmlFixture('xlsx')
    const result = await readWorkspaceOfficePreview({
      path: filePath,
      expectedSha256: '0'.repeat(64)
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
