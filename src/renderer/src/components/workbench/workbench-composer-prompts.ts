import type { AttachmentReference, UserFileReference } from '../../agent/types'
import {
  buildComposerFileContextPrompt,
  isComposerDirectoryReference,
  type ComposerFileContextEntry
} from '../../lib/composer-file-references'
import type { ComposerFileReference } from '../chat/FloatingComposer'
import type { OfficeDocumentFormat } from '@shared/office-document'

export const COMPOSER_FILE_CONTEXT_MAX_CHARS_PER_FILE = 60_000
export const COMPOSER_FILE_CONTEXT_MAX_TOTAL_CHARS = 180_000
export const COMPOSER_DIRECTORY_CONTEXT_MAX_FILES = 60

export function composerToolReferencePlaceholder(
  reference: Pick<ComposerFileReference, 'path'>,
  officeFormat?: OfficeDocumentFormat | null
): string {
  return officeFormat
    ? [
        `[${officeFormat.toUpperCase()} binary content is not embedded in this prompt.]`,
        `The file remains available to tools at: ${reference.path}`,
        'Use office_inspect before reading or editing it.'
      ].join('\n')
    : [
        '[Binary or oversized file content is not embedded in this prompt.]',
        `The file remains available to tools at: ${reference.path}`,
        'Use a suitable file tool to inspect it.'
      ].join('\n')
}

export function clipComposerFileContext(
  content: string,
  remainingChars: number,
  sourceTruncated: boolean
): { content: string; truncated: boolean; consumed: number } {
  const limit = Math.max(0, Math.min(COMPOSER_FILE_CONTEXT_MAX_CHARS_PER_FILE, remainingChars))
  const clipped = content.slice(0, limit)
  return {
    content: clipped,
    truncated: sourceTruncated || clipped.length < content.length,
    consumed: clipped.length
  }
}

export function composerReferencesToUserFileReferences(
  references: ComposerFileReference[]
): UserFileReference[] {
  return references.map((reference) => ({
    path: reference.path,
    relativePath: reference.relativePath,
    name: reference.name,
    kind: isComposerDirectoryReference(reference) ? 'directory' : 'file'
  }))
}

export function stripTransientAttachmentFields(
  attachments: AttachmentReference[]
): AttachmentReference[] {
  return attachments.map(({
    documentText: _documentText,
    previewUrl: _previewUrl,
    previewUnavailableReason: _previewUnavailableReason,
    ...attachment
  }) => attachment)
}

export function buildComposerDocumentContextPrompt(
  userPrompt: string,
  attachments: AttachmentReference[]
): string {
  const entries: ComposerFileContextEntry[] = []
  let remainingChars = COMPOSER_FILE_CONTEXT_MAX_TOTAL_CHARS
  for (const attachment of attachments) {
    if (remainingChars <= 0) break
    if (attachment.kind !== 'document' || !attachment.documentText?.trim()) continue
    const clipped = clipComposerFileContext(
      attachment.documentText,
      remainingChars,
      attachment.truncated === true
    )
    remainingChars -= clipped.consumed
    entries.push({
      relativePath: attachment.name || attachment.id,
      content: clipped.content,
      ...(clipped.truncated ? { truncated: true } : {})
    })
  }
  return entries.length > 0 ? buildComposerFileContextPrompt(userPrompt, entries) : userPrompt
}
