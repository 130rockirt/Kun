import {
  projectFocusedDocument,
  writeDocumentKey
} from './write-editor-layout'
import { emptySelection } from './write-workspace-store-helpers'
import type {
  WriteWorkspaceGet,
  WriteWorkspaceSet,
  WriteWorkspaceState
} from './write-workspace-store-types'

type SpreadsheetActions = Pick<
  WriteWorkspaceState,
  'convertSpreadsheet' | 'reloadSpreadsheetConflict'
>

export function createWriteSpreadsheetActions(
  set: WriteWorkspaceSet,
  get: WriteWorkspaceGet
): SpreadsheetActions {
  return {
    convertSpreadsheet: async (workspaceRoot, path) => {
      const key = writeDocumentKey(path)
      const document = get().documentsByPath[key]
      if (document?.kind !== 'office' || document.officePreview?.sourceFormat !== 'xls') return null
      patchDocument(set, key, (latest) => ({
        ...latest,
        officeLoading: true,
        officeRefreshError: null,
        fileError: null
      }))
      let result: Awaited<ReturnType<typeof window.kunGui.convertWorkspaceSpreadsheet>>
      try {
        result = await window.kunGui.convertWorkspaceSpreadsheet({
          path,
          workspaceRoot,
          expectedSha256: document.officePreview.sourceSha256
        })
      } catch (error) {
        result = {
          ok: false,
          code: 'conversion_failed',
          message: error instanceof Error ? error.message : String(error)
        }
      }
      if (!result.ok) {
        patchDocument(set, key, (latest) => ({
          ...latest,
          officeLoading: false,
          officeRefreshError: result.message,
          fileError: result.message
        }))
        return null
      }
      patchDocument(set, key, (latest) => ({
        ...latest,
        officeLoading: false,
        officeRefreshError: null,
        fileError: null
      }))
      await get().refreshWorkspace(workspaceRoot)
      await get().openFile(workspaceRoot, result.path)
      return result.path
    },

    reloadSpreadsheetConflict: (path) => {
      const key = writeDocumentKey(path)
      set((state) => {
        const document = state.documentsByPath[key]
        const preview = document?.spreadsheetConflictPreview
        if (!document || document.kind !== 'office' || !preview) return {}
        const documentsByPath = {
          ...state.documentsByPath,
          [key]: {
            ...document,
            officePreview: preview,
            spreadsheetSourceSha256: preview.sourceSha256,
            spreadsheetMutations: [],
            spreadsheetUnsupportedReason: null,
            spreadsheetConflictPreview: null,
            spreadsheetCommitRevision: document.spreadsheetCommitRevision + 1,
            officeSemanticText: '',
            officeSemanticSha256: '',
            officeSemanticTruncated: false,
            selection: emptySelection(),
            saveStatus: 'saved' as const,
            fileError: null,
            officeRefreshError: null
          }
        }
        return { documentsByPath, ...projectFocusedDocument(state.editorLayout, documentsByPath) }
      })
    }
  }
}

function patchDocument(
  set: WriteWorkspaceSet,
  key: string,
  update: (document: WriteWorkspaceState['documentsByPath'][string]) => WriteWorkspaceState['documentsByPath'][string]
): void {
  set((state) => {
    const document = state.documentsByPath[key]
    if (!document) return {}
    const documentsByPath = { ...state.documentsByPath, [key]: update(document) }
    return { documentsByPath, ...projectFocusedDocument(state.editorLayout, documentsByPath) }
  })
}
