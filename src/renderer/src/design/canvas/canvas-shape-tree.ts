import type { CanvasDocument, CanvasShape } from './canvas-types'
import { isArtifactFrame } from './canvas-types'

export function collectDescendants(
  objects: Record<string, CanvasShape>,
  id: string
): string[] {
  const shape = objects[id]
  if (!shape) return []
  const result: string[] = []
  const visited = new Set<string>([id])
  const stack = [...shape.children].reverse()
  while (stack.length > 0) {
    const childId = stack.pop()!
    if (visited.has(childId)) continue
    visited.add(childId)
    result.push(childId)
    const child = objects[childId]
    if (child) stack.push(...[...child.children].reverse())
  }
  return result
}

/**
 * Expand a set of shape ids to include all their descendants (deduped).
 * Children use absolute coordinates, so moving a container must move the whole
 * subtree rather than relying on nested SVG transforms.
 */
export function withDescendants(
  objects: Record<string, CanvasShape>,
  ids: Iterable<string>
): string[] {
  const out = new Set<string>()
  for (const id of ids) {
    out.add(id)
    for (const descendant of collectDescendants(objects, id)) out.add(descendant)
  }
  return [...out]
}

export function canAcceptCanvasChildren(
  document: CanvasDocument,
  shape: CanvasShape
): boolean {
  if (shape.id === document.rootId) return true
  return (shape.type === 'frame' || shape.type === 'group') && !isArtifactFrame(shape)
}

/**
 * Follow parent links instead of recursively walking children so a pre-existing
 * malformed graph cannot overflow the stack while a structural edit is being
 * validated. A valid destination must lead back to this document's root and
 * must not pass through the shape being moved.
 */
export function hasValidReparentAncestry(
  document: CanvasDocument,
  shapeId: string,
  newParentId: string
): boolean {
  const visited = new Set<string>()
  let currentId: string | null = newParentId
  while (currentId) {
    if (currentId === shapeId || visited.has(currentId)) return false
    visited.add(currentId)
    const current: CanvasShape | undefined = document.objects[currentId]
    if (!current) return false
    if (currentId === document.rootId) return current.parentId === null
    currentId = current.parentId
  }
  return false
}

export function owningFrameIdForParent(
  document: CanvasDocument,
  parent: CanvasShape
): string | null {
  if (parent.id === document.rootId) return null
  return parent.type === 'frame' ? parent.id : parent.frameId
}

/**
 * Reorder a child without breaking the root's SVG/DOM portal layer boundary.
 * Artifact frames render in a separate DOM layer, so they must stay after all
 * ordinary SVG shapes even when an AI reparent operation supplies a raw index.
 */
export function reorderCanvasChildren(
  document: CanvasDocument,
  parentId: string,
  childId: string,
  newIndex: number
): string[] {
  const parent = document.objects[parentId]
  const shape = document.objects[childId]
  if (!parent || !shape) return parent?.children ?? []
  const filtered = parent.children.filter((id) => id !== childId)
  if (parentId !== document.rootId) {
    filtered.splice(Math.max(0, Math.min(filtered.length, newIndex)), 0, childId)
    return filtered
  }

  const normal = filtered.filter((id) => !isArtifactFrame(document.objects[id]))
  const portals = filtered.filter((id) => isArtifactFrame(document.objects[id]))
  if (isArtifactFrame(shape)) {
    const portalIndex = Math.max(0, Math.min(portals.length, newIndex - normal.length))
    portals.splice(portalIndex, 0, childId)
  } else {
    normal.splice(Math.max(0, Math.min(normal.length, newIndex)), 0, childId)
  }
  return [...normal, ...portals]
}
