import { MarkerType, type Edge, type Node } from '@xyflow/react'
import type { GraphRun } from '../../graph/graph-types'
import { StatusPill } from './graph-panel-shared'

export function graphElements(
  run: GraphRun,
  reducedMotion = false
): { nodes: Node[]; edges: Edge[] } {
  const plan = run.plans.at(-1)
  if (!plan) return { nodes: [], edges: [] }
  const phaseIndex = new Map(
    [...plan.phases].sort((a, b) => a.order - b.order).map((phase, index) => [phase.id, index])
  )
  const critical = criticalPathNodeIds(run)
  const rows = new Map<string, number>()
  const nodes: Node[] = plan.nodes.map((node) => {
    const phase = phaseIndex.get(node.phaseId) ?? 0
    const row = rows.get(node.phaseId) ?? 0
    rows.set(node.phaseId, row + 1)
    const projection = run.nodes[node.id]
    const status = projection?.status ?? 'pending'
    const attempt = projection?.attempts.at(-1)
    return {
      id: node.id,
      ariaLabel: `${node.title}: ${status.replaceAll('_', ' ')}`,
      position: { x: phase * 300 + 36, y: row * 148 + 40 },
      data: {
        label: (
          <div className="w-[210px] space-y-2 p-1 text-left">
            <div className="flex items-start justify-between gap-2">
              <span className="line-clamp-2 text-[12px] font-semibold text-ds-ink">{node.title}</span>
              <StatusPill status={status} />
            </div>
            <div className="line-clamp-2 text-[10px] leading-4 text-ds-muted">{node.objective}</div>
            <div className="flex items-center justify-between gap-2 text-[9px] text-ds-faint">
              <span>{node.kind.replaceAll('_', ' ')}</span>
              <span className="truncate">{attempt?.assignment.name ?? 'unassigned'}</span>
            </div>
            {projection?.lastProgress?.percent !== undefined ? (
              <div className="h-1 overflow-hidden rounded-full bg-ds-hover">
                <div
                  className="h-full rounded-full bg-indigo-500"
                  style={{ width: `${projection.lastProgress.percent}%` }}
                />
              </div>
            ) : null}
          </div>
        )
      },
      style: {
        width: 232,
        borderRadius: 14,
        border: status === 'running'
          ? '1px solid rgb(99 102 241 / 0.65)'
          : critical.has(node.id)
            ? '1px solid rgb(245 158 11 / 0.65)'
            : '1px solid var(--ds-border-muted)',
        background: 'var(--ds-card)',
        boxShadow: status === 'running'
          ? '0 0 0 3px rgb(99 102 241 / 0.10)'
          : critical.has(node.id)
            ? '0 0 0 2px rgb(245 158 11 / 0.08)'
            : '0 8px 24px rgb(15 23 42 / 0.06)'
      }
    }
  })
  const loopTargets = new Set(plan.nodes.flatMap((node) =>
    node.loopGate ? [`${node.id}->${node.loopGate.continueTargetNodeId}`] : []))
  const edges: Edge[] = plan.edges.map((edge) => {
    const isLoop = loopTargets.has(`${edge.from}->${edge.to}`)
    const isCritical = critical.has(edge.from) && critical.has(edge.to) && !isLoop
    return {
      id: edge.id,
      source: edge.from,
      target: edge.to,
      label: edge.label ??
        (isLoop ? 'loop' : edge.kind === 'data' ? edge.artifactName : undefined),
      animated: !reducedMotion && run.nodes[edge.from]?.status === 'running',
      style: {
        stroke: isLoop
          ? '#f59e0b'
          : edge.kind === 'message'
            ? '#8b5cf6'
            : edge.kind === 'data'
              ? '#0ea5e9'
              : isCritical
                ? '#f59e0b'
                : '#94a3b8',
        strokeWidth: isCritical || isLoop ? 2 : 1,
        strokeDasharray: edge.kind === 'message' || isLoop ? '5 5' : undefined
      },
      markerEnd: { type: MarkerType.ArrowClosed }
    }
  })
  return { nodes, edges }
}

export function filterGraphElementsByPhases(
  run: GraphRun,
  elements: { nodes: Node[]; edges: Edge[] },
  collapsedPhaseIds: ReadonlySet<string>
): { nodes: Node[]; edges: Edge[] } {
  if (collapsedPhaseIds.size === 0) return elements
  const plan = run.plans.at(-1)
  if (!plan) return { nodes: [], edges: [] }
  const hidden = new Set(plan.nodes
    .filter((node) => collapsedPhaseIds.has(node.phaseId))
    .map((node) => node.id))
  return {
    nodes: elements.nodes.filter((node) => !hidden.has(node.id)),
    edges: elements.edges.filter((edge) =>
      !hidden.has(edge.source) && !hidden.has(edge.target))
  }
}

export function runProgress(run: GraphRun): { completed: number; total: number } {
  const values = Object.values(run.nodes)
  return {
    completed: values.filter((node) =>
      ['accepted', 'skipped', 'superseded'].includes(node.status)).length,
    total: values.length
  }
}

export function criticalPathNodeIds(run: GraphRun): Set<string> {
  const plan = run.plans.at(-1)
  if (!plan) return new Set()
  const phaseOrder = new Map(plan.phases.map((phase) => [phase.id, phase.order]))
  const nodeOrder = new Map(plan.nodes.map((node, index) => [node.id, index]))
  const ordered = [...plan.nodes].sort((a, b) =>
    (phaseOrder.get(a.phaseId) ?? 0) - (phaseOrder.get(b.phaseId) ?? 0) ||
    (nodeOrder.get(a.id) ?? 0) - (nodeOrder.get(b.id) ?? 0))
  const rank = new Map(ordered.map((node, index) => [node.id, index]))
  const incoming = new Map<string, string[]>()
  for (const edge of plan.edges) {
    if (edge.kind === 'message') continue
    if ((rank.get(edge.from) ?? 0) >= (rank.get(edge.to) ?? 0)) continue
    incoming.set(edge.to, [...(incoming.get(edge.to) ?? []), edge.from])
  }
  const distance = new Map<string, number>()
  const previous = new Map<string, string>()
  for (const node of ordered) {
    const best = (incoming.get(node.id) ?? [])
      .map((id) => ({ id, distance: distance.get(id) ?? 1 }))
      .sort((a, b) => b.distance - a.distance)[0]
    distance.set(node.id, (best?.distance ?? 0) + 1)
    if (best) previous.set(node.id, best.id)
  }
  const end = plan.completionNodeIds
    .map((id) => ({ id, distance: distance.get(id) ?? 0 }))
    .sort((a, b) => b.distance - a.distance)[0]?.id
  const result = new Set<string>()
  let cursor: string | undefined = end
  while (cursor) {
    result.add(cursor)
    cursor = previous.get(cursor)
  }
  return result
}
