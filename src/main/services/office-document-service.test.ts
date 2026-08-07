import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdtemp, readFile, rm, truncate } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ZipFile } from 'yazl'
import { MAX_RUNTIME_DOCUMENT_SOURCE_BYTES } from '../../shared/office-document'
import {
  isBenignOoxmlSchemaFailure,
  readLocalOfficeDocument
} from './office-document-service'

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
      visualPreview: expect.objectContaining({
        mimeType: 'image/webp',
        byteSize: 7
      })
    })
    expect(runOfficeCli.mock.calls.map(([args]) => args.slice(0, 3))).toEqual([
      ['validate', filePath, '--json'],
      ['view', filePath, 'text'],
      ['view', filePath, 'stats'],
      ['view', filePath, 'html']
    ])
    expect(renderHtml).toHaveBeenCalledWith('<html><body>Workbook</body></html>')
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
