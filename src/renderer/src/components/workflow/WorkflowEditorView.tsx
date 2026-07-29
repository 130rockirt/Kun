import type { DragEvent, ReactElement } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow,
  type Connection,
  type EdgeChange,
  type NodeChange,
  type OnConnectEnd,
  type OnConnectStart
} from '@xyflow/react'
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  History,
  MousePointerClick,
  Play,
  Plus,
  Save,
  Settings2,
  Square,
  Variable,
  X
} from 'lucide-react'
import type {
  AppSettingsV1,
  WorkflowCustomModuleV1,
  WorkflowEnvVarV1,
  WorkflowNodeKind,
  WorkflowNodePresetV1,
  WorkflowNodeRunResultV1,
  WorkflowNodeRunStatus,
  WorkflowNodeV1,
  WorkflowV1
} from '@shared/app-settings'
import {
  NODE_ICONS,
  WorkflowNodeActionsContext,
  WorkflowRunStatusContext,
  workflowNodeTypes,
  type WorkflowNodeActions
} from './WorkflowNodes'
import { NodeConfigPanel } from './NodeConfigPanel'
import { ModuleManager } from './ModuleManager'
import { WorkflowRunHistory } from './WorkflowRunHistory'
import { WorkflowRunLogPanel } from './WorkflowRunLogPanel'
import {
  TRIGGER_KINDS,
  WORKFLOW_PALETTE,
  WORKFLOW_PALETTE_GROUPS,
  createCustomNode,
  createNodeFromPreset,
  createWorkflowNode,
  flowToWorkflowGraph,
  presetFromNode,
  presetUid,
  toFlowEdges,
  toFlowNodes,
  type WorkflowFlowEdge,
  type WorkflowFlowNode
} from './workflow-types'

type ConnectMenuState = {
  x: number
  y: number
  flowPos: { x: number; y: number }
  sourceId: string
  sourceHandle: string
}

const DND_MIME = 'application/x-workflow-node'
const PRESET_DND_MIME = 'application/x-workflow-preset'
const MODULE_DND_MIME = 'application/x-workflow-module'

export const WORKFLOW_EDITOR_HEADER_CLASS =
  'workflow-editor-header ds-drag flex shrink-0 items-center gap-3 border-b border-ds-border px-4'
export const WORKFLOW_EDITOR_HEADER_SIDEBAR_COLLAPSED_CLASS =
  'workflow-editor-header-sidebar-collapsed'
export const WORKFLOW_EDITOR_SIDEBAR_CLASS =
  'workflow-editor-sidebar ds-sidebar-surface ds-drag flex w-[184px] shrink-0 flex-col border-r border-ds-border'
export const WORKFLOW_EDITOR_BACK_BUTTON_CLASS =
  'workflow-editor-back-button ds-no-drag flex h-9 items-center gap-2 rounded-xl px-2 text-[13px] font-medium text-ds-muted transition hover:bg-ds-hover hover:text-ds-ink'

type WorkflowConnectionsArg = ReturnType<typeof flowToWorkflowGraph>['connections']

type Props = {
  workflow: WorkflowV1
  settings: AppSettingsV1
  runStatus: Record<string, WorkflowNodeRunStatus>
  lastResults: Record<string, WorkflowNodeRunResultV1>
  /** Live per-node results during a run (input/output/timing) for the run-log panel. */
  liveResults: Record<string, WorkflowNodeRunResultV1>
  running: boolean
  onPersist: (patch: {
    name: string
    enabled: boolean
    env: WorkflowEnvVarV1[]
    nodes: WorkflowNodeV1[]
    connections: WorkflowConnectionsArg
  }) => Promise<void>
  onRun: () => Promise<void> | void
  onRunNode: (nodeId: string) => Promise<void> | void
  onStop: () => Promise<void> | void
  onBack: () => void
  presets: WorkflowNodePresetV1[]
  onSavePreset: (preset: WorkflowNodePresetV1) => void | Promise<void>
  onDeletePreset: (presetId: string) => void | Promise<void>
  modules: WorkflowCustomModuleV1[]
  onSaveModules: (modules: WorkflowCustomModuleV1[]) => void | Promise<void>
}

