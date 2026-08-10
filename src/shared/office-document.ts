export const OFFICE_DOCUMENT_FORMATS = ['docx', 'xlsx', 'pptx'] as const
export type OfficeDocumentFormat = (typeof OFFICE_DOCUMENT_FORMATS)[number]

/**
 * Legacy binary Office formats are preview-only. Keep these separate from
 * `OfficeDocumentFormat`: that type and its helpers back the existing
 * attachment intake path, which only accepts modern OOXML packages.
 */
export const LEGACY_OFFICE_DOCUMENT_FORMATS = ['doc', 'xls', 'ppt'] as const
export type LegacyOfficeDocumentFormat = (typeof LEGACY_OFFICE_DOCUMENT_FORMATS)[number]
export type OfficeDocumentPreviewFormat = OfficeDocumentFormat | LegacyOfficeDocumentFormat

export const MAX_RUNTIME_DOCUMENT_HTML_CHARS = 1_000_000

/** Defense in depth for the scriptless Office HTML iframe and capture window. */
export const OFFICE_DOCUMENT_PREVIEW_CSP = [
  "default-src 'none'",
  "script-src 'none'",
  "style-src 'unsafe-inline'",
  'img-src data:',
  'font-src data:',
  "media-src 'none'",
  "connect-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'"
].join('; ')

/**
 * `sanitizeOfficeDocumentHtml` canonicalizes documents with a `<head>`, so
 * inject our static CSP there before putting the result into an iframe srcdoc.
 */
export function officeDocumentPreviewSrcDoc(sanitizedHtml: string): string {
  const cspMeta = `<meta http-equiv="Content-Security-Policy" content="${OFFICE_DOCUMENT_PREVIEW_CSP}">`
  return /<head(?:\s[^>]*)?>/i.test(sanitizedHtml)
    ? sanitizedHtml.replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}${cspMeta}`)
    : `${cspMeta}${sanitizedHtml}`
}

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

export type WorkspaceOfficePreviewTarget = {
  path: string
  workspaceRoot: string
  /** Reject a completed preview when it was rendered from an older source. */
  expectedSha256?: string
  /** One-based Word page or PowerPoint slide selected for the preview. */
  page?: number
  /** Zero-based worksheet selected from an OfficeCLI workbook HTML preview. */
  sheetIndex?: number
}

type OfficeDocumentReadSuccess<Format extends OfficeDocumentPreviewFormat> = {
  ok: true
  path: string
  name: string
  /** Original on-disk format, including legacy formats converted for preview. */
  format: Format
  mimeType: string
  size: number
  mtimeMs: number
  sourceSha256: string
  documentText: string
  pageCount?: number
  /** Visible worksheet labels emitted by OfficeCLI for XLSX/XLS previews. */
  sheetNames?: string[]
  /** The navigation selection used to produce this stable preview. */
  previewSelection?: {
    page?: number
    sheetIndex?: number
  }
  truncated: boolean
  /** Bounded, structural-sanitized OfficeCLI HTML for a scriptless iframe. */
  sanitizedHtml?: string
  visualPreview?: OfficeDocumentVisualPreview
  previewUnavailableReason?: string
  /** Present only when a legacy source was rendered from a private OOXML copy. */
  convertedFromLegacy?: true
  /** Soft OOXML schema issues (e.g. WPS vendor attrs) that did not block intake. */
  validationWarning?: string
}

type OfficeDocumentReadFailure = { ok: false; code?: string; message: string }

/** Existing direct attachment reader: intentionally modern OOXML only. */
export type LocalOfficeDocumentReadResult =
  | OfficeDocumentReadSuccess<OfficeDocumentFormat>
  | OfficeDocumentReadFailure

/**
 * Workspace previews extend the direct reader with legacy-format support. The
 * separate name keeps the workspace-bounded IPC contract distinct from the
 * modern-only attachment ingestion API.
 */
export type WorkspaceOfficePreviewResult =
  | OfficeDocumentReadSuccess<OfficeDocumentPreviewFormat>
  | OfficeDocumentReadFailure

export const OFFICE_DOCUMENT_MIME_TYPES: Record<OfficeDocumentFormat, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
}

export const LEGACY_OFFICE_DOCUMENT_MIME_TYPES: Record<LegacyOfficeDocumentFormat, string> = {
  doc: 'application/msword',
  xls: 'application/vnd.ms-excel',
  ppt: 'application/vnd.ms-powerpoint'
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

/** Recognizes all formats that the read-only workspace preview can render. */
export function officeDocumentPreviewFormatFromName(name: string): OfficeDocumentPreviewFormat | null {
  const modernFormat = officeDocumentFormatFromName(name)
  if (modernFormat) return modernFormat
  const lower = name.trim().toLowerCase()
  if (lower.endsWith('.doc')) return 'doc'
  if (lower.endsWith('.xls')) return 'xls'
  if (lower.endsWith('.ppt')) return 'ppt'
  return null
}

export function isLegacyOfficeDocumentFormat(
  format: OfficeDocumentPreviewFormat
): format is LegacyOfficeDocumentFormat {
  return (LEGACY_OFFICE_DOCUMENT_FORMATS as readonly string[]).includes(format)
}

export function isOfficeDocumentName(name: string): boolean {
  return officeDocumentFormatFromName(name) !== null
}

export function officeDocumentMimeType(format: OfficeDocumentFormat): string {
  return OFFICE_DOCUMENT_MIME_TYPES[format]
}

export function officeDocumentPreviewMimeType(format: OfficeDocumentPreviewFormat): string {
  return isLegacyOfficeDocumentFormat(format)
    ? LEGACY_OFFICE_DOCUMENT_MIME_TYPES[format]
    : officeDocumentMimeType(format)
}
