import type { UserFileReference } from '../../agent/types'
import { relativeWritePath } from '../../write/quoted-selection'

/** Turn the active Work document into a first-class runtime source. */
export function workbenchWriteSourceReference(
  workspaceRoot: string,
  activeFilePath: string | null
): UserFileReference | undefined {
  if (!activeFilePath) return undefined
  const relativePath = relativeWritePath(workspaceRoot, activeFilePath)
  return {
    path: activeFilePath,
    relativePath,
    name: relativePath.split('/').filter(Boolean).at(-1) ?? relativePath,
    kind: 'file'
  }
}
