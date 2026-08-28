import type { WorkspaceFileTarget } from '@shared/workspace-file'
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  type UIEvent as ReactUIEvent,
  type WheelEvent as ReactWheelEvent
} from 'react'
import { useTranslation } from 'react-i18next'
import { formatFilePathForDisplay } from '../lib/diff-stats'
import { openWorkspacePathInEditor } from '../lib/open-workspace-path'
import {
  highlightCodeHtml,
  languageFromFilePath,
  renderFallbackCodeHtml
} from '../lib/code-highlighting'
import { workspaceFilePreviewKind } from '../lib/workspace-text-preview'

export {
  PREVIEW_SCROLL_POSITIONS_KEY,
  isJsonPreviewPath,
  nextFilePreviewTargetForWheel,
  parsePreviewScrollPositions,
  rememberPreviewScrollPosition,
  resolvedPreviewPathMatchesTarget,
  svgPreviewDataUrl,
  targetKey
} from './workspace-file-preview-support'
import {
  COPY_RESET_MS, extensionBadge,
  fileNameFromPath,
  isJsonPreviewPath,
  isMarkdownPreviewPath,
  isSvgPreviewPath, nextFilePreviewTargetForWheel,
  parsePreviewScrollPositions,
  persistPreviewScrollPositions,
  readPreviewScrollPositions,
  relativePathSegments,
  rememberPreviewScrollPosition,
  resolvedPreviewPathMatchesTarget,
  svgPreviewDataUrl,
  targetKey,
  type CachedTextDraft,
  type Props
} from './workspace-file-preview-support'
import { useWorkspaceFilePreviewLoad } from './useWorkspaceFilePreviewLoad'
import { WorkspaceFilePreviewChrome } from './WorkspaceFilePreviewChrome'
import { WorkspaceFilePreviewBody } from './WorkspaceFilePreviewBody'
import { WorkspaceFilePreviewDialogs } from './WorkspaceFilePreviewDialogs'
export function WorkspaceFilePreviewPanel({
  target,
  openTargets = target ? [target] : [],
  workspaceRoot,
  className,
  fileTreeOpen = false,
  onToggleFileTree,
  onSelectTarget,
  onCloseTarget,
  pinnedTargetKeys = [],
  preserveAcrossThreads = false,
  officeProviderMode = 'local',
  wpsOfficeSession,
  wpsOfficeSdk,
  onTogglePinnedTarget,
  onCloseOtherTargets,
  onTogglePreserveAcrossThreads,
  onClose
}: Props): ReactElement {
  const { t } = useTranslation('common')
  const [copied, setCopied] = useState(false)
  const [markdownRendered, setMarkdownRendered] = useState(true)
  const [svgRendered, setSvgRendered] = useState(true)
  const [htmlRendered, setHtmlRendered] = useState(false)
  const [textDraft, setTextDraft] = useState('')
  const [textSaveError, setTextSaveError] = useState<string | null>(null)
  const [savingText, setSavingText] = useState(false)
  const [editingText, setEditingText] = useState(false)
  const [diskConflict, setDiskConflict] = useState(false)
  const [readingMode, setReadingMode] = useState(false)
  const [tabMenu, setTabMenu] = useState<{
    target: WorkspaceFileTarget
    x: number
    y: number
  } | null>(null)
  const [pendingCloseTarget, setPendingCloseTarget] = useState<WorkspaceFileTarget | null>(null)
  const [highlightHtml, setHighlightHtml] = useState(() => renderFallbackCodeHtml(''))
  const scrollRef = useRef<HTMLDivElement>(null)
  const tabsScrollRef = useRef<HTMLDivElement>(null)
  const scrollPositionsRef = useRef(readPreviewScrollPositions())
  const tabMenuRef = useRef<HTMLDivElement>(null)
  const tabMenuTriggerRef = useRef<HTMLElement | null>(null)
  const tabButtonRefs = useRef(new Map<string, HTMLButtonElement>())
  const copyResetRef = useRef<number | null>(null)
  const panelRef = useRef<HTMLElement>(null)
  const textDraftsRef = useRef(new Map<string, CachedTextDraft>())
  const [dirtyTargetKeys, setDirtyTargetKeys] = useState<Set<string>>(() => new Set())
  const activeTargetKey = targetKey(target)
  const visibleTargets = openTargets.length ? openTargets : target ? [target] : []
  const visibleTargetKeySignature = visibleTargets.map((item) => targetKey(item)).join('\0')
  const pinnedTargetKeySet = useMemo(() => new Set(pinnedTargetKeys), [pinnedTargetKeys])
  const tabActionsEnabled = Boolean(onTogglePinnedTarget || onCloseOtherTargets)
  const previewKind = workspaceFilePreviewKind(target?.path ?? '')
  const {
    result,
    setResult,
    imageResult,
    pdfResult,
    officeResult,
    officeAgentEditing,
    officeRefreshError,
    previewLease,
    loading,
    setLoading
  } = useWorkspaceFilePreviewLoad({
    target,
    workspaceRoot,
    activeTargetKey,
    previewKind,
    t,
    textDraftsRef,
    setSvgRendered,
    setHtmlRendered,
    setTextDraft,
    setTextSaveError,
    setSavingText,
    setEditingText,
    setDiskConflict
  })

  useEffect(() => {
    if (!result?.ok || !result.line) return
    const id = window.requestAnimationFrame(() => {
      const row = scrollRef.current?.querySelector(`[data-line="${result.line}"]`)
      row?.scrollIntoView({ block: 'center' })
    })
    return () => window.cancelAnimationFrame(id)
  }, [result])

  useEffect(
    () => () => {
      if (copyResetRef.current !== null) window.clearTimeout(copyResetRef.current)
    },
    []
  )

  useEffect(() => {
    if (!readingMode) return
    const exitReadingMode = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !tabMenu) setReadingMode(false)
    }
    document.addEventListener('keydown', exitReadingMode)
    return () => document.removeEventListener('keydown', exitReadingMode)
  }, [readingMode, tabMenu])

  useEffect(() => {
    if (!tabMenu) return
    const firstItem = tabMenuRef.current?.querySelector<HTMLButtonElement>('[role^="menuitem"]')
    firstItem?.focus()
    const closeMenu = (event: PointerEvent): void => {
      if (typeof Node !== 'undefined' && event.target instanceof Node && tabMenuRef.current?.contains(event.target)) {
        return
      }
      setTabMenu(null)
    }
    const closeMenuWithKeyboard = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setTabMenu(null)
      tabMenuTriggerRef.current?.focus()
    }
    document.addEventListener('pointerdown', closeMenu)
    document.addEventListener('keydown', closeMenuWithKeyboard)
    return () => {
      document.removeEventListener('pointerdown', closeMenu)
      document.removeEventListener('keydown', closeMenuWithKeyboard)
    }
  }, [tabMenu])

  useEffect(() => {
    if (!tabMenu) return
    const visibleKeys = new Set(visibleTargetKeySignature.split('\0').filter(Boolean))
    if (!visibleKeys.has(targetKey(tabMenu.target))) setTabMenu(null)
  }, [tabMenu, visibleTargetKeySignature])

  useEffect(() => {
    if (!activeTargetKey) return
    const id = window.requestAnimationFrame(() => {
      tabButtonRefs.current.get(activeTargetKey)?.scrollIntoView({
        block: 'nearest',
        inline: 'nearest'
      })
    })
    return () => window.cancelAnimationFrame(id)
  }, [activeTargetKey])

  useEffect(() => {
    const visibleKeys = new Set(visibleTargetKeySignature.split('\0').filter(Boolean))
    let changed = false
    for (const key of textDraftsRef.current.keys()) {
      if (visibleKeys.has(key)) continue
      textDraftsRef.current.delete(key)
      changed = true
    }
    if (changed) {
      setDirtyTargetKeys((current) => new Set([...current].filter((key) => visibleKeys.has(key))))
    }
  }, [visibleTargetKeySignature])

  useEffect(() => {
    return () => persistPreviewScrollPositions(scrollPositionsRef.current)
  }, [activeTargetKey])

  useEffect(() => {
    if (
      !activeTargetKey ||
      (!result?.ok && !imageResult?.ok && !pdfResult?.ok && !officeResult?.ok && !previewLease?.ok)
    ) return
    if (result?.ok && result.line) return
    const frame = window.requestAnimationFrame(() => {
      const stored = scrollPositionsRef.current[activeTargetKey]
      if (typeof stored === 'number' && scrollRef.current) scrollRef.current.scrollTop = stored
    })
    return () => window.cancelAnimationFrame(frame)
  }, [
    activeTargetKey,
    htmlRendered,
    imageResult,
    markdownRendered,
    officeResult,
    pdfResult,
    previewLease,
    result,
    svgRendered
  ])

  const handlePreviewScroll = (event: ReactUIEvent<HTMLDivElement>): void => {
    if (!activeTargetKey) return
    scrollPositionsRef.current = rememberPreviewScrollPosition(
      scrollPositionsRef.current,
      activeTargetKey,
      event.currentTarget.scrollTop
    )
  }

  const handleTabWheel = (event: ReactWheelEvent<HTMLDivElement>): void => {
    const delta = event.deltaY || event.deltaX
    if (
      delta !== 0 &&
      event.currentTarget.scrollWidth > event.currentTarget.clientWidth
    ) {
      event.preventDefault()
      event.currentTarget.scrollLeft += delta
      return
    }
    const nextTarget = nextFilePreviewTargetForWheel(visibleTargets, target, delta)
    if (!nextTarget || !onSelectTarget) return
    event.preventDefault()
    onSelectTarget(nextTarget)
  }

  const openTabMenu = (
    event: ReactMouseEvent<HTMLElement> | ReactKeyboardEvent<HTMLButtonElement>,
    item: WorkspaceFileTarget,
    position?: { x: number; y: number }
  ): void => {
    event.preventDefault()
    event.stopPropagation()
    tabMenuTriggerRef.current = event.currentTarget
    const rect = event.currentTarget.getBoundingClientRect()
    const requestedX = position?.x ?? ('clientX' in event ? event.clientX : rect.left)
    const requestedY = position?.y ?? ('clientY' in event ? event.clientY : rect.bottom)
    setTabMenu({
      target: item,
      x: Math.max(8, Math.min(requestedX, window.innerWidth - 200)),
      y: Math.max(8, Math.min(requestedY, window.innerHeight - 112))
    })
  }

  const handleTabKeyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    item: WorkspaceFileTarget,
    index: number
  ): void => {
    if (tabActionsEnabled && (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))) {
      const rect = event.currentTarget.getBoundingClientRect()
      openTabMenu(event, item, { x: rect.left, y: rect.bottom })
      return
    }
    let nextTarget: WorkspaceFileTarget | undefined
    if (event.key === 'ArrowRight') nextTarget = visibleTargets[(index + 1) % visibleTargets.length]
    if (event.key === 'ArrowLeft') nextTarget = visibleTargets[(index - 1 + visibleTargets.length) % visibleTargets.length]
    if (event.key === 'Home') nextTarget = visibleTargets[0]
    if (event.key === 'End') nextTarget = visibleTargets.at(-1)
    if (!nextTarget || !onSelectTarget) return
    event.preventDefault()
    onSelectTarget(nextTarget)
    window.requestAnimationFrame(() => tabButtonRefs.current.get(targetKey(nextTarget))?.focus())
  }

  const displayPath = useMemo(() => {
    const root = target?.workspaceRoot ?? workspaceRoot
    if (imageResult?.ok) return formatFilePathForDisplay(imageResult.path, root) ?? fileNameFromPath(imageResult.path)
    if (pdfResult?.ok) return formatFilePathForDisplay(pdfResult.path, root) ?? fileNameFromPath(pdfResult.path)
    if (officeResult?.ok) return formatFilePathForDisplay(officeResult.path, root) ?? fileNameFromPath(officeResult.path)
    if (result?.ok) return formatFilePathForDisplay(result.path, root) ?? fileNameFromPath(result.path)
    return target?.path ? formatFilePathForDisplay(target.path, root) ?? fileNameFromPath(target.path) : ''
  }, [imageResult, officeResult, pdfResult, result, target, workspaceRoot])
  const language = useMemo(() => {
    if (result?.ok) return languageFromFilePath(result.path)
    return target?.path ? languageFromFilePath(target.path) : ''
  }, [result, target])
  const isMarkdownFile = isMarkdownPreviewPath(result?.ok ? result.path : target?.path ?? '')
  const isSvgFile = isSvgPreviewPath(result?.ok ? result.path : target?.path ?? '')
  const isHtmlFile = previewKind === 'html'
  const textDirty = Boolean(result?.ok && !result.truncated && textDraft !== result.content)
  const editableText = Boolean(result?.ok && !result.truncated)
  const svgDataUrl = useMemo(
    () => result?.ok && isSvgFile && !result.truncated ? svgPreviewDataUrl(result.content) : '',
    [isSvgFile, result]
  )
  const lines = useMemo(() => (result?.ok ? result.content.split('\n') : []), [result])
  const breadcrumbSegments = useMemo(() => {
    const path = result?.ok ? result.path : target?.path ?? ''
    if (!path) return []
    return relativePathSegments(path, target?.workspaceRoot ?? workspaceRoot)
  }, [result, target, workspaceRoot])
  const currentFileName = displayPath ? fileNameFromPath(displayPath) : t('filePreviewTitle')
  const badge = extensionBadge(result?.ok ? result.path : target?.path ?? '', language)
  const activeLine = result?.ok && result.line && result.line >= 1 && result.line <= lines.length
    ? result.line
    : null
  const codeSurfaceStyle = activeLine
    ? ({
        '--ds-file-preview-active-line': activeLine - 1
      } as CSSProperties)
    : undefined

  useEffect(() => {
    if (!result?.ok) {
      setHighlightHtml(renderFallbackCodeHtml(''))
      return
    }

    let cancelled = false
    const fallback = renderFallbackCodeHtml(result.content)
    setHighlightHtml(fallback)

    void highlightCodeHtml(result.content, language).then((html) => {
      if (!cancelled) setHighlightHtml(html)
    })

    return () => {
      cancelled = true
    }
  }, [result, language])

  const openTargetInEditor = (targetToOpen: WorkspaceFileTarget | null): void => {
    const isActive = targetKey(targetToOpen) === activeTargetKey
    const resultMatchesTarget = Boolean(
      targetToOpen &&
      isActive &&
      result?.ok &&
      resolvedPreviewPathMatchesTarget(result.path, targetToOpen, workspaceRoot)
    )
    const path = resultMatchesTarget && result?.ok ? result.path : targetToOpen?.path
    if (!path) return
    void openWorkspacePathInEditor(
      {
        path,
        line: resultMatchesTarget && result?.ok ? result.line : targetToOpen?.line,
        column: resultMatchesTarget && result?.ok ? result.column : targetToOpen?.column
      },
      targetToOpen?.workspaceRoot ?? workspaceRoot
    ).then((next) => {
      if (!next.ok) {
        void window.kunGui?.logError?.('editor-open', 'Failed to open previewed file', {
          message: next.message,
          target: targetToOpen
        })?.catch(() => undefined)
      }
    })
  }

  const openInEditor = (): void => openTargetInEditor(target)
  const openInSystem = (): void => {
    if (!target) return
    void window.kunGui.openWorkspaceFileInSystem({
      ...target,
      workspaceRoot: target.workspaceRoot ?? workspaceRoot
    })
  }
  const revealInFileManager = (): void => {
    if (!target) return
    void window.kunGui.revealWorkspaceFileInFolder({
      ...target,
      workspaceRoot: target.workspaceRoot ?? workspaceRoot
    })
  }

  const copyContent = async (): Promise<void> => {
    const content = result?.ok ? textDraft : renderedDocxPreviewText(panelRef.current)
    if (!content || !navigator?.clipboard?.writeText) return
    try {
      await navigator.clipboard.writeText(content)
      setCopied(true)
      if (copyResetRef.current !== null) window.clearTimeout(copyResetRef.current)
      copyResetRef.current = window.setTimeout(() => setCopied(false), COPY_RESET_MS)
    } catch {
      setCopied(false)
    }
  }

  const copyContentAvailable = Boolean(
    result?.ok || (officeResult?.ok && officeResult.viewer === 'word')
  )

  const saveText = async (force = false): Promise<boolean> => {
    if (!target || !result?.ok || !textDirty || savingText) return false
    setSavingText(true)
    setTextSaveError(null)
    setDiskConflict(false)
    try {
      const next = await window.kunGui.writeWorkspaceFile({
        path: result.path,
        workspaceRoot: target.workspaceRoot ?? workspaceRoot,
        content: textDraft,
        expectedMtimeMs: textDraftsRef.current.get(activeTargetKey)?.mtimeMs ?? result.mtimeMs,
        ...(force ? { force: true } : {})
      })
      if (!next.ok) {
        if (next.code === 'modified_on_disk') setDiskConflict(true)
        else setTextSaveError(next.message)
        return false
      }
      setResult({
        ...result,
        content: textDraft,
        size: new TextEncoder().encode(textDraft).byteLength,
        mtimeMs: next.mtimeMs ?? result.mtimeMs
      })
      textDraftsRef.current.delete(activeTargetKey)
      setDirtyTargetKeys((current) => {
        const updated = new Set(current)
        updated.delete(activeTargetKey)
        return updated
      })
      return true
    } catch (error) {
      setTextSaveError(error instanceof Error ? error.message : String(error))
      return false
    } finally {
      setSavingText(false)
    }
  }

  const savePendingCloseTarget = async (): Promise<void> => {
    const item = pendingCloseTarget
    if (!item || !onCloseTarget) return
    const key = targetKey(item)
    if (key === activeTargetKey) {
      if (await saveText()) {
        setPendingCloseTarget(null)
        onCloseTarget(item)
      }
      return
    }
    const draft = textDraftsRef.current.get(key)
    if (!draft) {
      setPendingCloseTarget(null)
      onCloseTarget(item)
      return
    }
    setSavingText(true)
    try {
      const next = await window.kunGui.writeWorkspaceFile({
        path: item.path,
        workspaceRoot: item.workspaceRoot ?? workspaceRoot,
        content: draft.content,
        expectedMtimeMs: draft.mtimeMs
      })
      if (!next.ok) {
        setPendingCloseTarget(null)
        onSelectTarget?.(item)
        setTextSaveError(next.message)
        if (next.code === 'modified_on_disk') setDiskConflict(true)
        return
      }
      textDraftsRef.current.delete(key)
      setDirtyTargetKeys((current) => {
        const updated = new Set(current)
        updated.delete(key)
        return updated
      })
      setPendingCloseTarget(null)
      onCloseTarget(item)
    } finally {
      setSavingText(false)
    }
  }

  const reloadText = async (): Promise<void> => {
    if (!target || !result?.ok) return
    setLoading(true)
    setDiskConflict(false)
    setTextSaveError(null)
    try {
      const next = await window.kunGui.readWorkspaceFile({
        ...target,
        workspaceRoot: target.workspaceRoot ?? workspaceRoot
      })
      setResult(next)
      if (next.ok) {
        setTextDraft(next.content)
        textDraftsRef.current.delete(activeTargetKey)
        setDirtyTargetKeys((current) => {
          const updated = new Set(current)
          updated.delete(activeTargetKey)
          return updated
        })
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      <button
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        className={`ds-file-preview-reading-backdrop ${readingMode ? 'is-visible' : ''}`}
        onClick={() => setReadingMode(false)}
      />
      <aside
        ref={panelRef}
        data-kun-workspace-root={(target?.workspaceRoot ?? workspaceRoot).replaceAll('\\', '/')}
        data-reading-mode={readingMode ? 'true' : 'false'}
        className={`ds-no-drag ds-code-sidebar flex min-h-0 flex-col border-l border-ds-border-muted ${readingMode ? 'is-reading' : ''} ${className ?? ''}`}
      >
        <WorkspaceFilePreviewChrome
          t={t}
          tabsScrollRef={tabsScrollRef}
          handleTabWheel={handleTabWheel}
          visibleTargets={visibleTargets}
          target={target}
          activeTargetKey={activeTargetKey}
          dirtyTargetKeys={dirtyTargetKeys}
          textDirty={textDirty}
          pinnedTargetKeySet={pinnedTargetKeySet}
          workspaceRoot={workspaceRoot}
          tabButtonRefs={tabButtonRefs}
          onSelectTarget={onSelectTarget}
          openTargetInEditor={openTargetInEditor}
          tabActionsEnabled={tabActionsEnabled}
          openTabMenu={openTabMenu}
          handleTabKeyDown={handleTabKeyDown}
          onCloseTarget={onCloseTarget}
          setPendingCloseTarget={setPendingCloseTarget}
          textDraftsRef={textDraftsRef}
          setDirtyTargetKeys={setDirtyTargetKeys}
          badge={badge}
          currentFileName={currentFileName}
          onTogglePreserveAcrossThreads={onTogglePreserveAcrossThreads}
          preserveAcrossThreads={preserveAcrossThreads}
          readingMode={readingMode}
          setReadingMode={setReadingMode}
          isMarkdownFile={isMarkdownFile}
          markdownRendered={markdownRendered}
          setMarkdownRendered={setMarkdownRendered}
          result={result}
          editingText={editingText}
          isSvgFile={isSvgFile}
          svgRendered={svgRendered}
          setSvgRendered={setSvgRendered}
          isHtmlFile={isHtmlFile}
          htmlRendered={htmlRendered}
          setHtmlRendered={setHtmlRendered}
          previewLease={previewLease}
          editableText={editableText}
          setEditingText={setEditingText}
          saveText={saveText}
          savingText={savingText}
          setTextDraft={setTextDraft}
          setTextSaveError={setTextSaveError}
          setDiskConflict={setDiskConflict}
          openInEditor={openInEditor}
          onToggleFileTree={onToggleFileTree}
          fileTreeOpen={fileTreeOpen}
          openInSystem={openInSystem}
          revealInFileManager={revealInFileManager}
          copyContent={copyContent}
          copyContentAvailable={copyContentAvailable}
          copied={copied}
          onClose={onClose}
          breadcrumbSegments={breadcrumbSegments}
          imageResult={imageResult}
          pdfResult={pdfResult}
          officeResult={officeResult}
          language={language}
        />
        <WorkspaceFilePreviewBody
          t={t}
          target={target}
          loading={loading}
          imageResult={imageResult}
          pdfResult={pdfResult}
          officeResult={officeResult}
          officeAgentEditing={officeAgentEditing}
          officeRefreshError={officeRefreshError}
          officeProviderMode={officeProviderMode}
          wpsOfficeSession={wpsOfficeSession}
          wpsOfficeSdk={wpsOfficeSdk}
          previewLease={previewLease}
          previewKind={previewKind}
          currentFileName={currentFileName}
          workspaceRoot={workspaceRoot}
          scrollRef={scrollRef}
          handlePreviewScroll={handlePreviewScroll}
          result={result}
          textSaveError={textSaveError}
          setTextSaveError={setTextSaveError}
          diskConflict={diskConflict}
          reloadText={reloadText}
          saveText={saveText}
          setDiskConflict={setDiskConflict}
          editingText={editingText}
          textDraft={textDraft}
          setTextDraft={setTextDraft}
          textDraftsRef={textDraftsRef}
          activeTargetKey={activeTargetKey}
          setDirtyTargetKeys={setDirtyTargetKeys}
          isHtmlFile={isHtmlFile}
          htmlRendered={htmlRendered}
          isSvgFile={isSvgFile}
          svgRendered={svgRendered}
          svgDataUrl={svgDataUrl}
          isMarkdownFile={isMarkdownFile}
          markdownRendered={markdownRendered}
          codeSurfaceStyle={codeSurfaceStyle}
          activeLine={activeLine}
          lines={lines}
          highlightHtml={highlightHtml}
        />
      </aside>
      <WorkspaceFilePreviewDialogs
        t={t}
        tabMenu={tabMenu}
        tabMenuRef={tabMenuRef}
        pinnedTargetKeySet={pinnedTargetKeySet}
        onTogglePinnedTarget={onTogglePinnedTarget}
        setTabMenu={setTabMenu}
        tabMenuTriggerRef={tabMenuTriggerRef}
        onCloseOtherTargets={onCloseOtherTargets}
        visibleTargets={visibleTargets}
        pendingCloseTarget={pendingCloseTarget}
        setPendingCloseTarget={setPendingCloseTarget}
        textDraftsRef={textDraftsRef}
        setDirtyTargetKeys={setDirtyTargetKeys}
        onCloseTarget={onCloseTarget}
        savingText={savingText}
        savePendingCloseTarget={savePendingCloseTarget}
      />
    </>
  )
}

export function renderedDocxPreviewText(container: ParentNode | null): string {
  const preview = container?.querySelector<HTMLElement>('.workspace-docx-preview')
  if (!preview) return ''
  return (preview.innerText || preview.textContent || '').replaceAll('\u00a0', ' ').trim()
}
