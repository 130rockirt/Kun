import type {
  Dispatch,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  MutableRefObject,
  ReactElement,
  RefObject,
  SetStateAction,
  WheelEvent as ReactWheelEvent
} from 'react'
import {
  Check,
  ChevronRight,
  Code2,
  Copy,
  Eye,
  ExternalLink,
  Files,
  FolderOpen,
  FolderSearch,
  Loader2,
  Maximize2,
  Minimize2,
  PanelRightClose,
  Pencil,
  Pin,
  RotateCcw,
  Save,
  X
} from 'lucide-react'
import type {
  WorkspaceFileReadResult,
  WorkspaceFileTarget,
  WorkspaceImageReadResult,
  WorkspacePdfReadResult,
  WorkspacePreviewLeaseResult
} from '@shared/workspace-file'
import type { LocalOfficeDocumentReadResult } from '@shared/office-document'
import { formatFilePathForDisplay } from '../lib/diff-stats'
import { languageFromFilePath } from '../lib/code-highlighting'
import {
  extensionBadge,
  fileNameFromPath,
  formatBytes,
  targetKey,
  type CachedTextDraft
} from './workspace-file-preview-support'

type Translate = (key: string, values?: Record<string, unknown>) => string
type TabMenu = { target: WorkspaceFileTarget; x: number; y: number }

type WorkspaceFilePreviewChromeProps = {
  t: Translate
  tabsScrollRef: RefObject<HTMLDivElement | null>
  handleTabWheel: (event: ReactWheelEvent<HTMLDivElement>) => void
  visibleTargets: WorkspaceFileTarget[]
  target: WorkspaceFileTarget | null
  activeTargetKey: string
  dirtyTargetKeys: Set<string>
  textDirty: boolean
  pinnedTargetKeySet: Set<string>
  workspaceRoot: string
  tabButtonRefs: MutableRefObject<Map<string, HTMLButtonElement>>
  onSelectTarget?: (target: WorkspaceFileTarget) => void
  openTargetInEditor: (target: WorkspaceFileTarget) => void
  tabActionsEnabled: boolean
  openTabMenu: (event: ReactMouseEvent<HTMLButtonElement>, target: WorkspaceFileTarget) => void
  handleTabKeyDown: (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    target: WorkspaceFileTarget,
    index: number
  ) => void
  onCloseTarget?: (target: WorkspaceFileTarget) => void
  setPendingCloseTarget: Dispatch<SetStateAction<WorkspaceFileTarget | null>>
  textDraftsRef: MutableRefObject<Map<string, CachedTextDraft>>
  setDirtyTargetKeys: Dispatch<SetStateAction<Set<string>>>
  badge: string
  currentFileName: string
  onTogglePreserveAcrossThreads?: () => void
  preserveAcrossThreads: boolean
  readingMode: boolean
  setReadingMode: Dispatch<SetStateAction<boolean>>
  isMarkdownFile: boolean
  markdownRendered: boolean
  setMarkdownRendered: Dispatch<SetStateAction<boolean>>
  result: WorkspaceFileReadResult | null
  editingText: boolean
  isSvgFile: boolean
  svgRendered: boolean
  setSvgRendered: Dispatch<SetStateAction<boolean>>
  isHtmlFile: boolean
  htmlRendered: boolean
  setHtmlRendered: Dispatch<SetStateAction<boolean>>
  previewLease: WorkspacePreviewLeaseResult | null
  editableText: boolean
  setEditingText: Dispatch<SetStateAction<boolean>>
  saveText: (force?: boolean) => Promise<unknown>
  savingText: boolean
  setTextDraft: Dispatch<SetStateAction<string>>
  setTextSaveError: Dispatch<SetStateAction<string | null>>
  setDiskConflict: Dispatch<SetStateAction<boolean>>
  openInEditor: () => void
  onToggleFileTree?: () => void
  fileTreeOpen: boolean
  openInSystem: () => void
  revealInFileManager: () => void
  copyContent: () => Promise<void>
  copied: boolean
  onClose: () => void
  breadcrumbSegments: string[]
  imageResult: WorkspaceImageReadResult | null
  pdfResult: WorkspacePdfReadResult | null
  officeResult: LocalOfficeDocumentReadResult | null
  language: string
}

