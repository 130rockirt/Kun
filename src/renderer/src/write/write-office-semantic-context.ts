import { relativeWritePath, type WriteOfficeDocumentContext } from './quoted-selection'
import { writeDocumentKey } from './write-editor-layout'
import { useWriteWorkspaceStore } from './write-workspace-store'

type LoadWriteOfficeSemanticContextResult =
  | { ok: true; context: WriteOfficeDocumentContext }
  | { ok: false; stale: boolean; message?: string }

export async function loadWriteOfficeSemanticContext(options: {
  path: string
  workspaceRoot: string
  expectedSha256: string
  contextStillMatches: () => boolean
}): Promise<LoadWriteOfficeSemanticContextResult> {
  const key = writeDocumentKey(options.path)
  const initial = useWriteWorkspaceStore.getState().documentsByPath[key]
  if (
    initial?.kind !== 'office' ||
    !initial.officePreview ||
    initial.officePreview.sourceSha256 !== options.expectedSha256
  ) {
    return { ok: false, stale: false, message: 'The Office preview is not ready. Wait for it to finish loading, then try again.' }
  }

  let text = initial.officeSemanticSha256 === options.expectedSha256
    ? initial.officeSemanticText
    : ''
  let truncated = initial.officeSemanticSha256 === options.expectedSha256
    ? initial.officeSemanticTruncated
    : false
  if (!text) {
    if (typeof window.kunGui?.readWorkspaceOfficeSemantic !== 'function') {
      return { ok: false, stale: false, message: 'Office document analysis is unavailable in this app build.' }
    }
    const semantic = await window.kunGui.readWorkspaceOfficeSemantic({
      path: options.path,
      workspaceRoot: options.workspaceRoot,
      expectedSha256: options.expectedSha256
    }).catch((error: unknown) => ({
      ok: false as const,
      message: error instanceof Error ? error.message : String(error)
    }))
    if (!semantic.ok) {
      return { ok: false, stale: false, message: `Could not analyze this Office document: ${semantic.message}` }
    }
    if (!options.contextStillMatches()) return { ok: false, stale: true }
    const current = useWriteWorkspaceStore.getState().documentsByPath[key]
    if (
      current?.kind !== 'office' ||
      current.officePreview?.sourceSha256 !== semantic.sourceSha256
    ) return { ok: false, stale: true }
    text = semantic.text
    truncated = semantic.truncated
    useWriteWorkspaceStore.setState((state) => {
      const document = state.documentsByPath[key]
      if (
        document?.kind !== 'office' ||
        document.officePreview?.sourceSha256 !== semantic.sourceSha256
      ) return {}
      return {
        documentsByPath: {
          ...state.documentsByPath,
          [key]: {
            ...document,
            officeSemanticText: semantic.text,
            officeSemanticSha256: semantic.sourceSha256,
            officeSemanticTruncated: semantic.truncated
          }
        }
      }
    })
  }

  return {
    ok: true,
    context: {
      sourceTitle: relativeWritePath(options.workspaceRoot, options.path),
      sourceFilePath: options.path,
      sourceFormat: initial.officePreview.sourceFormat,
      sourceSha256: options.expectedSha256,
      text,
      truncated
    }
  }
}

export function writeOfficeSemanticContextMatches(context: WriteOfficeDocumentContext): boolean {
  const document = useWriteWorkspaceStore.getState().documentsByPath[
    writeDocumentKey(context.sourceFilePath)
  ]
  return document?.kind === 'office' &&
    document.officePreview?.sourceSha256 === context.sourceSha256
}