function WorkflowEditorInner({
  workflow,
  settings,
  runStatus,
  lastResults,
  liveResults,
  running,
  onPersist,
  onRun,
  onRunNode,
  onStop,
  onBack,
  presets,
  onSavePreset,
  onDeletePreset,
  modules,
  onSaveModules
}: Props): ReactElement {
  const { t } = useTranslation('common')
  const { screenToFlowPosition } = useReactFlow()
  const [name, setName] = useState(workflow.name)
  const [enabled, setEnabled] = useState(workflow.enabled)
  const [env, setEnv] = useState<WorkflowEnvVarV1[]>(workflow.env)
  const [rfNodes, setRfNodes] = useState<WorkflowFlowNode[]>(() => toFlowNodes(workflow.nodes))
  const [rfEdges, setRfEdges] = useState<WorkflowFlowEdge[]>(() => toFlowEdges(workflow.connections))
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [connectMenu, setConnectMenu] = useState<ConnectMenuState | null>(null)
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(() => new Set())
  const [showModules, setShowModules] = useState(false)
  const [showEnv, setShowEnv] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [rightTab, setRightTab] = useState<'config' | 'log'>('config')
  // Live results win during a run; fall back to the last persisted run when idle.
  const logResults = Object.keys(liveResults).length > 0 ? liveResults : lastResults
  // Jump to the run log when a run starts.
  useEffect(() => {
    if (running) setRightTab('log')
  }, [running])
  // Selecting a node jumps back to its config.
  useEffect(() => {
    if (selectedNodeId) setRightTab('config')
  }, [selectedNodeId])
  const [leftPanelCollapsed, setLeftPanelCollapsed] = useState(false)
  const [rightPanelCollapsed, setRightPanelCollapsed] = useState(false)
  const connectingRef = useRef<{ nodeId: string; handleId: string } | null>(null)

  const toggleGroup = useCallback((groupId: string): void => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(groupId)) next.delete(groupId)
      else next.add(groupId)
      return next
    })
  }, [])

  const styledEdges = useMemo(
    () => toFlowEdges(flowToWorkflowGraph(rfNodes, rfEdges).connections, runStatus),
    [rfEdges, rfNodes, runStatus]
  )

  const selectedNode = useMemo(
    () => (selectedNodeId ? rfNodes.find((node) => node.id === selectedNodeId)?.data.node ?? null : null),
    [rfNodes, selectedNodeId]
  )

  // Reverse-BFS the edges so the variable picker only offers reachable upstream nodes.
  const upstreamNodes = useMemo(() => {
    if (!selectedNodeId) return []
    const incoming = new Map<string, string[]>()
    for (const edge of rfEdges) {
      const sources = incoming.get(edge.target) ?? []
      sources.push(edge.source)
      incoming.set(edge.target, sources)
    }
    const seen = new Set<string>()
    const queue = [...(incoming.get(selectedNodeId) ?? [])]
    while (queue.length) {
      const id = queue.shift() as string
      if (seen.has(id)) continue
      seen.add(id)
      for (const source of incoming.get(id) ?? []) queue.push(source)
    }
    return rfNodes
      .filter((node) => seen.has(node.id))
      .map((node) => ({
        id: node.data.node.id,
        name: node.data.node.name,
        type: node.data.node.type,
        node: node.data.node
      }))
  }, [rfEdges, rfNodes, selectedNodeId])

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setRfNodes((nodes) => applyNodeChanges(changes, nodes) as WorkflowFlowNode[])
    if (changes.some((change) => change.type !== 'select' && change.type !== 'dimensions')) {
      setDirty(true)
    }
  }, [])

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    setRfEdges((edges) => applyEdgeChanges(changes, edges) as WorkflowFlowEdge[])
    if (changes.some((change) => change.type !== 'select')) setDirty(true)
  }, [])

  const onConnect = useCallback((connection: Connection) => {
    setRfEdges((edges) => addEdge(connection, edges) as WorkflowFlowEdge[])
    setDirty(true)
  }, [])

  const onConnectStart = useCallback<OnConnectStart>((_, params) => {
    connectingRef.current = params.nodeId
      ? { nodeId: params.nodeId, handleId: params.handleId ?? 'out' }
      : null
  }, [])

  // Dragging a connection onto empty canvas opens a picker to add + connect the next node (n8n-style).
  const onConnectEnd = useCallback<OnConnectEnd>(
    (event) => {
      const source = connectingRef.current
      connectingRef.current = null
      if (!source) return
      const target = event.target as HTMLElement | null
      if (!target || !target.classList.contains('react-flow__pane')) return
      const clientX = 'clientX' in event ? event.clientX : 0
      const clientY = 'clientY' in event ? event.clientY : 0
      setConnectMenu({
        x: clientX,
        y: clientY,
        flowPos: screenToFlowPosition({ x: clientX, y: clientY }),
        sourceId: source.nodeId,
        sourceHandle: source.handleId
      })
    },
    [screenToFlowPosition]
  )

  const addConnectedNode = useCallback(
    (kind: WorkflowNodeKind) => {
      // Compute the node ONCE here, not inside a setState updater: React double-invokes
      // updaters (StrictMode/concurrent), which would create the node + edge twice.
      if (!connectMenu) return
      const node = createWorkflowNode(kind, connectMenu.flowPos)
      setRfNodes((nodes) => [...nodes, { id: node.id, type: node.type, position: node.position, data: { node } }])
      setRfEdges(
        (edges) =>
          addEdge(
            { source: connectMenu.sourceId, sourceHandle: connectMenu.sourceHandle, target: node.id, targetHandle: 'in' },
            edges
          ) as WorkflowFlowEdge[]
      )
      setSelectedNodeId(node.id)
      setDirty(true)
      setConnectMenu(null)
    },
    [connectMenu]
  )

  const insertNode = useCallback((kind: WorkflowNodeKind, position: { x: number; y: number }) => {
    const node = createWorkflowNode(kind, position)
    setRfNodes((nodes) => [...nodes, { id: node.id, type: node.type, position: node.position, data: { node } }])
    setSelectedNodeId(node.id)
    setDirty(true)
  }, [])

  const insertPresetNode = useCallback((preset: WorkflowNodePresetV1, position: { x: number; y: number }) => {
    const node = createNodeFromPreset(preset, position)
    setRfNodes((nodes) => [...nodes, { id: node.id, type: node.type, position: node.position, data: { node } }])
    setSelectedNodeId(node.id)
    setDirty(true)
  }, [])

  const addPresetNode = useCallback(
    (preset: WorkflowNodePresetV1) => {
      const offset = rfNodes.length * 28
      insertPresetNode(preset, { x: 360 + (offset % 180), y: 140 + offset })
    },
    [insertPresetNode, rfNodes.length]
  )

  const onPresetDragStart = useCallback((event: DragEvent, presetId: string) => {
    event.dataTransfer.setData(PRESET_DND_MIME, presetId)
    event.dataTransfer.effectAllowed = 'move'
  }, [])

  const insertModuleNode = useCallback((module: WorkflowCustomModuleV1, position: { x: number; y: number }) => {
    const node = createCustomNode(module, position)
    setRfNodes((nodes) => [...nodes, { id: node.id, type: node.type, position: node.position, data: { node } }])
    setSelectedNodeId(node.id)
    setDirty(true)
  }, [])

  const addModuleNode = useCallback(
    (module: WorkflowCustomModuleV1) => {
      const offset = rfNodes.length * 28
      insertModuleNode(module, { x: 360 + (offset % 180), y: 140 + offset })
    },
    [insertModuleNode, rfNodes.length]
  )

  const onModuleDragStart = useCallback((event: DragEvent, moduleId: string) => {
    event.dataTransfer.setData(MODULE_DND_MIME, moduleId)
    event.dataTransfer.effectAllowed = 'move'
  }, [])

  const handleSavePreset = useCallback(
    (node: WorkflowNodeV1, label: string) => {
      void onSavePreset(presetFromNode(presetUid(), label, node))
    },
    [onSavePreset]
  )

  const addNode = useCallback(
    (kind: WorkflowNodeKind) => {
      const offset = rfNodes.length * 28
      insertNode(kind, { x: 360 + (offset % 180), y: 140 + offset })
    },
    [insertNode, rfNodes.length]
  )

  const onPaletteDragStart = useCallback((event: DragEvent, kind: WorkflowNodeKind) => {
    event.dataTransfer.setData(DND_MIME, kind)
    event.dataTransfer.effectAllowed = 'move'
  }, [])

  const onCanvasDragOver = useCallback((event: DragEvent) => {
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
  }, [])

  const onCanvasDrop = useCallback(
    (event: DragEvent) => {
      event.preventDefault()
      const presetId = event.dataTransfer.getData(PRESET_DND_MIME)
      if (presetId) {
        const preset = presets.find((item) => item.id === presetId)
        if (preset) insertPresetNode(preset, screenToFlowPosition({ x: event.clientX, y: event.clientY }))
        return
      }
      const moduleId = event.dataTransfer.getData(MODULE_DND_MIME)
      if (moduleId) {
        const module = modules.find((item) => item.id === moduleId)
        if (module) insertModuleNode(module, screenToFlowPosition({ x: event.clientX, y: event.clientY }))
        return
      }
      const kind = event.dataTransfer.getData(DND_MIME) as WorkflowNodeKind
      if (!kind || !WORKFLOW_PALETTE.includes(kind)) return
      insertNode(kind, screenToFlowPosition({ x: event.clientX, y: event.clientY }))
    },
    [insertModuleNode, insertNode, insertPresetNode, modules, presets, screenToFlowPosition]
  )

  const handleNodeChange = useCallback((updated: WorkflowNodeV1) => {
    setRfNodes((nodes) =>
      nodes.map((node) => (node.id === updated.id ? { ...node, type: updated.type, data: { node: updated } } : node))
    )
    setDirty(true)
  }, [])

  const handleDeleteNode = useCallback((nodeId: string) => {
    setRfNodes((nodes) => nodes.filter((node) => node.id !== nodeId))
    setRfEdges((edges) => edges.filter((edge) => edge.source !== nodeId && edge.target !== nodeId))
    setSelectedNodeId((current) => (current === nodeId ? null : current))
    setDirty(true)
  }, [])

  const handleToggleDisabled = useCallback((nodeId: string) => {
    setRfNodes((nodes) =>
      nodes.map((node) =>
        node.id === nodeId
          ? { ...node, data: { node: { ...node.data.node, disabled: !node.data.node.disabled } } }
          : node
      )
    )
    setDirty(true)
  }, [])

  const buildGraph = useCallback(() => {
    const graph = flowToWorkflowGraph(rfNodes, rfEdges)
    return { name: name.trim() || t('workflowUntitled'), enabled, env, nodes: graph.nodes, connections: graph.connections }
  }, [enabled, env, name, rfEdges, rfNodes, t])

  const handleSave = useCallback(async () => {
    setSaving(true)
    try {
      await onPersist(buildGraph())
      setDirty(false)
    } finally {
      setSaving(false)
    }
  }, [buildGraph, onPersist])

  const handleRun = useCallback(async () => {
    await onPersist(buildGraph())
    setDirty(false)
    await onRun()
  }, [buildGraph, onPersist, onRun])

  const handleRunNode = useCallback(
    async (nodeId: string) => {
      await onPersist(buildGraph())
      setDirty(false)
      await onRunNode(nodeId)
    },
    [buildGraph, onPersist, onRunNode]
  )

  const nodeActions = useMemo<WorkflowNodeActions>(
    () => ({
      runNode: (nodeId) => void handleRunNode(nodeId),
      toggleDisabled: handleToggleDisabled,
      deleteNode: handleDeleteNode
    }),
    [handleDeleteNode, handleRunNode, handleToggleDisabled]
  )

  return (
    <div className="workflow-editor-overlay ds-no-drag ds-titlebar-fixed-overlay fixed inset-x-0 bottom-0 top-0 z-[60] flex bg-ds-main">
      {!leftPanelCollapsed ? (
        <aside className={WORKFLOW_EDITOR_SIDEBAR_CLASS}>
          <div className="workflow-editor-sidebar-header shrink-0 px-2 pb-2 pt-3">
            <div aria-hidden className="ds-titlebar-safe-block" />
            <button type="button" onClick={onBack} className={WORKFLOW_EDITOR_BACK_BUTTON_CLASS}>
              <ArrowLeft className="h-4 w-4" strokeWidth={1.8} />
              {t('workflowBack')}
            </button>
          </div>
          <div className="workflow-editor-palette ds-no-drag flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-2 pb-3">
            <span className="workflow-editor-palette-title px-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-ds-faint">
              {t('workflowPalette')}
            </span>
            {WORKFLOW_PALETTE_GROUPS.map((group) => {
              const collapsed = collapsedGroups.has(group.id)
              return (
                <div key={group.id} className="workflow-editor-palette-group flex flex-col">
                  <button
                    type="button"
                    onClick={() => toggleGroup(group.id)}
                    className="workflow-editor-palette-group-toggle flex items-center gap-1 px-2 py-1 text-[10.5px] font-semibold uppercase tracking-wide text-ds-faint transition hover:text-ds-muted"
                  >
                    <ChevronRight
                      className={`h-3 w-3 shrink-0 transition-transform ${collapsed ? '' : 'rotate-90'}`}
                      strokeWidth={2}
                    />
                    <span className="min-w-0 flex-1 truncate text-left">{t(`workflowGroup_${group.id}`)}</span>
                  </button>
                  {!collapsed
                    ? group.kinds.map((kind) => {
                        const Icon = NODE_ICONS[kind]
                        return (
                          <button
                            key={kind}
                            type="button"
                            draggable
                            onDragStart={(event) => onPaletteDragStart(event, kind)}
                            onClick={() => addNode(kind)}
                            className="workflow-editor-palette-item flex cursor-grab items-center gap-2 rounded-lg border border-transparent px-2 py-1.5 text-left text-[12.5px] text-ds-ink transition hover:border-ds-border hover:bg-ds-hover active:cursor-grabbing"
                          >
                            <span className="workflow-editor-palette-icon flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-accent/10 text-accent">
                              <Icon className="h-3.5 w-3.5" strokeWidth={1.9} />
                            </span>
                            <span className="min-w-0 flex-1 truncate">{t(`workflowNode_${kind}`)}</span>
                            <Plus className="h-3.5 w-3.5 shrink-0 text-ds-faint" strokeWidth={1.8} />
                          </button>
                        )
                      })
                    : null}
                </div>
              )
            })}

            <div className="flex flex-col">
              <div className="flex items-center gap-1 pr-1">
                <button
                  type="button"
                  onClick={() => toggleGroup('custom')}
                  className="workflow-editor-palette-group-toggle flex min-w-0 flex-1 items-center gap-1 px-2 py-1 text-[10.5px] font-semibold uppercase tracking-wide text-ds-faint transition hover:text-ds-muted"
                >
                  <ChevronRight
                    className={`h-3 w-3 shrink-0 transition-transform ${collapsedGroups.has('custom') ? '' : 'rotate-90'}`}
                    strokeWidth={2}
                  />
                  <span className="min-w-0 flex-1 truncate text-left">{t('workflowGroup_custom')}</span>
                </button>
                <button
                  type="button"
                  onClick={() => setShowModules(true)}
                  title={t('workflowModulesManage')}
                  aria-label={t('workflowModulesManage')}
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-ds-faint transition hover:bg-ds-hover hover:text-ds-ink"
                >
                  <Settings2 className="h-3.5 w-3.5" strokeWidth={1.8} />
                </button>
              </div>
              {!collapsedGroups.has('custom') ? (
                <>
                  {modules.map((module) => {
                    const Icon = NODE_ICONS.custom
                    return (
                      <button
                        key={module.id}
                        type="button"
                        draggable
                        onDragStart={(event) => onModuleDragStart(event, module.id)}
                        onClick={() => addModuleNode(module)}
                        title={module.description || module.name}
                        className="workflow-editor-palette-item flex cursor-grab items-center gap-2 rounded-lg border border-transparent px-2 py-1.5 text-left text-[12.5px] text-ds-ink transition hover:border-ds-border hover:bg-ds-hover active:cursor-grabbing"
                      >
                        <span className="workflow-editor-palette-icon flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-accent/10 text-accent">
                          <Icon className="h-3.5 w-3.5" strokeWidth={1.9} />
                        </span>
                        <span className="min-w-0 flex-1 truncate">{module.name}</span>
                        <Plus className="h-3.5 w-3.5 shrink-0 text-ds-faint" strokeWidth={1.8} />
                      </button>
                    )
                  })}
                  {presets.map((preset) => {
                    const Icon = NODE_ICONS[preset.nodeType]
                    return (
                      <div key={preset.id} className="group/preset relative flex items-center">
                        <button
                          type="button"
                          draggable
                          onDragStart={(event) => onPresetDragStart(event, preset.id)}
                          onClick={() => addPresetNode(preset)}
                          className="workflow-editor-palette-item flex min-w-0 flex-1 cursor-grab items-center gap-2 rounded-lg border border-transparent px-2 py-1.5 pr-7 text-left text-[12.5px] text-ds-ink transition hover:border-ds-border hover:bg-ds-hover active:cursor-grabbing"
                        >
                          <span className="workflow-editor-palette-icon flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-accent/10 text-accent">
                            <Icon className="h-3.5 w-3.5" strokeWidth={1.9} />
                          </span>
                          <span className="min-w-0 flex-1 truncate">{preset.label}</span>
                        </button>
                        <button
                          type="button"
                          title={t('workflowPresetDelete')}
                          aria-label={t('workflowPresetDelete')}
                          onClick={() => void onDeletePreset(preset.id)}
                          className="absolute right-1 flex h-5 w-5 items-center justify-center rounded text-ds-faint opacity-0 transition hover:bg-red-500/10 hover:text-red-600 group-hover/preset:opacity-100"
                        >
                          <X className="h-3 w-3" strokeWidth={2} />
                        </button>
                      </div>
                    )
                  })}
                  {modules.length === 0 && presets.length === 0 ? (
                    <p className="px-2 py-1 text-[11px] leading-4 text-ds-faint">{t('workflowPresetEmpty')}</p>
                  ) : null}
                </>
              ) : null}
            </div>
          </div>
        </aside>
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col">
        <header
          className={`${WORKFLOW_EDITOR_HEADER_CLASS}${leftPanelCollapsed ? ` ${WORKFLOW_EDITOR_HEADER_SIDEBAR_COLLAPSED_CLASS}` : ''}`}
        >
          {leftPanelCollapsed ? (
            <button type="button" onClick={onBack} className={`${WORKFLOW_EDITOR_BACK_BUTTON_CLASS} shrink-0`}>
              <ArrowLeft className="h-4 w-4" strokeWidth={1.8} />
              {t('workflowBack')}
            </button>
          ) : null}
          <input
            className="workflow-editor-name min-w-0 flex-1 rounded-xl border border-transparent bg-transparent px-2 py-1.5 text-[15px] font-medium text-ds-ink outline-none focus:border-ds-border focus:bg-ds-card"
            value={name}
            placeholder={t('workflowNamePlaceholder')}
            onChange={(event) => {
              setName(event.target.value)
              setDirty(true)
            }}
          />
          <label className="flex shrink-0 items-center gap-2 text-[13px] font-medium text-ds-muted">
            {t('workflowEnabled')}
            <input
              type="checkbox"
              checked={enabled}
              onChange={(event) => {
                setEnabled(event.target.checked)
                setDirty(true)
              }}
            />
          </label>
          <button
            type="button"
            onClick={() => setShowHistory(true)}
            title={t('workflowRunHistory')}
            aria-label={t('workflowRunHistory')}
            className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-ds-border bg-ds-card text-ds-muted transition hover:bg-ds-hover hover:text-ds-ink"
          >
            <History className="h-4 w-4" strokeWidth={1.8} />
          </button>
          <button
            type="button"
            onClick={() => setShowEnv(true)}
            title={t('workflowEnvVars')}
            aria-label={t('workflowEnvVars')}
            className="relative inline-flex h-9 items-center gap-1.5 rounded-xl border border-ds-border bg-ds-card px-3 text-[13px] font-medium text-ds-muted transition hover:bg-ds-hover hover:text-ds-ink"
          >
            <Variable className="h-4 w-4" strokeWidth={1.8} />
            {t('workflowEnvVars')}
            {env.length > 0 ? (
              <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-accent/15 px-1 text-[10px] font-semibold text-accent">
                {env.length}
              </span>
            ) : null}
          </button>
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving}
            className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-ds-border bg-ds-card px-3 text-[13px] font-medium text-ds-ink transition hover:bg-ds-hover disabled:opacity-60"
          >
            <Save className="h-4 w-4" strokeWidth={1.8} />
            {dirty ? t('workflowSave') : t('workflowSaved')}
          </button>
          {running ? (
            <button
              type="button"
              onClick={() => void onStop()}
              className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-red-500/90 px-4 text-[13px] font-semibold text-white shadow-sm transition hover:bg-red-500"
            >
              <Square className="h-3.5 w-3.5" strokeWidth={2} />
              {t('workflowStop')}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void handleRun()}
              className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-ds-userbubble px-4 text-[13px] font-semibold text-ds-userbubbleFg shadow-sm transition hover:opacity-90"
            >
              <Play className="h-4 w-4" strokeWidth={2} />
              {t('workflowRunNow')}
            </button>
          )}
        </header>

        <div className="workflow-editor-body flex min-h-0 flex-1">
          <div
            className="workflow-editor-canvas-shell relative min-w-0 flex-1"
            onDrop={onCanvasDrop}
            onDragOver={onCanvasDragOver}
          >
            <WorkflowRunStatusContext.Provider value={runStatus}>
              <WorkflowNodeActionsContext.Provider value={nodeActions}>
                <ReactFlow
                  className="ds-workflow-canvas"
                  nodes={rfNodes}
                  edges={styledEdges}
                  nodeTypes={workflowNodeTypes}
                  onNodesChange={onNodesChange}
                  onEdgesChange={onEdgesChange}
                  onConnect={onConnect}
                  onConnectStart={onConnectStart}
                  onConnectEnd={onConnectEnd}
                  onNodeClick={(_, node) => setSelectedNodeId(node.id)}
                  onPaneClick={() => setSelectedNodeId(null)}
                  fitView
                  fitViewOptions={{ maxZoom: 1, padding: 0.2 }}
                  minZoom={0.2}
                  proOptions={{ hideAttribution: true }}
                >
                  <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
                  <Controls showInteractive={false} />
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
              </WorkflowNodeActionsContext.Provider>
            </WorkflowRunStatusContext.Provider>
            {rfNodes.length === 0 ? (
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 text-center">
                <MousePointerClick className="h-8 w-8 text-ds-faint" strokeWidth={1.4} />
                <p className="text-[13px] text-ds-faint">{t('workflowEmptyCanvas')}</p>
              </div>
            ) : null}
            {connectMenu ? (
              <>
                <div className="fixed inset-0 z-[70]" onClick={() => setConnectMenu(null)} />
                <div
                  className="fixed z-[71] max-h-[60vh] w-44 overflow-y-auto rounded-lg border border-ds-border bg-ds-card p-1 shadow-lg"
                  style={{ left: connectMenu.x, top: connectMenu.y }}
                >
                  {WORKFLOW_PALETTE_GROUPS.map((group) => {
                    const kinds = group.kinds.filter((kind) => !TRIGGER_KINDS.has(kind))
                    if (kinds.length === 0) return null
                    return (
                      <div key={group.id}>
                        <div className="px-2 pb-0.5 pt-1.5 text-[9.5px] font-semibold uppercase tracking-wide text-ds-faint">
                          {t(`workflowGroup_${group.id}`)}
                        </div>
                        {kinds.map((kind) => {
                          const Icon = NODE_ICONS[kind]
                          return (
                            <button
                              key={kind}
                              type="button"
                              onClick={() => addConnectedNode(kind)}
                              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] text-ds-ink transition hover:bg-ds-hover"
                            >
                              <Icon className="h-3.5 w-3.5 text-accent" strokeWidth={1.9} />
                              {t(`workflowNode_${kind}`)}
                            </button>
                          )
                        })}
                      </div>
                    )
                  })}
                </div>
              </>
            ) : null}

            <button
              type="button"
              onClick={() => setLeftPanelCollapsed((value) => !value)}
              title={leftPanelCollapsed ? t('workflowExpandPanel') : t('workflowCollapsePanel')}
              aria-label={leftPanelCollapsed ? t('workflowExpandPanel') : t('workflowCollapsePanel')}
              className="workflow-editor-panel-toggle workflow-editor-panel-toggle-left absolute left-0 top-1/2 z-10 flex h-12 w-5 -translate-y-1/2 items-center justify-center rounded-r-lg border border-l-0 border-ds-border bg-ds-card text-ds-faint shadow-sm transition hover:text-ds-ink"
            >
              {leftPanelCollapsed ? (
                <ChevronRight className="h-4 w-4" strokeWidth={2} />
              ) : (
                <ChevronLeft className="h-4 w-4" strokeWidth={2} />
              )}
            </button>
            <button
              type="button"
              onClick={() => setRightPanelCollapsed((value) => !value)}
              title={rightPanelCollapsed ? t('workflowExpandPanel') : t('workflowCollapsePanel')}
              aria-label={rightPanelCollapsed ? t('workflowExpandPanel') : t('workflowCollapsePanel')}
              className="workflow-editor-panel-toggle workflow-editor-panel-toggle-right absolute right-0 top-1/2 z-10 flex h-12 w-5 -translate-y-1/2 items-center justify-center rounded-l-lg border border-r-0 border-ds-border bg-ds-card text-ds-faint shadow-sm transition hover:text-ds-ink"
            >
              {rightPanelCollapsed ? (
                <ChevronLeft className="h-4 w-4" strokeWidth={2} />
              ) : (
                <ChevronRight className="h-4 w-4" strokeWidth={2} />
              )}
            </button>
          </div>

          {!rightPanelCollapsed ? (
            <aside className="workflow-editor-inspector ds-sidebar-surface flex w-[320px] shrink-0 flex-col overflow-hidden border-l border-ds-border">
              <div className="workflow-editor-inspector-tabs flex shrink-0 items-center gap-1 border-b border-ds-border px-2 pt-2">
                {(['config', 'log'] as const).map((tab) => (
                  <button
                    key={tab}
                    type="button"
                    onClick={() => setRightTab(tab)}
                    data-active={rightTab === tab ? 'true' : 'false'}
                    className={`workflow-editor-inspector-tab relative flex items-center gap-1.5 px-3 py-2 text-[12.5px] font-medium transition ${
                      rightTab === tab ? 'text-ds-ink' : 'text-ds-faint hover:text-ds-muted'
                    }`}
                  >
                    {tab === 'config' ? t('workflowTabConfig') : t('workflowTabRunLog')}
                    {tab === 'log' && running ? (
                      <span className="h-1.5 w-1.5 rounded-full bg-amber-500 animate-pulse" />
                    ) : null}
                    {rightTab === tab ? (
                      <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-accent" />
                    ) : null}
                  </button>
                ))}
              </div>
              <div className="flex min-h-0 flex-1 flex-col">
                {rightTab === 'config' ? (
                  <NodeConfigPanel
                    node={selectedNode}
                    settings={settings}
                    lastResult={
                      selectedNodeId ? logResults[selectedNodeId] ?? lastResults[selectedNodeId] ?? null : null
                    }
                    onChange={handleNodeChange}
                    onDelete={handleDeleteNode}
                    onSavePreset={handleSavePreset}
                    workflowName={name}
                    upstreamNodes={upstreamNodes}
                    workflowId={workflow.id}
                    onBeforeTest={handleSave}
                  />
                ) : (
                  <WorkflowRunLogPanel nodes={workflow.nodes} results={logResults} running={running} />
                )}
              </div>
            </aside>
          ) : null}
        </div>

        {showModules ? (
          <ModuleManager
            modules={modules}
            onChange={(next) => void onSaveModules(next)}
            onClose={() => setShowModules(false)}
          />
        ) : null}

        {showEnv ? (
          <EnvVarsModal
            env={env}
            onChange={(next) => {
              setEnv(next)
              setDirty(true)
            }}
            onClose={() => setShowEnv(false)}
          />
        ) : null}

        {showHistory ? (
          <WorkflowRunHistory runs={workflow.runs} nodes={workflow.nodes} onClose={() => setShowHistory(false)} />
        ) : null}
      </div>
    </div>
  )
}

