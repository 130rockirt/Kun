import { createHash } from 'node:crypto'
import { open, readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import {
  MAX_RUNTIME_DOCUMENT_SOURCE_BYTES,
  officeDocumentPreviewFormatFromName,
  type LegacyOfficeDocumentFormat,
  type WorkspaceOfficePreviewResult,
  type WorkspaceOfficePreviewSuccess,
  type WorkspaceOfficeRenderFormat,
  type WorkspaceOfficeViewer
} from '../../shared/office-document'
import {
  convertLegacyOfficeDocument,
  OfficeDocumentConversionError,
  type LegacyOfficeDocumentConversion,
  type LegacyOfficeDocumentConversionDependencies
} from './office-document-legacy'
import { assertOoxmlPackageType } from './office-document-ooxml'
import {
  createOfficeDocumentSnapshot,
  type OfficeDocumentSnapshot
} from './office-document-snapshot'

type PreviewTarget = {
  path: string
  expectedSha256?: string
}

export type WorkspaceOfficePreviewDependencies = {
  signal?: AbortSignal
  convertLegacyDocument?: (
    sourcePath: string,
    sourceFormat: LegacyOfficeDocumentFormat,
    dependencies: LegacyOfficeDocumentConversionDependencies
  ) => Promise<LegacyOfficeDocumentConversion>
} & Pick<
  LegacyOfficeDocumentConversionDependencies,
  'resolveLibreOfficeBinary' | 'runLibreOffice' | 'temporaryDirectory'
>

class WorkspaceOfficePreviewError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'WorkspaceOfficePreviewError'
  }
}

const COMPOUND_FILE_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
const LEGACY_STREAM_NAMES: Record<LegacyOfficeDocumentFormat, readonly string[]> = {
  doc: ['WordDocument'],
  xls: ['Workbook', 'Book'],
  ppt: ['PowerPoint Document']
}

/**
 * Prepares only workspace preview bytes. Attachment extraction remains in the
 * OfficeCLI-backed `readLocalOfficeDocument` service.
 */
export async function readWorkspaceOfficePreview(
  target: PreviewTarget,
  dependencies: WorkspaceOfficePreviewDependencies = {}
): Promise<WorkspaceOfficePreviewResult> {
  let sourceSnapshot: OfficeDocumentSnapshot | undefined
  let conversion: LegacyOfficeDocumentConversion | undefined
  try {
    const filePath = target.path.trim()
    const sourceFormat = officeDocumentPreviewFormatFromName(filePath)
    if (!filePath || !sourceFormat) {
      throw new WorkspaceOfficePreviewError(
        'unsupported_type',
        'Expected a .doc, .docx, .xls, .xlsx, .ppt, or .pptx file.'
      )
    }

    const sourceFile = await open(filePath, 'r')
    const { fileStat, source } = await (async () => {
      try {
        const openedFileStat = await sourceFile.stat()
        if (!openedFileStat.isFile()) {
          throw new WorkspaceOfficePreviewError(
            'not_a_file',
            'Office document path is not a regular file.'
          )
        }
        assertAllowedSize(openedFileStat.size, 'Office document')
        const openedSource = await sourceFile.readFile({ signal: dependencies.signal })
        // Defend against an unusual size change through the same open file
        // descriptor after the pre-read stat.
        assertAllowedSize(openedSource.byteLength, 'Office document')
        return { fileStat: openedFileStat, source: openedSource }
      } finally {
        await sourceFile.close()
      }
    })()
    const sourceSha256 = createHash('sha256').update(source).digest('hex')
    if (
      target.expectedSha256?.trim() &&
      sourceSha256.toLowerCase() !== target.expectedSha256.trim().toLowerCase()
    ) {
      throw new WorkspaceOfficePreviewError(
        'source_changed',
        'Office document changed before its preview could be prepared.'
      )
    }

    if (sourceFormat === 'doc' || sourceFormat === 'ppt') {
      assertLegacyOfficeBinaryType(source, sourceFormat)
      sourceSnapshot = await createOfficeDocumentSnapshot(source, sourceFormat)
      conversion = await convertLegacy(sourceSnapshot.path, sourceFormat, dependencies)
      await assertOoxmlPackageType(conversion.path, conversion.format)
      const rendered = await readFile(conversion.path)
      assertAllowedSize(rendered.byteLength, 'Converted Office preview')
      return successResult({
        filePath,
        sourceFormat,
        renderFormat: conversion.format,
        size: fileStat.size,
        mtimeMs: fileStat.mtimeMs,
        sourceSha256,
        data: rendered,
        convertedFromLegacy: true
      })
    }

    if (sourceFormat === 'xls') {
      assertLegacyOfficeBinaryType(source, sourceFormat)
    } else {
      assertNotEncryptedOoxml(source)
      sourceSnapshot = await createOfficeDocumentSnapshot(source, sourceFormat)
      await assertOoxmlPackageType(sourceSnapshot.path, sourceFormat)
    }
    return successResult({
      filePath,
      sourceFormat,
      renderFormat: sourceFormat,
      size: fileStat.size,
      mtimeMs: fileStat.mtimeMs,
      sourceSha256,
      data: source
    })
  } catch (error) {
    return failureResult(error)
  } finally {
    await conversion?.cleanup().catch(() => undefined)
    await sourceSnapshot?.cleanup().catch(() => undefined)
  }
}

