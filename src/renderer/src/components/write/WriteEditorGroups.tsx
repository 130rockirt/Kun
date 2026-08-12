import { useMemo, useRef, useState, type MutableRefObject, type ReactElement, type RefObject } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useTranslation } from 'react-i18next'
import type { WriteInlineCompletionSettingsV1 } from '@shared/app-settings'
import { isWriteWorkspaceFilePath } from '@shared/write-text-file'
import type { WriteRichEditorHandle } from '../../write/tiptap/WriteRichEditor'
import type { WriteMarkdownEditorHandle } from './WriteMarkdownEditor'
import {
  useWriteWorkspaceStore,
  writeJoinPath,
  writeRelativeToWorkspace
} from '../../write/write-workspace-store'
import { writeDocumentKey } from '../../write/write-editor-layout'
import { WriteEditorGroupContent } from './WriteEditorGroupContent'
import { WriteEditorTabBar } from './WriteEditorTabBar'

type Props = {
  workspaceName: string
  workspacePathLabel: string
  workspaceError?: string | null
  inlineCompletion: WriteInlineCompletionSettingsV1
  inlineCompletionApiReady: boolean
  leftSidebarCollapsed: boolean
  onToggleLeftSidebar: () => void
  focusMode: boolean
  onFocusModeChange: (active: boolean) => void
  richHandleRef: MutableRefObject<WriteRichEditorHandle | null>
  markdownHandleRef: MutableRefObject<WriteMarkdownEditorHandle | null>
  editorPaneRef: RefObject<HTMLDivElement | null>
  focusedToolbar: ReactElement
  onboardingDecision: string
  onAskAssistant: () => void
  onCreateDraft: () => void
  onPickWorkspace: () => void
}