const ENV_VAR_TYPES: WorkflowEnvVarV1['type'][] = ['string', 'number', 'boolean', 'secret']

/** Workflow-scoped env vars, referenced from any node via {{$env.key}}. Secrets are redacted from run history. */
function EnvVarsModal({
  env,
  onChange,
  onClose
}: {
  env: WorkflowEnvVarV1[]
  onChange: (next: WorkflowEnvVarV1[]) => void
  onClose: () => void
}): ReactElement {
  const { t } = useTranslation('common')
  const inputClass =
    'w-full rounded-lg border border-ds-border bg-ds-card px-2.5 py-1.5 text-[13px] text-ds-ink outline-none focus:border-accent/40 focus:ring-1 focus:ring-accent/25'
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6" onClick={onClose}>
      <div
        className="flex max-h-[80vh] w-[560px] flex-col overflow-hidden rounded-2xl border border-ds-border bg-ds-card shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex shrink-0 items-center justify-between border-b border-ds-border px-5 py-3.5">
          <div className="flex flex-col">
            <span className="text-[14px] font-semibold text-ds-ink">{t('workflowEnvVars')}</span>
            <span className="text-[11.5px] text-ds-faint">{t('workflowEnvVarsHint')}</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-ds-faint transition hover:bg-ds-hover hover:text-ds-ink"
          >
            <X className="h-4 w-4" strokeWidth={1.8} />
          </button>
        </header>
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-5 py-4">
          {env.length === 0 ? (
            <p className="py-6 text-center text-[12.5px] text-ds-faint">{t('workflowEnvEmpty')}</p>
          ) : (
            env.map((item, index) => {
              const update = (patch: Partial<WorkflowEnvVarV1>): void =>
                onChange(env.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)))
              return (
                <div key={index} className="flex items-center gap-2">
                  <input
                    className={`${inputClass} w-40 shrink-0 font-mono`}
                    value={item.key}
                    placeholder={t('workflowEnvKey')}
                    onChange={(event) => update({ key: event.target.value })}
                  />
                  <select
                    className={`${inputClass} w-24 shrink-0`}
                    value={item.type}
                    onChange={(event) => update({ type: event.target.value as WorkflowEnvVarV1['type'] })}
                  >
                    {ENV_VAR_TYPES.map((type) => (
                      <option key={type} value={type}>
                        {t(`workflowEnvType_${type}`)}
                      </option>
                    ))}
                  </select>
                  <input
                    className={inputClass}
                    type={item.type === 'secret' ? 'password' : 'text'}
                    value={item.value}
                    placeholder={t('workflowEnvValue')}
                    onChange={(event) => update({ value: event.target.value })}
                  />
                  <button
                    type="button"
                    onClick={() => onChange(env.filter((_, i) => i !== index))}
                    className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-ds-faint transition hover:bg-red-500/10 hover:text-red-600"
                    aria-label={t('workflowEnvRemove')}
                  >
                    <X className="h-3.5 w-3.5" strokeWidth={2} />
                  </button>
                </div>
              )
            })
          )}
          <button
            type="button"
            onClick={() => onChange([...env, { key: `KEY_${env.length + 1}`, value: '', type: 'string' }])}
            className="mt-1 inline-flex items-center gap-1.5 self-start rounded-lg px-2.5 py-1.5 text-[12.5px] font-medium text-accent transition hover:bg-accent/10"
          >
            <Plus className="h-3.5 w-3.5" strokeWidth={2} />
            {t('workflowEnvAdd')}
          </button>
        </div>
      </div>
    </div>
  )
}

export function WorkflowEditorView(props: Props): ReactElement {
  return (
    <ReactFlowProvider>
      <WorkflowEditorInner {...props} />
    </ReactFlowProvider>
  )
}

export type WorkflowEditorProps = Props