export function WorkspaceFilePreviewChrome(props: WorkspaceFilePreviewChromeProps): ReactElement {
  const {
    t,
    tabsScrollRef,
    handleTabWheel,
    visibleTargets,
    target,
    activeTargetKey,
    dirtyTargetKeys,
    textDirty,
    pinnedTargetKeySet,
    workspaceRoot,
    tabButtonRefs,
    onSelectTarget,
    openTargetInEditor,
    tabActionsEnabled,
    openTabMenu,
    handleTabKeyDown,
    onCloseTarget,
    setPendingCloseTarget,
    textDraftsRef,
    setDirtyTargetKeys,
    badge,
    currentFileName,
    onTogglePreserveAcrossThreads,
    preserveAcrossThreads,
    readingMode,
    setReadingMode,
    isMarkdownFile,
    markdownRendered,
    setMarkdownRendered,
    result,
    editingText,
    isSvgFile,
    svgRendered,
    setSvgRendered,
    isHtmlFile,
    htmlRendered,
    setHtmlRendered,
    previewLease,
    editableText,
    setEditingText,
    saveText,
    savingText,
    setTextDraft,
    setTextSaveError,
    setDiskConflict,
    openInEditor,
    onToggleFileTree,
    fileTreeOpen,
    openInSystem,
    revealInFileManager,
    copyContent,
    copied,
    onClose,
    breadcrumbSegments,
    imageResult,
    pdfResult,
    officeResult,
    language
  } = props
  return (
    <>
      <div className="ds-code-sidebar-topbar">
        <div
          ref={tabsScrollRef}
          className="ds-code-sidebar-tabs"
          role="tablist"
          aria-label={t('filePreviewOpenFiles')}
          onWheel={handleTabWheel}
        >
          {visibleTargets.map((item, index) => {
            const active = targetKey(item) === activeTargetKey
            const itemKey = targetKey(item)
            const dirty = dirtyTargetKeys.has(itemKey) || (active && textDirty)
            const pinned = pinnedTargetKeySet.has(targetKey(item))
            const itemPath = item.path
            const itemRoot = item.workspaceRoot ?? workspaceRoot
            const itemLabel = fileNameFromPath(itemPath)
            const itemBadge = extensionBadge(itemPath, languageFromFilePath(itemPath))
            const itemTitle = formatFilePathForDisplay(itemPath, itemRoot) ?? itemPath
            return (
              <div
                key={itemKey}
                data-kun-preview-key={itemKey}
                role="presentation"
                className={`ds-code-sidebar-tab ${active ? 'is-active' : ''}`}
              >
                <button
                  ref={(element) => {
                    const key = targetKey(item)
                    if (element) tabButtonRefs.current.set(key, element)
                    else tabButtonRefs.current.delete(key)
                  }}
                  type="button"
                  role="tab"
                  tabIndex={active ? 0 : -1}
                  aria-selected={active}
                  aria-label={pinned ? t('filePreviewPinnedTab', { file: itemLabel }) : itemLabel}
                  className="ds-code-sidebar-tab-selector"
                  title={itemTitle}
                  onClick={() => onSelectTarget?.(item)}
                  onDoubleClick={() => openTargetInEditor(item)}
                  onContextMenu={tabActionsEnabled ? (event) => openTabMenu(event, item) : undefined}
                  onKeyDown={(event) => handleTabKeyDown(event, item, index)}
                >
                  {pinned ? (
                    <Pin
                      aria-hidden="true"
                      className="h-3 w-3 shrink-0"
                      style={{ color: 'var(--ds-accent)' }}
                      strokeWidth={1.8}
                    />
                  ) : null}
                  <span className="ds-code-sidebar-file-badge">{itemBadge}</span>
                  <span className="min-w-0 truncate">{itemLabel}</span>
                  {dirty ? (
                    <span
                      aria-label={t('filePreviewUnsavedChanges', { defaultValue: 'Unsaved changes' })}
                      className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500"
                    />
                  ) : null}
                </button>
                {onCloseTarget ? (
                  <button
                    type="button"
                    aria-label={t('filePreviewCloseTab', { file: itemLabel })}
                    title={t('filePreviewCloseTab', { file: itemLabel })}
                    className="ds-code-sidebar-tab-close"
                    onClick={() => {
                      if (dirty) {
                        setPendingCloseTarget(item)
                        return
                      }
                      textDraftsRef.current.delete(itemKey)
                      setDirtyTargetKeys((current) => {
                        const updated = new Set(current)
                        updated.delete(itemKey)
                        return updated
                      })
                      onCloseTarget(item)
                    }}
                  >
                    <X className="h-3 w-3" strokeWidth={2} />
                  </button>
                ) : null}
              </div>
            )
          })}
          {!visibleTargets.length ? (
            <div
              role="presentation"
              className="ds-code-sidebar-tab"
              title={t('filePreviewEmpty')}
            >
              <button type="button" role="tab" aria-selected="false" disabled className="ds-code-sidebar-tab-selector">
                <span className="ds-code-sidebar-file-badge">{badge}</span>
                <span className="truncate">{currentFileName}</span>
              </button>
            </div>
          ) : null}
        </div>

        <div className="ds-code-sidebar-actions">
          {onTogglePreserveAcrossThreads ? (
            <button
              type="button"
              onClick={onTogglePreserveAcrossThreads}
              className="ds-code-sidebar-icon-button"
              title={t('filePreviewPreserveAcrossThreads')}
              aria-label={t('filePreviewPreserveAcrossThreads')}
              aria-pressed={preserveAcrossThreads}
            >
              <Files
                className="h-4 w-4"
                style={preserveAcrossThreads ? { color: 'var(--ds-accent)' } : undefined}
                strokeWidth={1.75}
              />
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => setReadingMode((value) => !value)}
            className="ds-code-sidebar-icon-button"
            title={readingMode ? t('filePreviewExitReadingMode') : t('filePreviewEnterReadingMode')}
            aria-label={readingMode ? t('filePreviewExitReadingMode') : t('filePreviewEnterReadingMode')}
            aria-pressed={readingMode}
          >
            {readingMode ? (
              <Minimize2 className="h-4 w-4" strokeWidth={1.8} />
            ) : (
              <Maximize2 className="h-4 w-4" strokeWidth={1.8} />
            )}
          </button>
          {isMarkdownFile ? (
            <button
              type="button"
              onClick={() => setMarkdownRendered((value) => !value)}
              disabled={!result?.ok || editingText}
              className="ds-code-sidebar-icon-button"
              title={markdownRendered ? t('filePreviewShowSource') : t('filePreviewRenderMarkdown')}
              aria-label={markdownRendered ? t('filePreviewShowSource') : t('filePreviewRenderMarkdown')}
              aria-pressed={markdownRendered}
            >
              {markdownRendered ? (
                <Code2 className="h-4 w-4" strokeWidth={1.75} />
              ) : (
                <Eye className="h-4 w-4" strokeWidth={1.75} />
              )}
            </button>
          ) : null}
          {isSvgFile ? (
            <button
              type="button"
              onClick={() => setSvgRendered((value) => !value)}
              disabled={!result?.ok || result.truncated || editingText}
              className="ds-code-sidebar-icon-button"
              title={svgRendered ? t('filePreviewShowSvgSource') : t('filePreviewRenderSvg')}
              aria-label={svgRendered ? t('filePreviewShowSvgSource') : t('filePreviewRenderSvg')}
              aria-pressed={svgRendered}
            >
              {svgRendered ? (
                <Code2 className="h-4 w-4" strokeWidth={1.75} />
              ) : (
                <Eye className="h-4 w-4" strokeWidth={1.75} />
              )}
            </button>
          ) : null}
          {isHtmlFile ? (
            <button
              type="button"
              onClick={() => setHtmlRendered((value) => !value)}
              disabled={!result?.ok || result.truncated || editingText || !previewLease?.ok}
              className="ds-code-sidebar-icon-button"
              title={htmlRendered
                ? t('filePreviewShowSource')
                : t('filePreviewRenderHtml', { defaultValue: 'Render HTML' })}
              aria-label={htmlRendered
                ? t('filePreviewShowSource')
                : t('filePreviewRenderHtml', { defaultValue: 'Render HTML' })}
              aria-pressed={htmlRendered}
            >
              {htmlRendered ? (
                <Code2 className="h-4 w-4" strokeWidth={1.75} />
              ) : (
                <Eye className="h-4 w-4" strokeWidth={1.75} />
              )}
            </button>
          ) : null}
          {editableText ? (
            <button
              type="button"
              onClick={() => setEditingText((value) => !value)}
              className="ds-code-sidebar-icon-button"
              title={editingText
                ? t('filePreviewStopEditing', { defaultValue: 'Stop editing' })
                : t('filePreviewEditText', { defaultValue: 'Edit file' })}
              aria-label={editingText
                ? t('filePreviewStopEditing', { defaultValue: 'Stop editing' })
                : t('filePreviewEditText', { defaultValue: 'Edit file' })}
              aria-pressed={editingText}
            >
              {editingText ? (
                <Eye className="h-4 w-4" strokeWidth={1.75} />
              ) : (
                <Pencil className="h-4 w-4" strokeWidth={1.75} />
              )}
            </button>
          ) : null}
          {editableText ? (
            <button
              type="button"
              onClick={() => void saveText()}
              disabled={!textDirty || savingText}
              className="ds-code-sidebar-icon-button"
              title={t('filePreviewSaveText', { defaultValue: 'Save file' })}
              aria-label={t('filePreviewSaveText', { defaultValue: 'Save file' })}
            >
              {savingText ? (
                <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.8} />
              ) : (
                <Save className="h-4 w-4" strokeWidth={1.75} />
              )}
            </button>
          ) : null}
          {editableText && textDirty ? (
            <button
              type="button"
              onClick={() => {
                if (!result?.ok) return
                setTextDraft(result.content)
                textDraftsRef.current.delete(activeTargetKey)
                setDirtyTargetKeys((current) => {
                  const updated = new Set(current)
                  updated.delete(activeTargetKey)
                  return updated
                })
                setTextSaveError(null)
                setDiskConflict(false)
              }}
              className="ds-code-sidebar-icon-button"
              title={t('filePreviewRevertText', { defaultValue: 'Revert changes' })}
              aria-label={t('filePreviewRevertText', { defaultValue: 'Revert changes' })}
            >
              <RotateCcw className="h-4 w-4" strokeWidth={1.75} />
            </button>
          ) : null}
          <button
            type="button"
            onClick={openInEditor}
            disabled={!target}
            className="ds-code-sidebar-icon-button"
            title={t('filePreviewOpenEditor')}
            aria-label={t('filePreviewOpenEditor')}
          >
            <ExternalLink className="h-4 w-4" strokeWidth={1.75} />
          </button>
          {onToggleFileTree ? (
            <button
              type="button"
              onClick={() => {
                if (readingMode) setReadingMode(false)
                onToggleFileTree()
              }}
              className={`ds-code-sidebar-icon-button ${fileTreeOpen ? 'is-active' : ''}`}
              title={fileTreeOpen ? t('fileTreeClose') : t('fileTreeOpen')}
              aria-label={fileTreeOpen ? t('fileTreeClose') : t('fileTreeOpen')}
              aria-pressed={fileTreeOpen}
            >
              <FolderOpen className="h-4 w-4" strokeWidth={1.75} />
            </button>
          ) : (
            <button
              type="button"
              onClick={openInSystem}
              disabled={!target}
              className="ds-code-sidebar-icon-button"
              title={t('filePreviewOpenSystem', { defaultValue: 'Open with system app' })}
              aria-label={t('filePreviewOpenSystem', { defaultValue: 'Open with system app' })}
            >
              <FolderOpen className="h-4 w-4" strokeWidth={1.75} />
            </button>
          )}
          <button
            type="button"
            onClick={revealInFileManager}
            disabled={!target}
            className="ds-code-sidebar-icon-button"
            title={t('filePreviewRevealInFolder', { defaultValue: 'Show in file manager' })}
            aria-label={t('filePreviewRevealInFolder', { defaultValue: 'Show in file manager' })}
          >
            <FolderSearch className="h-4 w-4" strokeWidth={1.75} />
          </button>
          <button
            type="button"
            onClick={() => void copyContent()}
            disabled={!result?.ok}
            className="ds-code-sidebar-icon-button"
            title={copied ? t('copySuccess') : t('filePreviewCopyContent')}
            aria-label={copied ? t('copySuccess') : t('filePreviewCopyContent')}
          >
            {copied ? (
              <Check className="h-4 w-4 text-emerald-600" strokeWidth={2} />
            ) : (
              <Copy className="h-4 w-4" strokeWidth={1.75} />
            )}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="ds-code-sidebar-icon-button"
            title={t('rightPanelCollapse')}
            aria-label={t('rightPanelCollapse')}
          >
            <PanelRightClose className="h-4 w-4" strokeWidth={1.85} />
          </button>
        </div>
      </div>

      <div className="ds-code-sidebar-breadcrumbs">
        <div className="min-w-0 flex flex-1 items-center gap-1 overflow-hidden">
          {breadcrumbSegments.length ? breadcrumbSegments.map((segment, index) => (
            <span key={`${segment}-${index}`} className="contents">
              {index > 0 ? (
                <ChevronRight className="h-3 w-3 shrink-0 text-ds-faint/70" strokeWidth={1.8} />
              ) : null}
              <span
                className={[
                  'truncate',
                  index === breadcrumbSegments.length - 1 ? 'text-ds-ink' : 'text-ds-muted'
                ].join(' ')}
                title={segment}
              >
                {segment}
              </span>
            </span>
          )) : (
            <span className="truncate text-ds-muted">{t('filePreviewEmpty')}</span>
          )}
        </div>
        {result?.ok || imageResult?.ok || pdfResult?.ok || officeResult?.ok || previewLease?.ok ? (
          <span className="shrink-0 font-mono text-[10px] text-ds-faint">
            {formatBytes(
              result?.ok
                ? result.size
                : imageResult?.ok
                  ? imageResult.size
                  : pdfResult?.ok
                    ? pdfResult.size
                    : officeResult?.ok
                      ? officeResult.size
                      : previewLease?.ok
                        ? previewLease.size
                        : 0
            )}
            {language ? ` · ${language}` : ''}
          </span>
        ) : null}
      </div>
    </>
  )
}
