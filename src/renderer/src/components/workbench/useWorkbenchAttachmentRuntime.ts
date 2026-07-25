import { useCallback, useEffect, useRef, useState } from 'react'
import type { CoreRuntimeInfoJson } from '../../agent/kun-contract'
import type { NormalizedThread, RuntimeConnectionStatus } from '../../agent/types'
import type { CanvasDocument } from '../../design/canvas/canvas-types'
import { useDesignWorkspaceStore } from '../../design/design-workspace-store'
import { isChatAttachmentUploadEnabled } from '../../lib/attachment-upload-availability'
import { useSddDraftStore } from '../../sdd/sdd-draft-store'
import { useWriteWorkspaceStore } from '../../write/write-workspace-store'
import { useCanvasImageAutoAttachment } from '../design/useCanvasImageAutoAttachment'
import {
  composerAttachmentScopeForSurface,
  createEmptyComposerAttachmentsByScope,
  removeComposerAttachmentsById,
  updateComposerAttachmentsByScope,
  type ComposerAttachmentScope,
  type ComposerAttachmentUpdater
} from '../workbench-composer-attachments'
import { useWorkbenchAttachmentController } from './useWorkbenchAttachmentController'
import type { RightPanelMode } from '../chat/WorkbenchTopBar'
import { BUILTIN_RIGHT_PANEL_IDS } from '../../extensions/contribution-ids'
import type { ComposerFileReference } from '../chat/FloatingComposer'

type WorkbenchAttachmentRuntimeOptions = {
  activeThreadId: string | null
  canvasDocument: CanvasDocument
  canvasSelectedIds: ReadonlySet<string>
  composerMode: 'plan' | 'agent'
  modelUnsupportedMessage: string
  rightPanelMode: RightPanelMode | null
  route: string
  runtimeConnection: RuntimeConnectionStatus
  runtimeInfo: CoreRuntimeInfoJson | null
  selectedModelSupportsImageInput: boolean
  threads: NormalizedThread[]
  workspaceRoot: string
  onFallbackToFileReference?: (reference: ComposerFileReference) => void
}

export function useWorkbenchAttachmentRuntime({
  activeThreadId,
  canvasDocument,
  canvasSelectedIds,
  composerMode,
  modelUnsupportedMessage,
  rightPanelMode,
  route,
  runtimeConnection,
  runtimeInfo,
  selectedModelSupportsImageInput,
  threads,
  workspaceRoot,
  onFallbackToFileReference
}: WorkbenchAttachmentRuntimeOptions) {
  const [composerAttachmentsByScope, setComposerAttachmentsByScope] = useState(
    createEmptyComposerAttachmentsByScope
  )
  const [attachmentUploadBusy, setAttachmentUploadBusy] = useState(false)
  const [attachmentUploadError, setAttachmentUploadError] = useState<string | null>(null)
  const composerAttachmentScope = composerAttachmentScopeForSurface(route, rightPanelMode)
  const composerAttachmentScopeRef = useRef<ComposerAttachmentScope>(composerAttachmentScope)

  useEffect(() => {
    composerAttachmentScopeRef.current = composerAttachmentScope
  }, [composerAttachmentScope])

  const composerAttachments = composerAttachmentsByScope[composerAttachmentScope]
  const setComposerAttachmentsForScope = useCallback((
    scope: ComposerAttachmentScope,
    updater: ComposerAttachmentUpdater
  ): void => {
    setComposerAttachmentsByScope((current) => updateComposerAttachmentsByScope(current, scope, updater))
  }, [])
  const setComposerAttachments = useCallback((updater: ComposerAttachmentUpdater): void => {
    setComposerAttachmentsForScope(composerAttachmentScopeRef.current, updater)
  }, [setComposerAttachmentsForScope])
  const attachmentUploadEnabled = isChatAttachmentUploadEnabled({
    runtimeConnection,
    route,
    mode: composerMode,
    attachmentStoreAvailable: runtimeInfo?.capabilities.attachments.available,
    modelSupportsImageInput: selectedModelSupportsImageInput
  })
  const webAccessAvailable =
    runtimeInfo?.capabilities.web.fetch.available === true ||
    runtimeInfo?.capabilities.web.search.available === true

  useEffect(() => {
    setAttachmentUploadError((prev) => {
      if (prev !== modelUnsupportedMessage) return prev
      if (composerAttachments.length === 0 || selectedModelSupportsImageInput) return null
      return prev
    })
  }, [composerAttachments.length, modelUnsupportedMessage, selectedModelSupportsImageInput])

  useEffect(() => {
    setAttachmentUploadError(null)
  }, [composerAttachmentScope])

  const activeComposerWorkspace = (): string | undefined => {
    const sddDraft = useSddDraftStore.getState().activeDraft
    if (rightPanelMode === BUILTIN_RIGHT_PANEL_IDS.sddAi && sddDraft?.workspaceRoot) return sddDraft.workspaceRoot
    const designWorkspace = useDesignWorkspaceStore.getState().workspaceRoot
    if (route === 'design' && designWorkspace.trim()) return designWorkspace
    const writeWorkspace = useWriteWorkspaceStore.getState().workspaceRoot
    if (route === 'write' && writeWorkspace.trim()) return writeWorkspace
    return threads.find((thread) => thread.id === activeThreadId)?.workspace || workspaceRoot || undefined
  }

  const { clearAutoAttachment: clearCanvasImageAutoAttachment } = useCanvasImageAutoAttachment({
    route,
    selectedIds: canvasSelectedIds,
    document: canvasDocument,
    workspaceRoot,
    activeThreadId,
    attachmentCapabilities: runtimeInfo?.capabilities.attachments,
    setComposerAttachmentsForScope,
    getActiveWorkspace: activeComposerWorkspace
  })

  const clearComposerAttachments = (scope = composerAttachmentScopeRef.current): void => {
    setComposerAttachmentsForScope(scope, [])
    if (scope === 'design') clearCanvasImageAutoAttachment()
  }

  const removeComposerAttachments = (
    ids: readonly string[],
    scope = composerAttachmentScopeRef.current
  ): void => {
    if (ids.length === 0) return
    setComposerAttachmentsForScope(
      scope,
      (current) => removeComposerAttachmentsById(current, ids)
    )
  }

  const {
    handlePickAttachments,
    handlePasteClipboardImage,
    removeComposerAttachment
  } = useWorkbenchAttachmentController({
    attachmentUploadEnabled,
    selectedModelSupportsImageInput,
    attachmentCapabilities: runtimeInfo?.capabilities.attachments,
    activeThreadId,
    setAttachmentUploadBusy,
    setAttachmentUploadError,
    setComposerAttachmentsForScope,
    setComposerAttachments,
    getAttachmentScope: () => composerAttachmentScopeRef.current,
    getActiveWorkspace: activeComposerWorkspace,
    onFallbackToFileReference
  })

  return {
    attachmentUploadBusy,
    attachmentUploadEnabled,
    attachmentUploadError,
    clearComposerAttachments,
    composerAttachments,
    getAttachmentScope: () => composerAttachmentScopeRef.current,
    handlePasteClipboardImage,
    handlePickAttachments,
    removeComposerAttachments,
    removeComposerAttachment,
    setAttachmentUploadError,
    webAccessAvailable
  }
}
