import {
  ComposerContextAttachmentSchema,
  type ComposerContextAttachment
} from '@kun/extension-api'

export const MAX_WORKSPACE_DOCUMENT_QUOTE_CHARS = 2_000

export type WorkspaceDocumentQuoteDraft = {
  sourceName: string
  documentFormat: 'docx'
  sourceSha256: string
  pageStart: number
  pageEnd: number
  text: string
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value)
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

export function normalizeWorkspaceDocumentQuoteText(value: string): string {
  const normalized = value.replaceAll('\u00a0', ' ').trim()
  return Array.from(normalized).slice(0, MAX_WORKSPACE_DOCUMENT_QUOTE_CHARS).join('')
}

export function workspaceDocumentQuoteCharCount(value: string): number {
  return Array.from(value).length
}

export async function createWorkspaceDocumentQuoteAttachment(input: {
  workspaceRoot: string
  draft: WorkspaceDocumentQuoteDraft
  now?: number
}): Promise<ComposerContextAttachment> {
  const text = normalizeWorkspaceDocumentQuoteText(input.draft.text)
  const sourceName = input.draft.sourceName.trim().slice(0, 128)
  const pageStart = Math.max(1, Math.floor(input.draft.pageStart))
  const pageEnd = Math.max(pageStart, Math.floor(input.draft.pageEnd))
  const charCount = workspaceDocumentQuoteCharCount(text)
  const workspaceId = await sha256Hex(input.workspaceRoot.trim() || '__default__')
  const identity = await sha256Hex(JSON.stringify({
    workspaceId,
    sourceSha256: input.draft.sourceSha256,
    pageStart,
    pageEnd,
    text
  }))
  const pageLabel = pageStart === pageEnd ? `Page ${pageStart}` : `Pages ${pageStart}-${pageEnd}`

  return ComposerContextAttachmentSchema.parse({
    schemaVersion: 1,
    id: `document-quote-${identity.slice(0, 24)}`,
    title: sourceName,
    summary: `${pageLabel} · ${charCount} characters`,
    reference: {
      kind: 'document-quote',
      sourceName,
      documentFormat: input.draft.documentFormat,
      sourceSha256: input.draft.sourceSha256,
      pageStart,
      pageEnd,
      charCount,
      text
    },
    revision: Math.max(0, Math.floor(input.now ?? Date.now())),
    generation: 0,
    attachmentId: `workspace-selection-context:${identity}`,
    provenance: {
      source: 'workspace-selection',
      workspaceId
    }
  })
}
