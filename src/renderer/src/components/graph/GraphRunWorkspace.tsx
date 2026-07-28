import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement
} from 'react'
import type { Edge, Node } from '@xyflow/react'
import { PanelRightClose, Send, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type {
  GraphArtifactPage,
  GraphNodeProjection,
  GraphPatchOperation,
  GraphRun
} from '../../graph/graph-types'
import {
  captureResizePointer,
  WORKBENCH_RESIZE_CLASS
} from '../workbench-layout'
import { GraphNodeInspector } from './GraphNodeInspector'
import { plannedAssignmentLabel } from './graph-elements'
import {
  clampGraphInspectorWidth,
  DEFAULT_GRAPH_INSPECTOR_WIDTH,
  GRAPH_INSPECTOR_OVERLAY_BREAKPOINT,
  MAX_GRAPH_INSPECTOR_WIDTH,
  MIN_GRAPH_INSPECTOR_WIDTH
} from './graph-workspace-layout'
import { GraphRunCanvas } from './GraphRunCanvas'
import { GraphRunInspector } from './GraphRunInspector'
import { StatusPill } from './graph-panel-shared'

export function GraphRunWorkspace({
  run,
  elements,
  listFallback,
  selectedNode,
  selectedNodeId,
  steering,
  onSteeringChange,
  onSendSteering,
  onSelectNode,
  onRetry,
  onReview,
  onPatch,
  onRebind,
  onOpenChild,
  artifactPage,
  artifactContent,
  artifactLoading,
  onOpenArtifact,
  onNextArtifactPage,
  onCloseArtifact
}: {
  run: GraphRun
  elements: { nodes: Node[]; edges: Edge[] }
  listFallback: boolean
  selectedNode?: GraphNodeProjection
  selectedNodeId: string | null
  steering: string
  onSteeringChange: (value: string) => void
  onSendSteering: () => void
  onSelectNode: (nodeId: string | null) => void
  onRetry: (nodeId: string) => void
  onReview: (nodeId: string, outcome: 'pass' | 'fail') => void
  onPatch: (operations: GraphPatchOperation[], reason: string) => Promise<void>
  onRebind: (nodeId: string, profileId: string) => void
  onOpenChild: (threadId: string) => void
  artifactPage: GraphArtifactPage | null
  artifactContent: string
  artifactLoading: boolean
  onOpenArtifact: (artifactId: string) => void
  onNextArtifactPage: () => void
  onCloseArtifact: () => void
}): ReactElement {
  const { t } = useTranslation('common')
  const workspaceRef = useRef<HTMLDivElement>(null)
  const [containerWidth, setContainerWidth] = useState(900)
  const [inspectorWidth, setInspectorWidth] = useState(DEFAULT_GRAPH_INSPECTOR_WIDTH)
  const [inspectorOpen, setInspectorOpen] = useState(false)

  useEffect(() => {
    const target = workspaceRef.current
    if (!target) return
    const update = (): void => {
      const width = target.clientWidth
      if (width <= 0) return
      setContainerWidth(width)
      setInspectorWidth((current) => clampGraphInspectorWidth(current, width))
    }
    update()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(update)
    observer.observe(target)
    return () => observer.disconnect()
  }, [])

  const resizeInspector = (requested: number): void => {
    setInspectorWidth(clampGraphInspectorWidth(requested, containerWidth))
  }
  const beginResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    event.preventDefault()
    const startX = event.clientX
    const startWidth = inspectorWidth
    const releasePointer = captureResizePointer(event.currentTarget, event.pointerId)
    const previousCursor = document.body.style.cursor
    const previousUserSelect = document.body.style.userSelect
    document.body.classList.add(WORKBENCH_RESIZE_CLASS)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    const onMove = (moveEvent: PointerEvent): void => {
      resizeInspector(startWidth + startX - moveEvent.clientX)
    }
    const onEnd = (): void => {
      releasePointer()
      document.body.classList.remove(WORKBENCH_RESIZE_CLASS)
      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousUserSelect
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onEnd)
      window.removeEventListener('pointercancel', onEnd)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onEnd)
    window.addEventListener('pointercancel', onEnd)
  }
  const resizeWithKeyboard = (event: KeyboardEvent<HTMLDivElement>): void => {
    const delta = event.shiftKey ? 64 : 24
    if (event.key === 'ArrowLeft') resizeInspector(inspectorWidth + delta)
    else if (event.key === 'ArrowRight') resizeInspector(inspectorWidth - delta)
    else if (event.key === 'Home') resizeInspector(MIN_GRAPH_INSPECTOR_WIDTH)
    else if (event.key === 'End') resizeInspector(MAX_GRAPH_INSPECTOR_WIDTH)
    else return
    event.preventDefault()
  }
  const plan = run.plans.at(-1)
  const visibleNodeIds = new Set(elements.nodes.map((node) => node.id))
  const minimum = clampGraphInspectorWidth(MIN_GRAPH_INSPECTOR_WIDTH, containerWidth)
  const maximum = clampGraphInspectorWidth(MAX_GRAPH_INSPECTOR_WIDTH, containerWidth)
  const inspectorIsOverlay = containerWidth < GRAPH_INSPECTOR_OVERLAY_BREAKPOINT
  const selectNode = (nodeId: string | null): void => {
    onSelectNode(nodeId)
  }
  const inspectNode = (nodeId: string): void => {
    onSelectNode(nodeId)
    setInspectorOpen(true)
  }

  return (
    <div
      ref={workspaceRef}
      className="graph-run-workspace ds-no-drag relative flex min-h-[320px] min-w-0 flex-1 overflow-hidden bg-ds-main"
      data-inspector-layout={inspectorIsOverlay ? 'overlay' : 'split'}
      data-inspector-open={inspectorOpen}
    >
      <div className="min-w-0 flex-1">
        {listFallback ? (
          <div role="list" aria-label={t('graphListFallback')} className="h-full overflow-y-auto p-3">
            {plan?.nodes.filter((node) => visibleNodeIds.has(node.id)).map((node) => (
              <button
                key={node.id}
                type="button"
                role="listitem"
                aria-current={selectedNodeId === node.id}
                onClick={() => selectNode(node.id)}
                onDoubleClick={() => inspectNode(node.id)}
                className={`mb-1.5 flex w-full items-center justify-between gap-3 rounded-lg border bg-ds-card px-3 py-2 text-left ${
                  selectedNodeId === node.id
                    ? 'border-indigo-500 ring-2 ring-indigo-500/15'
                    : 'border-ds-border-muted'
                }`}
              >
                <span className="min-w-0">
                  <span className="block truncate text-[11px] font-semibold text-ds-ink">
                    {node.title}
                  </span>
                  <span className="block truncate text-[9px] text-ds-faint">
                    {plan.phases.find((phase) => phase.id === node.phaseId)?.title}
                    {' · '}{node.kind}{' · '}{plannedAssignmentLabel(node)}
                  </span>
                </span>
                <StatusPill status={run.nodes[node.id]?.status ?? 'pending'} />
              </button>
            ))}
          </div>
        ) : (
          <GraphRunCanvas
            runId={run.id}
            nodes={elements.nodes}
            edges={elements.edges}
            selectedNodeId={selectedNodeId}
            onSelectNode={selectNode}
            onInspectNode={inspectNode}
            onOpenInspector={() => setInspectorOpen(true)}
          />
        )}
      </div>

      {inspectorOpen && !inspectorIsOverlay ? (
        <div
          role="separator"
          aria-label={t('graphResizeInspector')}
          aria-orientation="vertical"
          aria-valuemin={minimum}
          aria-valuemax={maximum}
          aria-valuenow={Math.round(inspectorWidth)}
          tabIndex={0}
          title={t('graphResizeInspector')}
          className="graph-inspector-divider ds-no-drag relative z-20 w-1.5 shrink-0 cursor-col-resize focus:outline-none focus:ring-2 focus:ring-inset focus:ring-indigo-500"
          onPointerDown={beginResize}
          onKeyDown={resizeWithKeyboard}
          onDoubleClick={() => resizeInspector(DEFAULT_GRAPH_INSPECTOR_WIDTH)}
        />
      ) : null}

      {inspectorOpen ? (
        <>
          {inspectorIsOverlay ? (
            <button
              type="button"
              className="absolute inset-0 z-20 bg-slate-950/10 backdrop-blur-[1px]"
              aria-label={t('graphCloseInspector')}
              onClick={() => setInspectorOpen(false)}
            />
          ) : null}
          <aside
            aria-label={selectedNode ? t('graphNodeDetails') : t('graphRunDetails')}
            className={`graph-run-inspector ds-no-drag flex min-h-0 shrink-0 flex-col bg-ds-sidebar ${
              inspectorIsOverlay
                ? 'absolute inset-y-2 right-2 z-30 rounded-2xl border border-ds-border-muted shadow-2xl'
                : ''
            }`}
            style={{
              width: inspectorIsOverlay
                ? Math.max(280, Math.min(380, containerWidth - 24))
                : inspectorWidth
            }}
          >
            <header className="flex h-11 shrink-0 items-center justify-between border-b border-ds-border-muted px-3">
              <div className="min-w-0">
                <div className="truncate text-[11px] font-semibold text-ds-ink">
                  {selectedNode?.node.title ?? t('graphRunDetails')}
                </div>
                <div className="text-[9px] text-ds-faint">
                  {selectedNode ? t('graphNodeDetails') : t('graphInspectorRunOverview')}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setInspectorOpen(false)}
                className="flex h-7 w-7 items-center justify-center rounded-lg text-ds-muted transition hover:bg-ds-hover hover:text-ds-ink"
                aria-label={t('graphCloseInspector')}
                title={t('graphCloseInspector')}
              >
                {inspectorIsOverlay
                  ? <X className="h-3.5 w-3.5" />
                  : <PanelRightClose className="h-3.5 w-3.5" />}
              </button>
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {selectedNode ? (
                <GraphNodeInspector
                  run={run}
                  node={selectedNode}
                  onRetry={() => onRetry(selectedNode.node.id)}
                  onReview={(outcome) => onReview(selectedNode.node.id, outcome)}
                  onRebind={(profileId) => onRebind(selectedNode.node.id, profileId)}
                  onOpenChild={onOpenChild}
                  artifactPage={artifactPage}
                  artifactContent={artifactContent}
                  artifactLoading={artifactLoading}
                  onOpenArtifact={onOpenArtifact}
                  onNextArtifactPage={onNextArtifactPage}
                  onCloseArtifact={onCloseArtifact}
                />
              ) : (
                <GraphRunInspector run={run} onPatch={onPatch} />
              )}
            </div>
            <div className="flex shrink-0 items-end gap-2 border-t border-ds-border-muted bg-ds-card/50 p-3">
              <textarea
                value={steering}
                onChange={(event) => onSteeringChange(event.target.value)}
                rows={2}
                placeholder={selectedNodeId
                  ? t('graphSteerNodePlaceholder')
                  : t('graphSteerRunPlaceholder')}
                className="min-w-0 flex-1 resize-none rounded-xl border border-ds-border-muted bg-ds-card px-2.5 py-2 text-[11px] text-ds-ink outline-none focus:border-indigo-400"
              />
              <button
                type="button"
                disabled={!steering.trim()}
                onClick={onSendSteering}
                className="flex h-9 w-9 items-center justify-center rounded-xl bg-indigo-600 text-white shadow-sm transition hover:bg-indigo-500 disabled:opacity-40"
                aria-label={t('graphSendSteering')}
              >
                <Send className="h-3.5 w-3.5" />
              </button>
            </div>
          </aside>
        </>
      ) : null}
    </div>
  )
}
