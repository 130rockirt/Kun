import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, PanelRightClose, Shapes } from 'lucide-react'
import { CanvasViewport } from './CanvasViewport'
import { PropertiesPanel } from './PropertiesPanel'
import {
  DesignDocumentCanvasSurface,
  type DesignDocumentCanvasSurfaceProps
} from './DesignDocumentCanvasSurface'
import { useApplyShapeOpsLive } from '../../../design/canvas/use-apply-shape-ops-live'
import type { ExecuteOpsOptions } from '../../../design/canvas/shape-ops'
import {
  CODE_CANVAS_DIR,
  codeCanvasArtifactId,
  codeCanvasErrorKey,
  codeCanvasThreadBaseDir
} from '../../../design/canvas/code-canvas'
import {
  exportActiveCodeCanvasToWorkspace,
  type CanvasAgentExportRequest
} from '../../../design/canvas/canvas-export'
import { canvasDocumentKey } from '../../../design/canvas/canvas-persistence'
import { useCodeCanvasDesignSurface } from '../../../design/code-canvas-design-surface'
import { useDesignWorkspaceStore } from '../../../design/design-workspace-store'
import { normalizeDesignWorkspaceRoot } from '../../../design/design-workspace-lifecycle'
import { displayDrawingTitle } from '../../../design/design-drawing-title'
import { findDesignBoardArtifact } from '../../../design/design-board'
import {
  cloneDesignDocumentForFork,
  type PreparedDesignDocumentFork
} from '../../../design/design-document-fork'

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

type Props = Pick<
  DesignDocumentCanvasSurfaceProps,
  | 'busy'
  | 'onOpenAgentSettings'
  | 'onImplementDesign'
  | 'onScreenCreated'
  | 'onSvgCreated'
  | 'onUseElementAsContext'
  | 'onRuntimeQualityFindings'
  | 'onRequestQualityRepair'
> & {
  workspaceRoot: string
  activeThreadId: string | null
  /** Keeps a classified Design task on the full Design surface while its target hydrates. */
  designTaskActive?: boolean
  onCollapse: () => void
  className?: string
}

export function codeCanvasPanelShellClass(className?: string): string {
  return cx(
    'ds-no-drag relative flex min-h-0 flex-col overflow-hidden border-l border-ds-border-muted bg-[#f8fafc] dark:bg-[#111318]',
    className
  )
}

export function codeCanvasPanelTitlebarClass(): string {
  return 'pointer-events-auto flex h-10 max-w-[calc(100%-72px)] min-w-0 items-center gap-1.5 rounded-full border border-ds-border bg-white/82 px-1.5 shadow-[0_16px_42px_rgba(20,47,95,0.13)] backdrop-blur-2xl dark:bg-ds-card/84 dark:shadow-none'
}

/**
 * Hosts the reusable {@link CanvasViewport} as a code-workspace right panel.
 * By default the canvas is per-thread (`code-<threadId>`), persisted under
 * {@link CODE_CANVAS_DIR}, and the main chat agent drives it via ShapeOps
 * (Block C).
 *
 * When the user asks to view a 设计稿 (prototype card "open in canvas", sidebar
 * design tree, or a design thread in the sidebar), the panel instead renders
 * that document's design board — a whiteboard-style space with the same
 * zoom/pan/grid tooling — without leaving the chat route.
 */
