import { useMemo, useRef, type MutableRefObject, type ReactElement, type RefObject } from 'react'
import type { WriteInlineCompletionSettingsV1 } from '@shared/app-settings'
import type {
  WorkspacePresentationViewReference,
  WorkspacePresentationViewSource
} from '@shared/office-document'
import { useTranslation } from 'react-i18next'
import type {
  WriteDocumentSession,
  WritePreviewMode
} from '../../write/write-workspace-store'
import { getWriteRenderSafety } from '../../write/write-render-safety'
import type { WriteRecentEdit } from '../../write/recent-edits'
import type { WriteRichEditorHandle } from '../../write/tiptap/WriteRichEditor'
import type { WriteEditorSelectionState, WriteMarkdownEditorHandle } from './WriteMarkdownEditor'
import { WriteWorkspaceDocumentPane } from './WriteWorkspaceDocumentPane'
import {
  isMarkdownFile,
  useDebouncedValue,
  writePreviewDebounceMs
} from './write-workspace-view-utils'

type Props = {
  document: WriteDocumentSession | undefined
  requestedPath: string | null
  viewMode: WritePreviewMode
  workspaceRoot: string
  workspaceName: string
  workspacePathLabel: string
  workspaceError?: string | null
  inlineCompletion: WriteInlineCompletionSettingsV1
  inlineCompletionApiReady: boolean
  recentEdits: WriteRecentEdit[]
  focused: boolean
  focusMode: boolean
  richHandleRef?: MutableRefObject<WriteRichEditorHandle | null>
  markdownHandleRef?: MutableRefObject<WriteMarkdownEditorHandle | null>
  editorPaneRef?: RefObject<HTMLDivElement | null>
  onFocusModeChange: (active: boolean) => void
  onFocus: () => void
  onAskAssistant: (prompt: string) => void
  onCreateDraft: () => void
  onPickWorkspace: () => void
  onRefreshWorkspace: () => void
  onContentChange: (content: string) => void
  onDocumentEdit: (edits: WriteRecentEdit[]) => void
  onSelectionChange: (selection: WriteEditorSelectionState) => void
  onSaveShortcut: () => void
  onImagePasteSaved: () => void
  onImagePasteError: (message: string) => void
  onPresentationViewChange: (
    view: WorkspacePresentationViewReference | null,
    source: WorkspacePresentationViewSource
  ) => void
  onReviewStateChange: (active: boolean) => void
  onboarding?: boolean
  workspaceLoading?: boolean
}

