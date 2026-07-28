import { useEffect, useRef, useState, type ReactElement } from 'react'
import {
  Background,
  BackgroundVariant,
  MiniMap,
  ReactFlow,
  useNodesState,
  type Edge,
  type Node,
  type ReactFlowInstance
} from '@xyflow/react'
import {
  Hand,
  ListTree,
  MousePointer2,
  PanelRightOpen,
  Scan
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { reconcileInteractiveGraphNodes } from './graph-canvas-state'

export type GraphCanvasMode = 'select' | 'pan'

export function GraphRunCanvas({
  runId,
  nodes: incomingNodes,
  edges,
  selectedNodeId,
  onSelectNode,
  onOpenInspector
}: {
  runId: string
  nodes: Node[]
  edges: Edge[]
  selectedNodeId: string | null
  onSelectNode: (nodeId: string | null) => void
  onOpenInspector: () => void
}): ReactElement {
  const { t } = useTranslation('common')
  const scopeRef = useRef(runId)
  const layoutNodesRef = useRef(new Map<string, Node>())
  const flowRef = useRef<ReactFlowInstance<Node, Edge> | null>(null)
  const [mode, setMode] = useState<GraphCanvasMode>('pan')
  const [nodes, setNodes, onNodesChange] = useNodesState(
    reconcileInteractiveGraphNodes([], incomingNodes, selectedNodeId)
  )

  useEffect(() => {
    for (const node of nodes) layoutNodesRef.current.set(node.id, node)
  }, [nodes])

  useEffect(() => {
    setNodes((current) => {
      const sameRun = scopeRef.current === runId
      scopeRef.current = runId
      if (!sameRun) layoutNodesRef.current.clear()
      return reconcileInteractiveGraphNodes(
        sameRun ? [...layoutNodesRef.current.values(), ...current] : [],
        incomingNodes,
        selectedNodeId
      )
    })
  }, [incomingNodes, runId, selectedNodeId, setNodes])

  return (
    <div
      className="graph-run-canvas ds-no-drag relative h-full min-h-[320px] w-full"
      data-mode={mode}
      data-graph-interaction-root
    >
      <ReactFlow
        className="ds-workflow-canvas graph-flow"
        aria-label={t('graphCanvasLabel')}
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onInit={(instance) => {
          flowRef.current = instance
        }}
        fitView
        fitViewOptions={{ minZoom: 0.6, maxZoom: 1, padding: 0.22 }}
        minZoom={0.25}
        maxZoom={2.4}
        nodesDraggable={mode === 'select'}
        nodesConnectable={false}
        panOnDrag={mode === 'pan' ? [0, 1, 2] : [1, 2]}
        zoomOnScroll
        zoomOnPinch
        zoomOnDoubleClick
        selectionOnDrag={mode === 'select'}
        onlyRenderVisibleElements
        elementsSelectable
        onPaneClick={() => onSelectNode(null)}
        onNodeClick={(_, node) => onSelectNode(node.id)}
        onNodeDragStart={(_, node) => onSelectNode(node.id)}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
        <MiniMap
          pannable
          zoomable
          className="ds-workflow-minimap"
          style={{ width: 150, height: 96 }}
          nodeColor="var(--ds-accent)"
          nodeStrokeColor="transparent"
          nodeBorderRadius={3}
          maskColor="rgb(15 23 42 / 0.08)"
        />
      </ReactFlow>

      <div
        role="toolbar"
        aria-label={t('graphCanvasTools')}
        className="graph-canvas-toolbar absolute left-3 top-3 z-10 flex items-center gap-1 rounded-xl border border-ds-border-muted bg-ds-card/95 p-1 shadow-lg backdrop-blur"
      >
        <CanvasToolButton
          label={t('graphCanvasSelect')}
          active={mode === 'select'}
          onClick={() => setMode('select')}
        >
          <MousePointer2 />
        </CanvasToolButton>
        <CanvasToolButton
          label={t('graphCanvasPan')}
          active={mode === 'pan'}
          onClick={() => setMode('pan')}
        >
          <Hand />
        </CanvasToolButton>
        <span aria-hidden className="mx-0.5 h-5 w-px bg-ds-border-muted" />
        <CanvasToolButton
          label={t('graphCanvasFit')}
          onClick={() => {
            void flowRef.current?.fitView({ minZoom: 0.6, maxZoom: 1, padding: 0.22 })
          }}
        >
          <Scan />
        </CanvasToolButton>
        <CanvasToolButton label={t('graphOpenInspector')} onClick={onOpenInspector}>
          <PanelRightOpen />
        </CanvasToolButton>
      </div>

      <div className="pointer-events-none absolute bottom-3 left-3 z-10 hidden items-center gap-1.5 rounded-lg border border-ds-border-muted bg-ds-card/90 px-2 py-1 text-[9px] text-ds-faint shadow-sm backdrop-blur sm:flex">
        <ListTree className="h-3 w-3" />
        {mode === 'pan' ? t('graphCanvasPanHelp') : t('graphCanvasSelectHelp')}
      </div>
    </div>
  )
}

function CanvasToolButton({
  label,
  active = false,
  onClick,
  children
}: {
  label: string
  active?: boolean
  onClick: () => void
  children: ReactElement
}): ReactElement {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active || undefined}
      onClick={onClick}
      className={`flex h-8 min-w-8 items-center justify-center gap-1.5 rounded-lg px-2 text-[10px] font-semibold transition ${
        active
          ? 'bg-indigo-600 text-white shadow-sm'
          : 'text-ds-muted hover:bg-ds-hover hover:text-ds-ink'
      } [&_svg]:h-3.5 [&_svg]:w-3.5`}
    >
      {children}
    </button>
  )
}