export function CodeCanvasPanel({
  workspaceRoot,
  activeThreadId,
  designTaskActive = false,
  onCollapse,
  className,
  busy,
  onOpenAgentSettings,
  onImplementDesign,
  onScreenCreated,
  onSvgCreated,
  onUseElementAsContext,
  onRuntimeQualityFindings,
  onRequestQualityRepair
}: Props) {
  const { t } = useTranslation('common')
  const surface = useCodeCanvasDesignSurface((s) => s.surface)
  const designDocuments = useDesignWorkspaceStore((s) => s.documents)
  const [continuingHistorical, setContinuingHistorical] = useState(false)
  const activationGenerationRef = useRef(0)
  const activeThreadIdRef = useRef(activeThreadId)
  activeThreadIdRef.current = activeThreadId
  const matchingDesignSurface = Boolean(
    surface &&
    surface.threadId === activeThreadId &&
    normalizeDesignWorkspaceRoot(surface.workspaceRoot) === normalizeDesignWorkspaceRoot(workspaceRoot)
  )
  const designMode = matchingDesignSurface || Boolean(designTaskActive && activeThreadId)
  const activeDesignSurface = matchingDesignSurface ? surface : null

  // Activate the requested 设计稿 so the design store projects its artifacts
  // (the board + linked HTML frames for that document).
  useEffect(() => {
    if (!matchingDesignSurface || !surface) return
    const generation = ++activationGenerationRef.current
    const restoreLatestSurface = (): void => {
      const latest = useCodeCanvasDesignSurface.getState().surface
      const expectedThreadId = generation === activationGenerationRef.current
        ? activeThreadId
        : activeThreadIdRef.current
      if (latest?.threadId === expectedThreadId) {
        const latestState = useDesignWorkspaceStore.getState()
        if (latestState.documents.some((document) => document.id === latest.documentId)) {
          latestState.switchActiveDocument(latest.documentId)
        }
      }
    }
    const state = useDesignWorkspaceStore.getState()
    if (
      normalizeDesignWorkspaceRoot(state.workspaceRoot) !==
      normalizeDesignWorkspaceRoot(surface.workspaceRoot)
    ) {
      state.setWorkspaceRoot(surface.workspaceRoot)
      void useDesignWorkspaceStore.getState().loadDesignSettings().then(restoreLatestSurface)
      return
    }
    if (state.activeDocumentId !== surface.documentId) {
      if (state.documents.some((document) => document.id === surface.documentId)) {
        state.switchActiveDocument(surface.documentId)
      } else {
        void state.rehydrateArtifacts().then(() => {
          restoreLatestSurface()
        })
      }
    }
  }, [activeThreadId, matchingDesignSurface, surface])

  const ready = Boolean(workspaceRoot && activeThreadId)
  const artifactId = activeThreadId ? codeCanvasArtifactId(activeThreadId) : ''
  const designSystemBaseDir = activeThreadId ? codeCanvasThreadBaseDir(activeThreadId) : undefined
  const feedbackKey = activeThreadId ? codeCanvasErrorKey(activeThreadId) : undefined
  const expectedDocumentKey = ready
    ? canvasDocumentKey(workspaceRoot, artifactId, CODE_CANVAS_DIR)
    : undefined
  const executeOptions = useMemo<ExecuteOpsOptions>(
    () => ({
      screenFallback: 'plain-frame',
      shapePreset: 'diagram',
      ...(feedbackKey ? { lintFeedbackKey: feedbackKey } : {})
    }),
    [feedbackKey]
  )
  const exportCanvas = useCallback(
    (request: CanvasAgentExportRequest) => exportActiveCodeCanvasToWorkspace({
      request,
      workspaceRoot,
      artifactId,
      expectedDocumentKey
    }),
    [artifactId, expectedDocumentKey, workspaceRoot]
  )
  useApplyShapeOpsLive(
    !designMode && ready,
    undefined,
    executeOptions,
    feedbackKey,
    activeThreadId,
    undefined,
    exportCanvas,
    undefined,
    expectedDocumentKey,
    undefined,
    'code'
  )

  const designDoc = activeDesignSurface
    ? designDocuments.find((document) => document.id === activeDesignSurface.documentId) ?? null
    : null
  const designDocTitle = designDoc ? displayDrawingTitle(designDoc, t('designUntitledDrawing')) : ''
  const returnToCanonicalDocument = useCallback(() => {
    if (!activeDesignSurface?.canonicalDocumentId || !activeThreadId) return
    useCodeCanvasDesignSurface.getState().showDesignDocument(
      activeThreadId,
      workspaceRoot,
      activeDesignSurface.canonicalDocumentId,
      { canonicalDocumentId: activeDesignSurface.canonicalDocumentId }
    )
  }, [activeDesignSurface, activeThreadId, workspaceRoot])
  const continueHistoricalDocument = useCallback(() => {
    if (
      continuingHistorical || !activeDesignSurface?.readOnly ||
      activeDesignSurface.canonicalDocumentId ||
      !activeThreadId || !designDoc
    ) return
    const board = findDesignBoardArtifact(designDoc.artifacts)
    if (!board) {
      useDesignWorkspaceStore.getState().setFileError('The preview does not have a whiteboard to continue.')
      return
    }
    setContinuingHistorical(true)
    void (async () => {
      let prepared: PreparedDesignDocumentFork | null = null
      try {
        prepared = await cloneDesignDocumentForFork({
          workspaceRoot,
          sourceTarget: { documentId: designDoc.id, boardArtifactId: board.id },
          operation: { kind: 'bind', sourceId: activeThreadId, relation: 'bind' }
        })
        await useDesignWorkspaceStore.getState().rehydrateArtifacts()
        const target = prepared.designDocumentTarget
        const state = useDesignWorkspaceStore.getState()
        const cloned = state.documents.find((document) => document.id === target.documentId)
        if (!cloned || !cloned.artifacts.some(
          (artifact) => artifact.kind === 'canvas' && artifact.id === target.boardArtifactId
        )) throw new Error('The cloned whiteboard could not be loaded.')
        state.switchActiveDocument(target.documentId)
        useCodeCanvasDesignSurface.getState().showDesignDocument(
          activeThreadId,
          workspaceRoot,
          target.documentId,
          {
            canonicalDocumentId: target.documentId,
            ...(prepared.operationId
              ? { continuationOperationId: prepared.operationId }
              : {})
          }
        )
      } catch (error) {
        if (prepared) await prepared.cleanup().catch(() => undefined)
        useDesignWorkspaceStore.getState().setFileError(
          error instanceof Error ? error.message : String(error)
        )
      } finally {
        setContinuingHistorical(false)
      }
    })()
  }, [activeDesignSurface, activeThreadId, continuingHistorical, designDoc, workspaceRoot])

  if (designMode) {
    return (
      <aside className={codeCanvasPanelShellClass(className)}>
        <div className="pointer-events-none absolute left-3 right-3 top-3 z-50 flex min-w-0 items-start">
          <div className={codeCanvasPanelTitlebarClass()} data-code-canvas-titlebar="true">
            <button
              type="button"
              onClick={onCollapse}
              className="ds-sidebar-toggle-button shrink-0"
              aria-label={t('rightPanelCollapse')}
              title={t('rightPanelCollapse')}
            >
              <PanelRightClose className="h-4 w-4" strokeWidth={1.85} />
            </button>
            <div className="flex min-w-0 items-center gap-1.5 pl-1 pr-2">
              <Shapes className="h-4 w-4 shrink-0 text-accent" strokeWidth={1.8} />
              <span className="min-w-0 truncate text-[12.5px] font-medium text-ds-ink">
                {designDocTitle || t('rightPanelWhiteboard')}
              </span>
              {activeDesignSurface?.readOnly ? (
                <span className="shrink-0 rounded-full bg-ds-surface-subtle px-2 py-0.5 text-[10.5px] text-ds-muted">
                  {t('designViewPreview')}
                </span>
              ) : null}
              {activeDesignSurface?.readOnly && activeDesignSurface.canonicalDocumentId ? (
                <button
                  type="button"
                  onClick={returnToCanonicalDocument}
                  className="pointer-events-auto shrink-0 rounded-full px-2 py-1 text-[11px] font-medium text-accent hover:bg-ds-hover"
                >
                  {t('designReturnToTaskWhiteboard', { defaultValue: 'Return to task whiteboard' })}
                </button>
              ) : activeDesignSurface?.readOnly ? (
                <button
                  type="button"
                  disabled={continuingHistorical}
                  onClick={continueHistoricalDocument}
                  className="pointer-events-auto inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-1 text-[11px] font-medium text-accent hover:bg-ds-hover disabled:opacity-50"
                >
                  {continuingHistorical ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                  {t('designContinueInTask', { defaultValue: 'Continue in this task' })}
                </button>
              ) : null}
            </div>
          </div>
        </div>

        <div className="relative min-h-0 flex-1 overflow-hidden">
          {designDoc ? (
            <DesignDocumentCanvasSurface
              workspaceRoot={workspaceRoot}
              documentId={designDoc.id}
              activeThreadId={activeThreadId}
              readOnly={activeDesignSurface?.readOnly === true}
              busy={busy}
              onOpenAgentSettings={onOpenAgentSettings}
              onImplementDesign={onImplementDesign}
              onScreenCreated={onScreenCreated}
              onSvgCreated={onSvgCreated}
              onUseElementAsContext={onUseElementAsContext}
              onRuntimeQualityFindings={onRuntimeQualityFindings}
              onRequestQualityRepair={onRequestQualityRepair}
            />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
              <div className="rounded-full bg-ds-surface-subtle p-3 text-ds-faint dark:bg-white/6">
                <Shapes className="h-6 w-6" strokeWidth={1.65} />
              </div>
              <div className="max-w-64 text-[12px] leading-5 text-ds-muted">
                {t('designCanvasLoading')}
              </div>
            </div>
          )}
        </div>
      </aside>
    )
  }

  return (
    <aside className={codeCanvasPanelShellClass(className)}>
      <div className="pointer-events-none absolute left-3 right-3 top-3 z-50 flex min-w-0 items-start">
        <div className={codeCanvasPanelTitlebarClass()} data-code-canvas-titlebar="true">
          <button
            type="button"
            onClick={onCollapse}
            className="ds-sidebar-toggle-button shrink-0"
            aria-label={t('rightPanelCollapse')}
            title={t('rightPanelCollapse')}
          >
            <PanelRightClose className="h-4 w-4" strokeWidth={1.85} />
          </button>
          <div className="flex min-w-0 items-center gap-1.5 pl-1 pr-2">
            <Shapes className="h-4 w-4 shrink-0 text-accent" strokeWidth={1.8} />
            <span className="min-w-0 truncate text-[12.5px] font-medium text-ds-ink">
              {t('rightPanelWhiteboard')}
            </span>
          </div>
        </div>
      </div>

      <div className="relative min-h-0 flex-1 overflow-hidden">
        {ready ? (
          <>
            <CanvasViewport
              workspaceRoot={workspaceRoot}
              artifactId={artifactId}
              baseDir={CODE_CANVAS_DIR}
              designSystemBaseDir={designSystemBaseDir}
              surface="code"
            />
            <PropertiesPanel surface="code" />
          </>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
            <div className="rounded-full bg-ds-surface-subtle p-3 text-ds-faint dark:bg-white/6">
              <Shapes className="h-6 w-6" strokeWidth={1.65} />
            </div>
            <div className="max-w-64 text-[12px] leading-5 text-ds-muted">
              {t('codeCanvasPanelNeedsThread')}
            </div>
          </div>
        )}
      </div>
    </aside>
  )
}
