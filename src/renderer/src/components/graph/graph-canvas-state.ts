import type { Node } from '@xyflow/react'

export function reconcileInteractiveGraphNodes(
  current: Node[],
  incoming: Node[],
  selectedNodeId: string | null
): Node[] {
  const previous = new Map(current.map((node) => [node.id, node]))
  return incoming.map((node) => {
    const existing = previous.get(node.id)
    return {
      ...node,
      position: existing?.position ?? node.position,
      selected: node.id === selectedNodeId
    }
  })
}
