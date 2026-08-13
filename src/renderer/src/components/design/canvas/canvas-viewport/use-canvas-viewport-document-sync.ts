import { useEffect, useMemo, useState } from 'react'
import {
  buildDesignArtifactSyncKey,
  removedLinkedArtifactReferences,
  syncDesignArtifactsToBoardDocument,
  syncDesignArtifactFrameNodesToArtifacts
} from '../../../../design/design-board-svg'
import { currentHtmlVersionId } from '../../../../design/design-board'
import type { DesignTarget } from '../../../../design/design-context'
import type { DesignArtifact } from '../../../../design/design-types'
import type { CanvasDocument, Rect } from '../../../../design/canvas/canvas-types'
import { createEmptyDocument } from '../../../../design/canvas/canvas-types'
import {
  loadCanvasDocument,
  persistCanvasDocument
} from '../../../../design/canvas/canvas-persistence'
import { getCanvasDocumentContentBounds } from '../../../../design/canvas/canvas-placement'
import { useCanvasSelectionStore } from '../../../../design/canvas/canvas-selection-store'
import { useCanvasShapeStore } from '../../../../design/canvas/canvas-shape-store'
import { useCanvasUndoStore } from '../../../../design/canvas/canvas-undo-store'
import { useCanvasViewportStore } from '../../../../design/canvas/canvas-viewport-store'
import { loadDesignSystem, persistDesignSystem } from '../../../../design/canvas/design-system-persistence'
import { useDesignSystemStore } from '../../../../design/canvas/design-system-store'
import { createEmptyDesignSystem } from '../../../../design/canvas/design-system-types'
import { useDesignWorkspaceStore } from '../../../../design/design-workspace-store'
import {
  boundsForShapeIds,
  mergeLoadedCanvasDocumentWithLiveChanges,
  readStoredCanvasViewport,
  resolveCanvasSelectionAfterDocumentSync,
  shouldResetCanvasTransientInteractionAfterDocumentSync,
  writeStoredCanvasViewport
} from './helpers'

type UseCanvasViewportDocumentSyncArgs = {
  workspaceRoot: string
  artifactId: string
  baseDir?: string
  resolvedDesignSystemBaseDir?: string
  viewportStorageKey: string
  documentKey: string
  htmlFrameSyncEnabled: boolean
  designArtifacts: DesignArtifact[]
  designTarget?: DesignTarget
  designSystemPersistenceEnabled?: boolean
  persistenceEnabled?: boolean
}

export const CANVAS_DOCUMENT_LOAD_TIMEOUT_MS = 4_000

export type CanvasDocumentLoadOutcome =
  | { status: 'resolved'; document: CanvasDocument | null }
  | { status: 'rejected'; document: null }
  | { status: 'timeout'; document: null }

/**
 * Workspace reads normally resolve immediately, but an interrupted IPC request
 * must not leave a historical board in its loading state forever.
 */
export function loadCanvasDocumentWithinDeadline(
  load: () => Promise<CanvasDocument | null>,
  timeoutMs = CANVAS_DOCUMENT_LOAD_TIMEOUT_MS
): Promise<CanvasDocumentLoadOutcome> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (outcome: CanvasDocumentLoadOutcome): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(outcome)
    }
    const timer = setTimeout(
      () => finish({ status: 'timeout', document: null }),
      Math.max(0, timeoutMs)
    )
    Promise.resolve()
      .then(load)
      .then((document) => finish({ status: 'resolved', document }))
      .catch(() => finish({ status: 'rejected', document: null }))
  })
}

function focusBoundsToFitLater(bounds: Rect | null, cancelled: () => boolean): number {
  if (!bounds) return 0
  return requestAnimationFrame(() => {
    if (!cancelled()) {
      useCanvasViewportStore.getState().zoomToFit(bounds, 72, { maxZoom: 1, minZoom: 0.04 })
    }
  })
}

function scheduleArtifactFrameNodeSync(
  doc: CanvasDocument,
  currentTimer: ReturnType<typeof setTimeout> | null,
  setTimer: (timer: ReturnType<typeof setTimeout> | null) => void,
  cancelled: () => boolean
): ReturnType<typeof setTimeout> {
  if (currentTimer) clearTimeout(currentTimer)
  const timer = setTimeout(() => {
    setTimer(null)
    if (!cancelled()) syncDesignArtifactFrameNodesToArtifacts(doc)
  }, 180)
  setTimer(timer)
  return timer
}