export function WriteEditorGroupContent({
  document,
  requestedPath,
  viewMode,
  workspaceRoot,
  workspaceName,
  workspacePathLabel,
  workspaceError,
  inlineCompletion,
  inlineCompletionApiReady,
  recentEdits,
  focused,
  focusMode,
  richHandleRef,
  markdownHandleRef,
  editorPaneRef,
  onFocusModeChange,
  onFocus,
  onAskAssistant,
  onCreateDraft,
  onPickWorkspace,
  onRefreshWorkspace,
  onContentChange,
  onDocumentEdit,
  onSelectionChange,
  onSaveShortcut,
  onImagePasteSaved,
  onImagePasteError,
  onPresentationViewChange,
  onReviewStateChange,
  onboarding,
  workspaceLoading
}: Props): ReactElement {
  const { t } = useTranslation('common')
  const localRichRef = useRef<WriteRichEditorHandle | null>(null)
  const localMarkdownRef = useRef<WriteMarkdownEditorHandle | null>(null)
  const localEditorPaneRef = useRef<HTMLDivElement | null>(null)
  const previewPaneRef = useRef<HTMLDivElement | null>(null)
  const path = document?.path ?? requestedPath
  const kind = document?.kind ?? null
  const content = document?.fileContent ?? ''
  const markdown = path && kind === 'text' ? isMarkdownFile(path) : true
  const renderSafety = getWriteRenderSafety({
    isMarkdown: markdown,
    contentLength: content.length,
    fileSize: document?.fileSize ?? 0,
    truncated: document?.fileTruncated ?? false
  })
  const debounced = useDebouncedValue(content, writePreviewDebounceMs(content.length))
  const richModeActive = viewMode === 'rich' && markdown && renderSafety.livePreviewEnabled && kind === 'text'
  const editorVisible = kind === 'text' && viewMode !== 'preview'
  const previewVisible = kind === 'text' && viewMode === 'preview'
  const editorAppearance = viewMode === 'source' || !renderSafety.livePreviewEnabled ? 'source' : 'live'
  const fileGuardMessage = renderSafety.notice === 'truncated'
    ? t('writeLargeFileTruncated')
    : renderSafety.notice === 'large-file' ? t('writeLargeFileSafeMode') : ''
  const fileGuardDetail = renderSafety.notice === 'large-file' ? t('writeLargeFileSafeModeSub') : ''
  const resolvedEditorPaneRef = editorPaneRef ?? localEditorPaneRef
  const resolvedRichRef = richHandleRef ?? localRichRef
  const resolvedMarkdownRef = markdownHandleRef ?? localMarkdownRef

  const stableRecentEdits = useMemo(() => recentEdits, [recentEdits])

  return (
    <div className="min-h-0 min-w-0 flex-1" onPointerDown={onFocus}>
      <WriteWorkspaceDocumentPane
        activeFilePath={path}
        documentEpoch={document?.documentEpoch ?? 0}
        activeFileIsImage={kind === 'image'}
        activeFileIsPdf={kind === 'pdf'}
        activeFileIsOffice={kind === 'office'}
        activeFileIsText={kind === 'text'}
        fileLoading={Boolean(requestedPath && !document) || document?.fileLoading === true}
        fileContent={content}
        imageDataUrl={document?.imageDataUrl ?? ''}
        imageMimeType={document?.imageMimeType ?? ''}
        pdfDataBase64={document?.pdfDataBase64 ?? ''}
        pdfMimeType={document?.pdfMimeType ?? ''}
        pdfMtimeMs={document?.pdfMtimeMs ?? 0}
        officePreview={document?.officePreview ?? null}
        officeLoading={document?.officeLoading ?? false}
        officeRefreshError={document?.officeRefreshError ?? null}
        officeAgentEditing={document?.officeAgentEditing ?? false}
        fileSize={document?.fileSize ?? 0}
        workspaceRoot={workspaceRoot}
        workspaceName={workspaceName}
        workspacePathLabel={workspacePathLabel}
        workspaceError={workspaceError}
        renderSafety={renderSafety}
        fileGuardMessage={fileGuardMessage}
        fileGuardDetail={fileGuardDetail}
        editorVisible={editorVisible}
        previewVisible={previewVisible}
        editorWidth="min-w-0 flex-1"
        previewWidth="min-w-0 flex-1"
        editorAppearance={editorAppearance}
        richModeActive={richModeActive}
        richHandleRef={resolvedRichRef}
        markdownHandleRef={resolvedMarkdownRef}
        onMarkdownReviewStateChange={onReviewStateChange}
        focusMode={focused && focusMode}
        onFocusModeChange={onFocusModeChange}
        onboarding={onboarding}
        workspaceLoading={workspaceLoading}
        debouncedPreviewContent={debounced}
        isMarkdown={markdown}
        inlineCompletion={inlineCompletion}
        inlineCompletionApiReady={inlineCompletionApiReady}
        recentEdits={stableRecentEdits}
        focused={focused}
        editorPaneRef={resolvedEditorPaneRef}
        previewPaneRef={previewPaneRef}
        onAskAssistant={onAskAssistant}
        onCreateDraft={onCreateDraft}
        onPickWorkspace={onPickWorkspace}
        onRefreshWorkspace={onRefreshWorkspace}
        onContentChange={onContentChange}
        onDocumentEdit={onDocumentEdit}
        onSelectionChange={onSelectionChange}
        onSaveShortcut={onSaveShortcut}
        onImagePasteSaved={onImagePasteSaved}
        onImagePasteError={onImagePasteError}
        onPresentationViewChange={onPresentationViewChange}
      />
    </div>
  )
}