export function WriteEditorGroups({
  workspaceName,
  workspacePathLabel,
  workspaceError,
  inlineCompletion,
  inlineCompletionApiReady,
  leftSidebarCollapsed,
  onToggleLeftSidebar,
  focusMode,
  onFocusModeChange,
  richHandleRef,
  markdownHandleRef,
  editorPaneRef,
  focusedToolbar,
  onboardingDecision,
  onAskAssistant,
  onCreateDraft,
  onPickWorkspace
}: Props): ReactElement {
  const { t } = useTranslation('common')
  const hostRef = useRef<HTMLDivElement | null>(null)
  const {
    workspaceRoot,
    rootDirectory,
    entriesByDir,
    documentsByPath,
    editorLayout,
    settingsError,
    treeError,
    activateTab,
    closeTab,
    moveTab,
    focusEditorGroup,
    splitEditorGroup,
    closeEditorGroup,
    setSplitRatio,
    openFile,
    setDocumentContent,
    saveDocument,
    setSelection,
    recordRecentEdits,
    refreshWorkspace,
    setFileError,
    setReviewActive
  } = useWriteWorkspaceStore(useShallow((state) => ({
    workspaceRoot: state.workspaceRoot,
    rootDirectory: state.rootDirectory,
    entriesByDir: state.entriesByDir,
    documentsByPath: state.documentsByPath,
    editorLayout: state.editorLayout,
    settingsError: state.settingsError,
    treeError: state.treeError,
    activateTab: state.activateTab,
    closeTab: state.closeTab,
    moveTab: state.moveTab,
    focusEditorGroup: state.focusEditorGroup,
    splitEditorGroup: state.splitEditorGroup,
    closeEditorGroup: state.closeEditorGroup,
    setSplitRatio: state.setSplitRatio,
    openFile: state.openFile,
    setDocumentContent: state.setDocumentContent,
    saveDocument: state.saveDocument,
    setSelection: state.setSelection,
    recordRecentEdits: state.recordRecentEdits,
    refreshWorkspace: state.refreshWorkspace,
    setFileError: state.setFileError,
    setReviewActive: state.setReviewActive
  })))
  const [quickOpenGroupId, setQuickOpenGroupId] = useState<'primary' | 'secondary' | null>(null)
  const [quickOpenQuery, setQuickOpenQuery] = useState('')
  const quickOpenFiles = useMemo(() => {
    const byPath = new Map<string, string>()
    for (const entries of Object.values(entriesByDir)) {
      for (const entry of entries) {
        if (entry.type === 'file' && isWriteWorkspaceFilePath(entry.path)) {
          byPath.set(entry.path, writeRelativeToWorkspace(workspaceRoot, entry.path))
        }
      }
    }
    return [...byPath.entries()].sort((left, right) => left[1].localeCompare(right[1]))
  }, [entriesByDir, workspaceRoot])
  const quickOpenMatches = useMemo(() => {
    const query = quickOpenQuery.trim().toLocaleLowerCase()
    return quickOpenFiles.filter(([, label]) => !query || label.toLocaleLowerCase().includes(query)).slice(0, 12)
  }, [quickOpenFiles, quickOpenQuery])

  const quickOpen = (groupId: 'primary' | 'secondary'): void => {
    setQuickOpenGroupId(groupId)
    setQuickOpenQuery('')
  }

  const chooseQuickOpen = (requested: string): void => {
    if (!quickOpenGroupId || !requested.trim()) return
    const path = requested.startsWith('/') || /^[A-Za-z]:[\\/]/.test(requested)
      ? requested
      : writeJoinPath(rootDirectory || workspaceRoot, requested)
    const groupId = quickOpenGroupId
    setQuickOpenGroupId(null)
    setQuickOpenQuery('')
    void openFile(workspaceRoot, path, { groupId })
  }

  const beginResize = (event: import('react').PointerEvent<HTMLDivElement>): void => {
    const host = hostRef.current
    if (!host || editorLayout.groups.length < 2) return
    event.preventDefault()
    const orientation = editorLayout.orientation
    const update = (pointer: PointerEvent): void => {
      const rect = host.getBoundingClientRect()
      const ratio = orientation === 'vertical'
        ? (pointer.clientY - rect.top) / Math.max(1, rect.height)
        : (pointer.clientX - rect.left) / Math.max(1, rect.width)
      setSplitRatio(ratio)
    }
    const finish = (): void => {
      window.removeEventListener('pointermove', update)
      window.removeEventListener('pointerup', finish)
    }
    window.addEventListener('pointermove', update)
    window.addEventListener('pointerup', finish)
  }

  return (
    <div
      ref={hostRef}
      className="write-editor-groups relative flex h-full min-h-0 min-w-0 overflow-hidden rounded-[18px]"
      data-orientation={editorLayout.orientation === 'vertical' ? 'vertical' : 'horizontal'}
    >
      {editorLayout.groups.map((group, index) => {
        const path = group.activePath
        const document = path ? documentsByPath[writeDocumentKey(path)] : undefined
        const tab = path ? group.tabs.find((candidate) => candidate.path === path) : undefined
        const focused = editorLayout.focusedGroupId === group.id
        const pane = (
          <section
            key={group.id}
            className="write-editor-group flex min-h-0 min-w-0 flex-col"
            data-focused={focused}
            style={{ flex: `${index === 0 ? editorLayout.ratio : 1 - editorLayout.ratio} 1 0%` }}
          >
            <WriteEditorTabBar
              group={group}
              documentsByPath={documentsByPath}
              focused={focused}
              primary={group.id === 'primary'}
              leftSidebarCollapsed={leftSidebarCollapsed}
              onToggleLeftSidebar={onToggleLeftSidebar}
              onActivate={(nextPath) => {
                if (documentsByPath[writeDocumentKey(nextPath)]) activateTab(group.id, nextPath)
                else void openFile(workspaceRoot, nextPath, {
                  groupId: group.id,
                  viewMode: group.tabs.find((item) => item.path === nextPath)?.viewMode
                })
              }}
              onClose={(nextPath) => void closeTab(group.id, nextPath)}
              onMove={moveTab}
              onCreateDraft={() => { focusEditorGroup(group.id); onCreateDraft() }}
              onQuickOpen={() => quickOpen(group.id)}
              onSplit={(orientation) => splitEditorGroup(orientation, path ?? undefined)}
              onCloseGroup={() => closeEditorGroup(group.id)}
              hasSecondGroup={editorLayout.groups.length === 2}
            />
            {focused ? focusedToolbar : null}
            <WriteEditorGroupContent
              document={document}
              requestedPath={path}
              viewMode={tab?.viewMode ?? 'rich'}
              workspaceRoot={workspaceRoot}
              workspaceName={workspaceName}
              workspacePathLabel={workspacePathLabel}
              workspaceError={workspaceError ?? settingsError ?? treeError}
              inlineCompletion={inlineCompletion}
              inlineCompletionApiReady={inlineCompletionApiReady}
              recentEdits={document?.recentEdits ?? []}
              focused={focused}
              focusMode={focusMode}
              richHandleRef={focused ? richHandleRef : undefined}
              markdownHandleRef={focused ? markdownHandleRef : undefined}
              editorPaneRef={focused ? editorPaneRef : undefined}
              onFocusModeChange={onFocusModeChange}
              onFocus={() => { if (!focused) focusEditorGroup(group.id) }}
              onAskAssistant={onAskAssistant}
              onCreateDraft={onCreateDraft}
              onPickWorkspace={onPickWorkspace}
              onRefreshWorkspace={() => void refreshWorkspace(workspaceRoot)}
              onContentChange={(content) => { if (path) setDocumentContent(path, content) }}
              onDocumentEdit={(edits) => {
                if (!focused) focusEditorGroup(group.id)
                recordRecentEdits(edits)
              }}
              onSelectionChange={(selection) => {
                if (!focused) focusEditorGroup(group.id)
                setSelection(selection)
              }}
              onSaveShortcut={() => {
                if (path) void saveDocument(workspaceRoot, path, { resolveExternalConflict: 'keep-local' })
              }}
              onImagePasteSaved={() => { setFileError(null); void refreshWorkspace(workspaceRoot) }}
              onImagePasteError={setFileError}
              onReviewStateChange={setReviewActive}
              onboarding={group.id === 'primary' && onboardingDecision === 'show'}
              workspaceLoading={group.id === 'primary' && onboardingDecision === 'pending' && !settingsError && !treeError}
            />
          </section>
        )
        if (index === 0 || editorLayout.groups.length === 1) return pane
        return (
          <div key={`${group.id}-with-divider`} className="contents">
            <div
              role="separator"
              tabIndex={0}
              aria-orientation={editorLayout.orientation === 'vertical' ? 'horizontal' : 'vertical'}
              className="write-editor-divider"
              onPointerDown={beginResize}
              onKeyDown={(event) => {
                const delta = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -0.05
                  : event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 0.05 : 0
                if (!delta) return
                event.preventDefault()
                setSplitRatio(editorLayout.ratio + delta)
              }}
            />
            {pane}
          </div>
        )
      })}
      {quickOpenGroupId ? (
        <div className="absolute left-1/2 top-14 z-50 w-[min(520px,calc(100%-32px))] -translate-x-1/2 overflow-hidden rounded-2xl border border-ds-border bg-ds-card shadow-2xl">
          <input
            autoFocus
            value={quickOpenQuery}
            onChange={(event) => setQuickOpenQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setQuickOpenGroupId(null)
              if (event.key === 'Enter') {
                const candidate = quickOpenMatches[0]
                chooseQuickOpen(candidate?.[0] ?? quickOpenQuery)
              }
            }}
            placeholder={t('writeQuickOpenPrompt')}
            aria-label={t('writeQuickOpen')}
            className="h-11 w-full border-b border-ds-border-muted bg-transparent px-4 text-sm text-ds-ink outline-none placeholder:text-ds-faint"
          />
          <div className="max-h-72 overflow-y-auto p-1.5">
            {quickOpenMatches.map(([path, label]) => (
              <button
                key={path}
                type="button"
                className="write-tabbar-menu-item"
                onClick={() => chooseQuickOpen(path)}
              >
                <span className="min-w-0 flex-1 truncate">{label}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}