export function useCanvasViewportDocumentSync({
  workspaceRoot,
  artifactId,
  baseDir,
  resolvedDesignSystemBaseDir,
  viewportStorageKey,
  documentKey,
  htmlFrameSyncEnabled,
  designArtifacts,
  designTarget,
  designSystemPersistenceEnabled = true,
  persistenceEnabled = true
}: UseCanvasViewportDocumentSyncArgs): boolean {
  const [docLoaded, setDocLoaded] = useState(false)

  useEffect(() => {
    if (!artifactId || !workspaceRoot) {
      setDocLoaded(false)
      return
    }

    let cancelled = false
    let applyingDocumentLoad = false
    let viewFrame = 0
    let nodeSyncTimer: ReturnType<typeof setTimeout> | null = null
    const isCancelled = (): boolean => cancelled
    const setNodeSyncTimer = (timer: ReturnType<typeof setTimeout> | null): void => {
      nodeSyncTimer = timer
    }
    setDocLoaded(false)

    useCanvasSelectionStore.getState().clearSelection()
    useCanvasSelectionStore.getState().setMarquee(null)
    useCanvasSelectionStore.getState().setHoverTarget(null)
    const initialDocument = createEmptyDocument()
    useCanvasShapeStore.getState().loadDocument(initialDocument, documentKey)
    useCanvasViewportStore.getState().resetView()
    useCanvasUndoStore.getState().clear()

    void (async () => {
      try {
        const outcome = await loadCanvasDocumentWithinDeadline(
          () => loadCanvasDocument(workspaceRoot, artifactId, baseDir)
        )
        if (cancelled) return
        const loaded = outcome.document
        const currentShapeState = useCanvasShapeStore.getState()
        const liveDocument = currentShapeState.documentKey === documentKey
          ? currentShapeState.document
          : initialDocument
        let doc = mergeLoadedCanvasDocumentWithLiveChanges(
          loaded ?? createEmptyDocument(),
          liveDocument,
          initialDocument
        )
        let addedFrameIds: string[] = []
        if (htmlFrameSyncEnabled && persistenceEnabled) {
          const synced = syncDesignArtifactsToBoardDocument(doc, useDesignWorkspaceStore.getState().artifacts)
          doc = synced.document
          addedFrameIds = synced.addedFrameIds
          if (
            outcome.status === 'resolved' &&
            (synced.addedFrameIds.length > 0 || synced.updatedFrameIds.length > 0 || synced.removedFrameIds.length > 0)
          ) {
            persistCanvasDocument(workspaceRoot, artifactId, doc, baseDir)
          }
        }
        applyingDocumentLoad = true
        useCanvasShapeStore.getState().loadDocument(doc, documentKey)
        applyingDocumentLoad = false
        const storedView = readStoredCanvasViewport(viewportStorageKey)
        if (storedView) {
          useCanvasViewportStore.getState().setVbox(storedView)
        } else if (addedFrameIds.length > 0) {
          viewFrame = focusBoundsToFitLater(boundsForShapeIds(doc, addedFrameIds), isCancelled)
        } else if (loaded) {
          viewFrame = focusBoundsToFitLater(getCanvasDocumentContentBounds(doc), isCancelled)
        }
        if (outcome.status !== 'resolved') {
          useDesignWorkspaceStore.getState().setFileError(
            outcome.status === 'timeout'
              ? 'Design board loading timed out; reconstructed the board from its artifacts.'
              : 'Design board could not be loaded; reconstructed the board from its artifacts.'
          )
        }
      } catch (error) {
        if (cancelled) return
        applyingDocumentLoad = true
        useCanvasShapeStore.getState().loadDocument(initialDocument, documentKey)
        applyingDocumentLoad = false
        useDesignWorkspaceStore.getState().setFileError(
          error instanceof Error ? error.message : String(error)
        )
      } finally {
        applyingDocumentLoad = false
        if (!cancelled) setDocLoaded(true)
      }
    })()

    if (designSystemPersistenceEnabled) {
      void loadDesignSystem(workspaceRoot, resolvedDesignSystemBaseDir).then((system) => {
        if (cancelled) return
        useDesignSystemStore.getState().loadSystem(system ?? createEmptyDesignSystem())
      })
    }

    const unsubscribe = persistenceEnabled
      ? useCanvasShapeStore.subscribe((state, prev) => {
      if (cancelled || applyingDocumentLoad) return
      if (state.document === prev.document) return
      persistCanvasDocument(workspaceRoot, artifactId, state.document, baseDir)
      if (!htmlFrameSyncEnabled) return

      const removedReferences = removedLinkedArtifactReferences(prev.document, state.document)
      if (removedReferences.length > 0) {
        const designStore = useDesignWorkspaceStore.getState()
        const fileArtifacts = new Map(
          designStore.artifacts
            .filter((item) => item.kind === 'html' || item.kind === 'svg')
            .map((item) => [item.id, item])
        )
        for (const reference of removedReferences) {
          const artifact = fileArtifacts.get(reference.artifactId)
          if (!artifact) continue
          if (reference.kind === 'svg') {
            // SVG stays one-to-one: hiding the artifact hides its only frame.
            if (artifact.node?.boardHidden !== true) {
              designStore.updateArtifactNode(reference.artifactId, { boardHidden: true })
            }
            continue
          }
          // HTML frames are per-version; tombstone only the deleted version so
          // the remaining version frames stay and future versions can appear.
          // Legacy frames without a version stamp map to the current version.
          const versionId = reference.versionId ?? currentHtmlVersionId(artifact)
          const hidden = artifact.node?.boardHiddenVersionIds ?? []
          if (!hidden.includes(versionId)) {
            designStore.updateArtifactNode(reference.artifactId, {
              boardHiddenVersionIds: [...hidden, versionId]
            })
          }
        }
      }
      scheduleArtifactFrameNodeSync(state.document, nodeSyncTimer, setNodeSyncTimer, isCancelled)
        })
      : () => undefined

    const unsubscribeDesignSystem = useDesignSystemStore.subscribe((state, prev) => {
      if (cancelled || !designSystemPersistenceEnabled || !persistenceEnabled) return
      if (state.system === prev.system) return
      persistDesignSystem(workspaceRoot, state.system, resolvedDesignSystemBaseDir)
    })

    return () => {
      cancelled = true
      if (viewFrame) cancelAnimationFrame(viewFrame)
      if (nodeSyncTimer) clearTimeout(nodeSyncTimer)
      unsubscribe()
      unsubscribeDesignSystem()
    }
  }, [workspaceRoot, artifactId, baseDir, designSystemPersistenceEnabled, documentKey, htmlFrameSyncEnabled, persistenceEnabled, resolvedDesignSystemBaseDir, viewportStorageKey])

  const designArtifactSyncKey = useMemo(() => {
    if (!htmlFrameSyncEnabled) return ''
    return buildDesignArtifactSyncKey(designArtifacts, designTarget)
  }, [designArtifacts, designTarget, htmlFrameSyncEnabled])

  useEffect(() => {
    if (!persistenceEnabled || !docLoaded || !htmlFrameSyncEnabled || !artifactId || !workspaceRoot) return
    const current = useCanvasShapeStore.getState().document
    const synced = syncDesignArtifactsToBoardDocument(current, useDesignWorkspaceStore.getState().artifacts)
    if (
      synced.addedFrameIds.length === 0 &&
      synced.updatedFrameIds.length === 0 &&
      synced.removedFrameIds.length === 0
    ) return
    useCanvasShapeStore.getState().loadDocument(synced.document, documentKey)
    if (synced.removedFrameIds.length > 0) {
      const selection = useCanvasSelectionStore.getState()
      if (shouldResetCanvasTransientInteractionAfterDocumentSync(synced.removedFrameIds)) {
        selection.setMarquee(null)
        selection.setSnapGuides([])
      }
      const nextSelection = resolveCanvasSelectionAfterDocumentSync(synced.document, selection)
      if (nextSelection.selectedIds.length !== selection.selectedIds.size) {
        selection.select(nextSelection.selectedIds)
      }
      const afterSelection = useCanvasSelectionStore.getState()
      if (afterSelection.hoverTargetId !== nextSelection.hoverTargetId) {
        afterSelection.setHoverTarget(nextSelection.hoverTargetId)
      }
      if (afterSelection.editingId !== nextSelection.editingId) {
        afterSelection.setEditing(nextSelection.editingId)
      }
    }
    persistCanvasDocument(workspaceRoot, artifactId, synced.document, baseDir)
    if (synced.addedFrameIds.length > 0) {
      const bounds = boundsForShapeIds(synced.document, synced.addedFrameIds)
      if (bounds) useCanvasViewportStore.getState().zoomToFit(bounds, 72, { maxZoom: 1, minZoom: 0.04 })
    }
  }, [artifactId, baseDir, designArtifactSyncKey, docLoaded, documentKey, htmlFrameSyncEnabled, persistenceEnabled, workspaceRoot])

  useEffect(() => {
    if (!docLoaded || !artifactId || !workspaceRoot) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const unsubscribe = useCanvasViewportStore.subscribe((state, prev) => {
      if (state.vbox === prev.vbox) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        writeStoredCanvasViewport(viewportStorageKey, useCanvasViewportStore.getState().vbox)
      }, 250)
    })
    return () => {
      if (timer) clearTimeout(timer)
      unsubscribe()
    }
  }, [artifactId, docLoaded, viewportStorageKey, workspaceRoot])

  return docLoaded
}
