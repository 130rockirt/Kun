import { officeDocumentFormatFromName } from '@shared/office-document'
import {
  isComposerDirectoryReference,
  type ComposerFileContextEntry
} from '../../lib/composer-file-references'
import { loadWorkspaceDirectoryContextFiles } from '../../lib/workspace-file-index'
import type { ComposerFileReference } from '../chat/FloatingComposer'
import {
  COMPOSER_DIRECTORY_CONTEXT_MAX_FILES,
  COMPOSER_FILE_CONTEXT_MAX_TOTAL_CHARS,
  clipComposerFileContext,
  composerToolReferencePlaceholder
} from './workbench-composer-prompts'

export async function readWorkbenchComposerFileContextEntries(
  references: ComposerFileReference[],
  workspace: string,
  translate: (key: string, options?: Record<string, unknown>) => string
): Promise<ComposerFileContextEntry[]> {
  const entries: ComposerFileContextEntry[] = []
  const seen = new Set<string>()
  let remainingChars = COMPOSER_FILE_CONTEXT_MAX_TOTAL_CHARS
  const contextKey = (path: string): string =>
    path.trim().replaceAll('\\', '/').replace(/\/+/g, '/').toLowerCase()

  const appendFileEntry = async (
    reference: ComposerFileReference,
    strict: boolean
  ): Promise<void> => {
    if (remainingChars <= 0) return
    const key = contextKey(reference.relativePath || reference.path)
    if (seen.has(key)) return
    const officeFormat = officeDocumentFormatFromName(reference.name || reference.path)
    if (officeFormat) {
      appendPlaceholder(reference, key, composerToolReferencePlaceholder(reference, officeFormat))
      return
    }
    const result = await window.kunGui.readWorkspaceFile({
      ...(reference.workspaceRoot === null
        ? {}
        : { workspaceRoot: reference.workspaceRoot || workspace }),
      path: reference.workspaceRoot === null
        ? reference.path
        : (reference.relativePath || reference.path)
    })
    if (!result.ok) {
      if (!strict) return
      if (/binary|cannot be previewed|too large|only supports text/i.test(result.message)) {
        appendPlaceholder(reference, key, composerToolReferencePlaceholder(reference))
        return
      }
      throw new Error(translate('composerFileReadFailed', {
        path: reference.relativePath,
        message: result.message
      }))
    }
    seen.add(key)
    const clipped = clipComposerFileContext(result.content, remainingChars, result.truncated)
    remainingChars -= clipped.consumed
    entries.push({
      relativePath: reference.relativePath,
      content: clipped.content,
      ...(clipped.truncated ? { truncated: true } : {})
    })
  }

  const appendPlaceholder = (
    reference: ComposerFileReference,
    key: string,
    content: string
  ): void => {
    const clipped = clipComposerFileContext(content, remainingChars, false)
    remainingChars -= clipped.consumed
    seen.add(key)
    entries.push({
      relativePath: reference.relativePath,
      content: clipped.content,
      ...(clipped.truncated ? { truncated: true } : {})
    })
  }

  for (const reference of references) {
    if (remainingChars <= 0) break
    if (isComposerDirectoryReference(reference)) {
      const directoryWorkspace = reference.workspaceRoot || workspace
      const directoryFiles = await loadWorkspaceDirectoryContextFiles(
        directoryWorkspace,
        reference.relativePath,
        COMPOSER_DIRECTORY_CONTEXT_MAX_FILES
      ).catch(() => [])
      for (const file of directoryFiles) {
        if (remainingChars <= 0) break
        await appendFileEntry({ ...file, workspaceRoot: directoryWorkspace }, false)
      }
      continue
    }
    await appendFileEntry(reference, true)
  }
  return entries
}
