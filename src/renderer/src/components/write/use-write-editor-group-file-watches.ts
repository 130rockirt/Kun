import { useEffect } from 'react'
import i18n from '../../i18n'
import {
  projectFocusedDocument,
  writeDocumentKey
} from '../../write/write-editor-layout'
import { startWriteWorkspaceFileWatch } from '../../write/write-file-watch'
import { isWriteWorkspaceSaveContentPending } from '../../write/write-save-coordinator'
import {
  useWriteWorkspaceStore,
  type WriteEditorLayoutV1
} from '../../write/write-workspace-store'

type Options = {
  workspaceRoot: string
  editorLayout: WriteEditorLayoutV1
}

export function useWriteEditorGroupFileWatches({ workspaceRoot, editorLayout }: Options): void {
  const visibleKey = editorLayout.groups
    .map((group) => group.activePath ?? '')
    .filter(Boolean)
    .sort()
    .join('\0')

  useEffect(() => {
    if (!workspaceRoot.trim()) return
    if (
      typeof window.kunGui?.watchWorkspaceFile !== 'function' ||
      typeof window.kunGui?.unwatchWorkspaceFile !== 'function' ||
      typeof window.kunGui?.onWorkspaceFileChanged !== 'function'
    ) return

    const state = useWriteWorkspaceStore.getState()
    const paths = [...new Set(state.editorLayout.groups.map((group) => group.activePath).filter((path): path is string => Boolean(path)))]
    const cleanups = paths.flatMap((path) => {
      const document = state.documentsByPath[writeDocumentKey(path)]
      if (!document || document.kind === 'pdf') return []
      return [startWriteWorkspaceFileWatch({
        api: window.kunGui,
        workspaceRoot,
        path,
        kind: document.kind === 'image' ? 'image' : 'text',
        onTextSnapshot: (snapshot) => {
          useWriteWorkspaceStore.setState((current) => {
            const key = writeDocumentKey(path)
            const latest = current.documentsByPath[key]
            if (!latest || latest.kind !== 'text') return {}
            if (snapshot.message) {
              const documentsByPath = {
                ...current.documentsByPath,
                [key]: { ...latest, fileError: snapshot.message, saveStatus: 'error' as const }
              }
              return { documentsByPath, ...projectFocusedDocument(current.editorLayout, documentsByPath) }
            }
            if (typeof snapshot.content !== 'string') return {}
            const content = snapshot.content
            if (isWriteWorkspaceSaveContentPending(workspaceRoot, path, content)) return {}
            const dirty = latest.fileContent !== latest.persistedContent
            if (dirty && content !== latest.persistedContent && content !== latest.fileContent) {
              const documentsByPath = {
                ...current.documentsByPath,
                [key]: {
                  ...latest,
                  persistedContent: content,
                  pendingAgentReview: {
                    workspaceRoot,
                    filePath: path,
                    documentEpoch: latest.documentEpoch,
                    nextContent: content
                  },
                  reviewActive: true,
                  fileError: i18n.t('common:writeExternalChangeConflict')
                }
              }
              return { documentsByPath, ...projectFocusedDocument(current.editorLayout, documentsByPath) }
            }
            const documentsByPath = {
              ...current.documentsByPath,
              [key]: {
                ...latest,
                fileContent: dirty ? latest.fileContent : content,
                persistedContent: content,
                fileSize: snapshot.size ?? content.length,
                fileTruncated: snapshot.truncated === true,
                saveStatus: dirty && latest.fileContent !== content ? 'dirty' as const : 'saved' as const,
                fileError: null
              }
            }
            return { documentsByPath, ...projectFocusedDocument(current.editorLayout, documentsByPath) }
          })
        },
        onImageChanged: () => {
          void window.kunGui.readWorkspaceImage({ path, workspaceRoot }).then((result) => {
            if (!result.ok) return
            useWriteWorkspaceStore.setState((current) => {
              const key = writeDocumentKey(path)
              const latest = current.documentsByPath[key]
              if (!latest || latest.kind !== 'image') return {}
              const documentsByPath = {
                ...current.documentsByPath,
                [key]: {
                  ...latest,
                  imageDataUrl: result.dataUrl,
                  imageMimeType: result.mimeType,
                  fileSize: result.size,
                  fileError: null
                }
              }
              return { documentsByPath, ...projectFocusedDocument(current.editorLayout, documentsByPath) }
            })
          })
        },
        onError: (message) => {
          useWriteWorkspaceStore.setState((current) => {
            const key = writeDocumentKey(path)
            const latest = current.documentsByPath[key]
            if (!latest) return {}
            const documentsByPath = { ...current.documentsByPath, [key]: { ...latest, fileError: message } }
            return { documentsByPath, ...projectFocusedDocument(current.editorLayout, documentsByPath) }
          })
        }
      })]
    })
    return () => cleanups.forEach((cleanup) => cleanup())
  }, [visibleKey, workspaceRoot])
}
