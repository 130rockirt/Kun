import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { ArrowRight, FileText, Loader2, Palette, Save, Sparkles, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import { sddUnitImageDir, sddUnitProtoDir } from '@shared/sdd'
import { parseSddRequirementBlocks } from '@shared/sdd-trace'
import { WRITE_INFOGRAPHIC_MAX_TEXT_CHARS, type WriteInfographicKind } from '@shared/write-infographic'
import { WRITE_PROTOTYPE_MAX_TEXT_CHARS } from '@shared/write-prototype'
import { useSddTrace } from '../../sdd/use-sdd-trace'
import { useSddDraftStore, type SddDesignContext } from '../../sdd/sdd-draft-store'
import { SDD_DESIGN_TONE_OPTIONS } from '../../sdd/sdd-design-context'
import { saveActiveSddDraftToDisk, syncActiveSddDraftFromDisk } from '../../sdd/sdd-draft-actions'
import { buildSddPrototypeTurnPrompt } from '../../sdd/sdd-prototype-prompt'
import { useWriteWorkspaceStore } from '../../write/write-workspace-store'
import { startWriteWorkspaceFileWatch } from '../../write/write-file-watch'
import {
  applyWriteInlineEditReplacement,
  buildWriteInlineEditCompletionRequest,
  buildWriteInlineEditDraft
} from '../../write/inline-edit'
import { toggleWriteInlineFormat, type WriteInlineFormatKind } from '../../write/inline-format'
import type { WriteBlockType } from '../../write/block-type'
import { createWriteRecentEdit } from '../../write/recent-edits'
import { resolveWriteQuickActions, type ResolvedWriteQuickAction } from '../../write/quick-actions'
import {
  formatWriteQuotedSelectionForPrompt,
  quotedSelectionFromEditor
} from '../../write/quoted-selection'
import { parseImageMarkdownLine } from '../../write/selected-image'
import { resolveWriteMarkdownResourcePath } from '@shared/write-markdown-resource'
import {
  beginPendingInfographic,
  buildPendingInfographicMarkdown,
  finishPendingInfographic,
  lineEndAfter,
  replacePendingInfographicInText,
  type PendingInfographicKind
} from '../../write/infographic-pending'
import {
  WriteMarkdownEditor,
  type WriteMarkdownEditorHandle,
  type WriteSelectedImage
} from '../write/WriteMarkdownEditor'
import { WriteRichEditor, type WriteRichEditorHandle } from '../../write/tiptap/WriteRichEditor'
import { WriteInlineAgent } from '../write/WriteInlineAgent'
import {
  INLINE_EDIT_RECENT_CONTEXT_CHARS,
  inlineAgentPosition,
  WRITE_EXPORT_NOTICE_MS,
  type WriteNotice
} from '../write/write-workspace-view-utils'
import { SidebarTitlebarToggleButton } from '../sidebar/SidebarPrimitives'

export { SddAssistantToggleButton } from './SddDraftEditorParts'
import { SddDraftEditorContent } from './SddDraftEditorContent'
import { createSddDraftGenerationController } from './sdd-draft-generation-controller'
import {
  PROTOTYPE_POLL_INTERVAL_MS,
  PROTOTYPE_POLL_TIMEOUT_MS,
  SDD_AUTOSAVE_MS,
  designReferenceTextFromImage,
  randomPrototypeFileName,
  statusKey,
  type Props
} from './SddDraftEditorParts'
export function SddDraftEditorView({
  leftSidebarCollapsed,
  assistantOpen,
  onToggleLeftSidebar,
  onToggleAssistant,
  onAssistantQuote,
  onPrototypeTurn,
  onExploreInDesign,
  onNext,
  onClose,
  nextDisabled
}: Props): ReactElement {
  const { t } = useTranslation('common')
  const saveTimerRef = useRef<number | null>(null)
  const {
    activeDraft,
    content,
    saveStatus,
    operationStatus,
    error,
    setContent,
    setOperationStatus,
    updateDesignContext
  } = useSddDraftStore(
    useShallow((s) => ({
      activeDraft: s.activeDraft,
      content: s.content,
      saveStatus: s.saveStatus,
      operationStatus: s.operationStatus,
      error: s.error,
      setContent: s.setContent,
      setOperationStatus: s.setOperationStatus,
      updateDesignContext: s.updateDesignContext
    }))
  )
  const {
    inlineCompletion,
    inlineCompletionApiReady,
    selectionAssist,
    imageGenReady,
    prototypeReady,
    selection,
    recentEdits,
    loadWriteSettings,
    setSelection,
    recordRecentEdits
  } = useWriteWorkspaceStore(
    useShallow((s) => ({
      inlineCompletion: s.inlineCompletion,
      inlineCompletionApiReady: s.inlineCompletionApiReady,
      selectionAssist: s.selectionAssist,
      imageGenReady: s.imageGenReady,
      prototypeReady: s.prototypeReady,
      selection: s.selection,
      recentEdits: s.recentEdits,
      loadWriteSettings: s.loadWriteSettings,
      setSelection: s.setSelection,
      recordRecentEdits: s.recordRecentEdits
    }))
  )
  const editorPaneRef = useRef<HTMLDivElement | null>(null)
  const richHandleRef = useRef<WriteRichEditorHandle | null>(null)
  const markdownHandleRef = useRef<WriteMarkdownEditorHandle | null>(null)
  const inlineAgentTextareaRef = useRef<HTMLTextAreaElement | null>(null)
  const noticeTimerRef = useRef<number | null>(null)
  const [inlineAgentValue, setInlineAgentValue] = useState('')
  const [inlineEditInFlight, setInlineEditInFlight] = useState(false)
  const [pointerSelecting, setPointerSelecting] = useState(false)
  const [notice, setNotice] = useState<WriteNotice | null>(null)

  useEffect(() => {
    void loadWriteSettings()
  }, [loadWriteSettings])

  // The selection slice is shared with the write workspace view (they are
  // never mounted together); clear it on both ends so neither view shows a
  // toolbar anchored to the other's stale selection.
  useEffect(() => {
    const clear = (): void =>
      useWriteWorkspaceStore.getState().setSelection({ text: '', ranges: [], charCount: 0 })
    clear()
    return clear
  }, [])

  // Hide the toolbar while a pointer drag is selecting text inside the editor;
  // it reappears on pointer release once the selection has settled.
  useEffect(() => {
    const handleDown = (event: PointerEvent): void => {
      const target = event.target
      if (target instanceof Node && editorPaneRef.current?.contains(target)) {
        setPointerSelecting(true)
      }
    }
    const handleUp = (): void => setPointerSelecting(false)
    window.addEventListener('pointerdown', handleDown)
    window.addEventListener('pointerup', handleUp)
    window.addEventListener('pointercancel', handleUp)
    return () => {
      window.removeEventListener('pointerdown', handleDown)
      window.removeEventListener('pointerup', handleUp)
      window.removeEventListener('pointercancel', handleUp)
    }
  }, [])

  // Reset the AI-edit draft whenever the selection changes; the menu input is
  // always present and must not carry stale text over.
  useEffect(() => {
    setInlineAgentValue('')
  }, [selection.charCount, selection.text])

  useEffect(() => {
    if (!notice) return
    if (noticeTimerRef.current) window.clearTimeout(noticeTimerRef.current)
    noticeTimerRef.current = window.setTimeout(() => {
      noticeTimerRef.current = null
      setNotice(null)
    }, WRITE_EXPORT_NOTICE_MS)
    return () => {
      if (noticeTimerRef.current) {
        window.clearTimeout(noticeTimerRef.current)
        noticeTimerRef.current = null
      }
    }
  }, [notice])

  // Trace loop: pull live build/plan progress back into requirement statuses.
  useSddTrace({
    workspaceRoot: activeDraft?.workspaceRoot ?? '',
    draftRelativePath: activeDraft?.relativePath ?? null
  })

  useEffect(() => {
    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    if (!activeDraft || saveStatus !== 'dirty') return
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null
      void saveActiveSddDraftToDisk()
    }, SDD_AUTOSAVE_MS)
    return () => {
      if (saveTimerRef.current) {
        window.clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
      }
    }
  }, [activeDraft, content, saveStatus])

  useEffect(() => () => {
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current)
    void saveActiveSddDraftToDisk()
  }, [])

  const activeDraftId = activeDraft?.id
  const activeDraftWorkspaceRoot = activeDraft?.workspaceRoot
  const activeDraftRelativePath = activeDraft?.relativePath
  const activeDraftAbsolutePath = activeDraft?.absolutePath

  useEffect(() => {
    if (!activeDraftId || !activeDraftWorkspaceRoot || !activeDraftRelativePath) return
    if (
      typeof window.kunGui?.watchWorkspaceFile !== 'function' ||
      typeof window.kunGui?.unwatchWorkspaceFile !== 'function' ||
      typeof window.kunGui?.onWorkspaceFileChanged !== 'function'
    ) {
      return
    }

    return startWriteWorkspaceFileWatch({
      api: window.kunGui,
      workspaceRoot: activeDraftWorkspaceRoot,
      path: activeDraftAbsolutePath ?? activeDraftRelativePath,
      kind: 'text',
      onTextSnapshot: (snapshot) => {
        void syncActiveSddDraftFromDisk(snapshot)
      },
      onImageChanged: () => undefined,
      onError: (message) => {
        useSddDraftStore.getState().setSaveStatus('error', message)
      }
    })
  }, [activeDraftAbsolutePath, activeDraftId, activeDraftRelativePath, activeDraftWorkspaceRoot])

  if (!activeDraft) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-[14px] text-ds-muted">
        {t('sddNoActiveDraft')}
      </div>
    )
  }

  const upgrading = operationStatus === 'upgrading'
  const readOnly = upgrading
  const statusLabel = t(statusKey(saveStatus, operationStatus))

  const draftId = activeDraft.id
  const draftWorkspaceRoot = activeDraft.workspaceRoot
  const editorFilePath = activeDraft.absolutePath ?? activeDraft.relativePath
  // The image IPC resolves relative paths against the main-process cwd, so it
  // must always receive an absolute document path.
  const docAbsolutePath =
    activeDraft.absolutePath ?? `${activeDraft.workspaceRoot}/${activeDraft.relativePath}`
  // Per-requirement asset directories inside the unit folder; null only for
  // non-conforming paths, which the registry filter prevents in practice.
  const unitImageDir = sddUnitImageDir(activeDraft.relativePath)
  const unitProtoDir = sddUnitProtoDir(activeDraft.relativePath)
  const imageSelectionActive = Boolean(selection.selectedImage) && selection.charCount === 0
  const imageSelectionActionReady = imageSelectionActive && (prototypeReady || imageGenReady) && !readOnly
  const selectionAction =
    (selection.charCount > 0 || imageSelectionActionReady) &&
    !pointerSelecting
      ? inlineAgentPosition(selection)
      : null
  // Edit-mode quick actions rewrite the document, so drop them while the doc
  // is read-only (plan generation); chat-mode actions still apply.
  const inlineQuickActions = resolveWriteQuickActions(selectionAssist.quickActions, t).filter(
    (quickAction) => quickAction.mode !== 'edit' || !readOnly
  )

  const submitToAssistant = (prompt: string): void => {
    const trimmed = prompt.trim()
    if (!trimmed) return
    const quoted = quotedSelectionFromEditor(selection, editorFilePath, draftWorkspaceRoot)
    const fullPrompt = quoted
      ? `${formatWriteQuotedSelectionForPrompt(quoted)}\n\n${trimmed}`
      : trimmed
    setSelection({ text: '', ranges: [], charCount: 0 })
    setInlineAgentValue('')
    onAssistantQuote(fullPrompt)
  }

  const runQuickAction = (quickAction: ResolvedWriteQuickAction): void => {
    if (quickAction.mode === 'edit') {
      void submitInlineEdit(quickAction.prompt)
      return
    }
    submitToAssistant(quickAction.prompt)
  }

  const applyInlineFormat = (kind: WriteInlineFormatKind): void => {
    if (readOnly) return
    const richHandle = richHandleRef.current
    if (richHandle) {
      richHandle.toggleInlineFormat(kind)
      return
    }
    if (selection.ranges.length !== 1) return
    const range = selection.ranges[0]
    const replacement = toggleWriteInlineFormat(range.text, kind)
    if (replacement === null) return
    markdownHandleRef.current?.applyRangeReplacement(
      { from: range.from, to: range.to },
      range.text,
      replacement
    )
  }

  const applyBlockType = (type: WriteBlockType): void => {
    if (readOnly) return
    const richHandle = richHandleRef.current
    if (richHandle) {
      // TipTap toggle* commands already turn the active type back to paragraph.
      richHandle.setBlockType(type)
      return
    }
    // Source mode has no toggle built in: re-selecting the active type clears it.
    const effective = selection.blockType === type && type !== 'paragraph' ? 'paragraph' : type
    markdownHandleRef.current?.setBlockType(effective)
  }

  const submitInlineEdit = async (prompt: string): Promise<void> => {
    const trimmed = prompt.trim()
    if (!trimmed || readOnly || inlineEditInFlight) return
    if (selection.ranges.length !== 1) {
      setOperationStatus('error', t(
        selection.ranges.length > 1 ? 'writeInlineEditMultiSelection' : 'writeInlineEditNoSelection'
      ))
      return
    }
    if (typeof window.kunGui?.requestWriteInlineCompletion !== 'function') {
      setOperationStatus('error', t('writeInlineEditUnavailable'))
      return
    }

    // In rich mode the inline edit operates on the markdown projection: the
    // selection ranges are projection offsets and the replacement is applied
    // through the editor so undo history and node structure stay intact.
    const richHandle = richHandleRef.current
    const richProjectionText = richHandle?.getProjectionText() ?? null
    const editContent = richProjectionText ?? content

    const draft = buildWriteInlineEditDraft(editContent, selection.ranges[0], trimmed, {
      workspaceRoot: draftWorkspaceRoot,
      currentFilePath: editorFilePath,
      model: inlineCompletion.model,
      language: 'markdown',
      recentEdits
    })

    setInlineEditInFlight(true)
    try {
      const result = await window.kunGui.requestWriteInlineCompletion(
        buildWriteInlineEditCompletionRequest(draft.request)
      )
      if (!result.ok) {
        setOperationStatus('error', t('writeInlineEditFailed', { message: result.message }))
        return
      }
      const replacement = result.action?.kind === 'edit'
        ? result.action.replacement
        : result.completion

      if (richHandle) {
        const applied = richHandle.applyProjectedReplacement(
          { from: draft.scope.from, to: draft.scope.to },
          draft.scope.text,
          replacement,
          trimmed
        )
        if (!applied) {
          setOperationStatus('error', t('writeInlineEditChanged'))
          return
        }
        setSelection({ text: '', ranges: [], charCount: 0 })
        setInlineAgentValue('')
        setOperationStatus('idle')
        setNotice({ tone: 'success', message: t('writeInlineEditApplied') })
        return
      }

      const latest = useSddDraftStore.getState()
      if (
        latest.activeDraft?.id !== draftId ||
        latest.content.slice(draft.scope.from, draft.scope.to) !== draft.scope.text
      ) {
        setOperationStatus('error', t('writeInlineEditChanged'))
        return
      }

      const nextContent = applyWriteInlineEditReplacement(latest.content, draft.scope, replacement)
      const inlineEditRecord = createWriteRecentEdit({
        source: 'inline-edit',
        filePath: editorFilePath,
        from: draft.scope.from,
        to: draft.scope.to,
        deletedText: draft.scope.text,
        insertedText: replacement,
        beforeContext: latest.content.slice(
          Math.max(0, draft.scope.from - INLINE_EDIT_RECENT_CONTEXT_CHARS),
          draft.scope.from
        ),
        afterContext: nextContent.slice(
          draft.scope.from + replacement.length,
          Math.min(nextContent.length, draft.scope.from + replacement.length + INLINE_EDIT_RECENT_CONTEXT_CHARS)
        ),
        instruction: trimmed,
        scopeKind: draft.scope.kind
      })

      setContent(nextContent)
      if (inlineEditRecord) recordRecentEdits([inlineEditRecord])
      setSelection({ text: '', ranges: [], charCount: 0 })
      setInlineAgentValue('')
      setOperationStatus('idle')
      setNotice({ tone: 'success', message: t('writeInlineEditApplied') })
    } catch (err) {
      setOperationStatus('error', t('writeInlineEditFailed', {
        message: err instanceof Error ? err.message : String(err)
      }))
    } finally {
      setInlineEditInFlight(false)
    }
  }

  const { generateImage, generatePrototype } = createSddDraftGenerationController({
    readOnly,
    unitImageDir,
    unitProtoDir,
    selection,
    setSelection,
    setOperationStatus,
    t,
    richHandleRef,
    setContent,
    draftId,
    draftWorkspaceRoot,
    editorFilePath,
    docAbsolutePath,
    content,
    activeDraft,
    prototypePrompt: selectionAssist.prototypePrompt,
    onPrototypeTurn,
    setNotice
  })
  return (
    <SddDraftEditorContent
      leftSidebarCollapsed={leftSidebarCollapsed}
      assistantOpen={assistantOpen}
      onToggleLeftSidebar={onToggleLeftSidebar}
      onToggleAssistant={onToggleAssistant}
      onExploreInDesign={onExploreInDesign}
      onNext={onNext}
      onClose={onClose}
      nextDisabled={nextDisabled}
      t={t}
      activeDraft={activeDraft}
      content={content}
      saveStatus={saveStatus}
      error={error}
      notice={notice}
      readOnly={readOnly}
      upgrading={upgrading}
      statusLabel={statusLabel}
      saveTimerRef={saveTimerRef}
      updateDesignContext={updateDesignContext}
      editorPaneRef={editorPaneRef}
      editorFilePath={editorFilePath}
      unitImageDir={unitImageDir}
      richHandleRef={richHandleRef}
      markdownHandleRef={markdownHandleRef}
      inlineCompletion={inlineCompletion}
      inlineCompletionApiReady={inlineCompletionApiReady}
      recentEdits={recentEdits}
      setContent={setContent}
      recordRecentEdits={recordRecentEdits}
      setSelection={setSelection}
      setOperationStatus={setOperationStatus}
      selectionAction={selectionAction}
      inlineAgentValue={inlineAgentValue}
      inlineEditInFlight={inlineEditInFlight}
      inlineAgentTextareaRef={inlineAgentTextareaRef}
      setInlineAgentValue={setInlineAgentValue}
      submitToAssistant={submitToAssistant}
      submitInlineEdit={submitInlineEdit}
      applyInlineFormat={applyInlineFormat}
      selection={selection}
      applyBlockType={applyBlockType}
      inlineQuickActions={inlineQuickActions}
      runQuickAction={runQuickAction}
      imageGenReady={imageGenReady}
      generateImage={generateImage}
      prototypeReady={prototypeReady}
      generatePrototype={generatePrototype}
      imageSelectionActive={imageSelectionActive}
    />
  )
}
