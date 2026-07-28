import { useEffect, useRef, type ReactElement } from 'react'
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  useNodesState,
  type Edge,
  type Node
} from '@xyflow/react'
import { MousePointer2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { reconcileInteractiveGraphNodes } from './graph-canvas-state'

export function GraphRunCanvas({
  runId,
  nodes: incomingNodes,
  edges,
  selectedNodeId,
  onSelectNode
}: {
  runId: string
  nodes: Node[]
  edges: Edge[]
  selectedNodeId: string | null
  onSelectNode: (nodeId: string | null) => void
}): ReactElement {
  const { t } = useTranslation('common')
  const scopeRef = useRef(runId)
  const layoutNodesRef = useRef(new Map<string, Node>())
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
    <div className="relative h-full min-h-[260px] w-full">
      <ReactFlow
        className="ds-workflow-canvas"
        aria-label={t('graphCanvasLabel')}
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        fitView
        fitViewOptions={{ minZoom: 0.72, maxZoom: 1, padding: 0.18 }}
        minZoom={0.3}
        maxZoom={2}
        nodesDraggable
        nodesConnectable={false}
        panOnDrag
        zoomOnScroll
        zoomOnPinch
        zoomOnDoubleClick
        selectionOnDrag
        onlyRenderVisibleElements
        elementsSelectable
        onPaneClick={() => onSelectNode(null)}
        onNodeClick={(_, node) => onSelectNode(node.id)}
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
        <Controls showInteractive={false} />
      </ReactFlow>
      <div className="pointer-events-none absolute left-3 top-3 flex items-center gap-1.5 rounded-lg border border-ds-border-muted bg-ds-card/90 px-2 py-1 text-[9px] text-ds-faint shadow-sm backdrop-blur">
        <MousePointer2 className="h-3 w-3" />
        {t('graphCanvasHelp')}
      </div>
    </div>
  )
}
