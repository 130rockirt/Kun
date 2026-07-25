export const OFFICE_DOCUMENT_FORMATS = ['docx', 'xlsx', 'pptx'] as const
export type OfficeDocumentFormat = (typeof OFFICE_DOCUMENT_FORMATS)[number]

export type OfficeDocumentVisualPreview = {
  dataBase64: string
  mimeType: 'image/png' | 'image/webp'
  byteSize: number
  width?: number
  height?: number
  wasCompressed?: boolean
}

export type LocalOfficeDocumentTarget = {
  path: string
}

export type LocalOfficeDocumentReadResult =
  | {
      ok: true
      path: string
      name: string
      format: OfficeDocumentFormat
      mimeType: string
      size: number
      mtimeMs: number
      sourceSha256: string
      documentText: string
      pageCount?: number
      truncated: boolean
      visualPreview?: OfficeDocumentVisualPreview
      previewUnavailableReason?: string
    }
  | { ok: false; code?: string; message: string }

export const OFFICE_DOCUMENT_MIME_TYPES: Record<OfficeDocumentFormat, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
}

export const MAX_RUNTIME_DOCUMENT_SOURCE_BYTES = 10 * 1024 * 1024
export const MAX_RUNTIME_DOCUMENT_TEXT_CHARS = 200_000

export function officeDocumentFormatFromName(name: string): OfficeDocumentFormat | null {
  const lower = name.trim().toLowerCase()
  if (lower.endsWith('.docx')) return 'docx'
  if (lower.endsWith('.xlsx')) return 'xlsx'
  if (lower.endsWith('.pptx')) return 'pptx'
  return null
}

export function isOfficeDocumentName(name: string): boolean {
  return officeDocumentFormatFromName(name) !== null
}

export function officeDocumentMimeType(format: OfficeDocumentFormat): string {
  return OFFICE_DOCUMENT_MIME_TYPES[format]
}
