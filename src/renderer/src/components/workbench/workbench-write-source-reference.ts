import type { UserFileReference } from '../../agent/types'
import { relativeWritePath } from '../../write/quoted-selection'
import type { WriteActiveFileKind } from '../../write/write-workspace-store-types'
import { activeWriteResourceReference } from './workbench-write-resource-context'

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

export function workbenchWriteSourceContext(
  workspaceRoot: string,
  activeFilePath: string | null,
  activeFileKind: WriteActiveFileKind | null,
  sourceFormat?: string
) {
  return {
    activeResource: activeWriteResourceReference(
      workspaceRoot, activeFilePath, activeFileKind, sourceFormat
    ),
    fileReference: workbenchWriteSourceReference(workspaceRoot, activeFilePath)
  }
}