function successResult(input: {
  filePath: string
  sourceFormat: WorkspaceOfficePreviewSuccess['sourceFormat']
  renderFormat: WorkspaceOfficeRenderFormat
  size: number
  mtimeMs: number
  sourceSha256: string
  data: Uint8Array
  convertedFromLegacy?: true
}): WorkspaceOfficePreviewSuccess {
  return {
    ok: true,
    path: input.filePath,
    name: basename(input.filePath),
    sourceFormat: input.sourceFormat,
    renderFormat: input.renderFormat,
    viewer: viewerFor(input.renderFormat),
    size: input.size,
    mtimeMs: input.mtimeMs,
    sourceSha256: input.sourceSha256,
    data: new Uint8Array(input.data),
    ...(input.convertedFromLegacy ? { convertedFromLegacy: true as const } : {})
  }
}

function viewerFor(format: WorkspaceOfficeRenderFormat): WorkspaceOfficeViewer {
  if (format === 'docx') return 'word'
  if (format === 'pptx') return 'presentation'
  return 'spreadsheet'
}

function assertAllowedSize(size: number, label: string): void {
  if (size <= 0) {
    throw new WorkspaceOfficePreviewError('empty_file', `${label} is empty.`)
  }
  if (size > MAX_RUNTIME_DOCUMENT_SOURCE_BYTES) {
    throw new WorkspaceOfficePreviewError(
      'file_too_large',
      `${label} exceeds the ${MAX_RUNTIME_DOCUMENT_SOURCE_BYTES} byte preview limit.`
    )
  }
}

function assertLegacyOfficeBinaryType(
  source: Uint8Array,
  format: LegacyOfficeDocumentFormat
): void {
  const buffer = Buffer.from(source.buffer, source.byteOffset, source.byteLength)
  if (!buffer.subarray(0, COMPOUND_FILE_SIGNATURE.length).equals(COMPOUND_FILE_SIGNATURE)) {
    throw contentMismatch(format)
  }
  const hasExpectedStream = LEGACY_STREAM_NAMES[format].some((streamName) =>
    buffer.includes(Buffer.from(`${streamName}\0`, 'utf16le'))
  )
  if (!hasExpectedStream) throw contentMismatch(format)
}

function assertNotEncryptedOoxml(source: Uint8Array): void {
  const buffer = Buffer.from(source.buffer, source.byteOffset, source.byteLength)
  if (!buffer.subarray(0, COMPOUND_FILE_SIGNATURE.length).equals(COMPOUND_FILE_SIGNATURE)) return
  const hasEncryptionStream = ['EncryptedPackage', 'EncryptionInfo'].some((streamName) =>
    buffer.includes(Buffer.from(`${streamName}\0`, 'utf16le'))
  )
  if (hasEncryptionStream) {
    throw new WorkspaceOfficePreviewError(
      'encrypted_office_document',
      'Password-protected or encrypted Office documents cannot be previewed.'
    )
  }
}

function contentMismatch(format: LegacyOfficeDocumentFormat): WorkspaceOfficePreviewError {
  return new WorkspaceOfficePreviewError(
    'invalid_office_document',
    `File content does not match the .${format} Office format.`
  )
}

async function convertLegacy(
  sourcePath: string,
  sourceFormat: 'doc' | 'ppt',
  dependencies: WorkspaceOfficePreviewDependencies
): Promise<LegacyOfficeDocumentConversion> {
  const legacyDependencies: LegacyOfficeDocumentConversionDependencies = {
    resolveLibreOfficeBinary: dependencies.resolveLibreOfficeBinary,
    runLibreOffice: dependencies.runLibreOffice,
    temporaryDirectory: dependencies.temporaryDirectory,
    signal: dependencies.signal
  }
  return (dependencies.convertLegacyDocument ?? convertLegacyOfficeDocument)(
    sourcePath,
    sourceFormat,
    legacyDependencies
  )
}

function failureResult(error: unknown): WorkspaceOfficePreviewResult {
  if (error instanceof WorkspaceOfficePreviewError || error instanceof OfficeDocumentConversionError) {
    return { ok: false, code: error.code, message: boundedErrorMessage(error) }
  }
  const message = boundedErrorMessage(error)
  if (/password|encrypted|encryption/i.test(message)) {
    return {
      ok: false,
      code: 'encrypted_office_document',
      message: 'Password-protected or encrypted Office documents cannot be previewed.'
    }
  }
  return {
    ok: false,
    code: 'invalid_office_document',
    message: message || 'Office document could not be read.'
  }
}

function boundedErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.length > 2_000 ? `${message.slice(0, 2_000)}…` : message
}
