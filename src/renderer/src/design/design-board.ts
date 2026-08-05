import {
  createEmptyDocument,
  createHtmlFrameShape,
  embeddedArtifactOf,
  isArtifactFrame,
  isHtmlFrame,
  type CanvasDocument,
  type CanvasShape,
  type Rect
} from './canvas/canvas-types'
import {
  BOARD_HTML_FRAME_MIN_HEIGHT,
  BOARD_HTML_FRAME_MIN_WIDTH,
  layoutRectsInViewport,
  placeRectInViewportAvoiding,
  rectsAlmostEqual
} from './canvas/canvas-placement'
import {
  normalizeDesignTarget,
  defaultDevicePresetForDesignTarget,
  defaultFrameSizeForDesignTarget,
  defaultPreviewNodeSizeForDesignTarget,
  type DesignTarget
} from './design-context'
import { useCanvasViewportStore } from './canvas/canvas-viewport-store'
import { serializeCanvasDocument } from './canvas/canvas-persistence'
import { writeDesignWorkspaceFile } from './design-persistence-coordinator'
import { createLinkedHtmlScreen } from './canvas/screen-lifecycle'
import {
  createDesignArtifactId,
  currentDesignArtifactVersion,
  defaultDesignArtifactNode,
  designArtifactVersionLabel,
  inferDesignArtifactFoundationRole,
  type DesignArtifact,
  type DesignArtifactNode,
  type DesignArtifactVersion
} from './design-types'
import { useDesignWorkspaceStore } from './design-workspace-store'

export type SyncHtmlArtifactsToBoardResult = {
  document: CanvasDocument
  addedFrameIds: string[]
  updatedFrameIds: string[]
  removedFrameIds: string[]
}

export type CreateScreenFrameArtifactResult = {
  artifactId: string
  relativePath: string
  designMdPath: string
  shape: CanvasShape
}

export function findDesignBoardArtifact(
  artifacts: readonly DesignArtifact[]
): (DesignArtifact & { kind: 'canvas' }) | null {
  const boards = artifacts.filter((artifact): artifact is DesignArtifact & { kind: 'canvas' } =>
    artifact.kind === 'canvas'
  )
  if (boards.length === 0) return null
  return [...boards].sort(
    (a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.createdAt.localeCompare(a.createdAt)
  )[0] ?? null
}

export function buildHtmlArtifactSyncKey(
  artifacts: readonly DesignArtifact[],
  designTarget: DesignTarget | undefined
): string {
  return [
    normalizeDesignTarget(designTarget),
    ...artifacts
      .filter((artifact) => artifact.kind === 'html')
      .map((artifact) => {
        const node = artifact.node
        return [
          artifact.id,
          artifact.versions.map((version) => `${version.id}@${version.relativePath}`).join(','),
          currentDesignArtifactVersion(artifact)?.id ?? '',
          currentDesignArtifactVersion(artifact)?.relativePath ?? artifact.relativePath,
          artifact.title,
          artifact.previewStatus ?? '',
          inferDesignArtifactFoundationRole(artifact) ?? '',
          node?.x ?? '',
          node?.y ?? '',
          node?.width ?? '',
          node?.height ?? '',
          node?.sizeMode ?? '',
          node?.viewMode ?? '',
          node?.boardHidden ? 'hidden' : ''
        ].join(':')
      })
  ].join('|')
}

function cloneDocument(doc: CanvasDocument): CanvasDocument {
  return {
    ...doc,
    objects: Object.fromEntries(
      Object.entries(doc.objects).map(([id, shape]) => [id, { ...shape, children: [...shape.children] }])
    )
  }
}

function descendantIds(objects: Record<string, CanvasShape>, id: string): string[] {
  const shape = objects[id]
  if (!shape) return []
  return shape.children.flatMap((childId) => [childId, ...descendantIds(objects, childId)])
}

function documentShapeIdsInOrder(doc: CanvasDocument): string[] {
  const visited = new Set<string>()
  const ordered: string[] = []
  const visit = (id: string): void => {
    if (visited.has(id)) return
    const shape = doc.objects[id]
    if (!shape) return
    visited.add(id)
    ordered.push(id)
    for (const childId of shape.children) visit(childId)
  }
  visit(doc.rootId)
  for (const id of Object.keys(doc.objects)) visit(id)
  return ordered
}

function linkedHtmlFrames(
  doc: CanvasDocument,
  artifacts: readonly DesignArtifact[]
): Map<string, CanvasShape> {
  const frames = new Map<string, CanvasShape>()
  const artifactById = new Map(artifacts.map((artifact) => [artifact.id, artifact]))
  for (const id of documentShapeIdsInOrder(doc)) {
    const shape = doc.objects[id]
    const reference = shape ? embeddedArtifactOf(shape) : null
    if (!shape || !isHtmlFrame(shape) || !reference?.id) continue
    const artifact = artifactById.get(reference.id)
    const versionId = effectiveHtmlFrameVersionId(shape, artifact)
    const key = htmlFrameKey(reference.id, versionId)
    if (!frames.has(key)) frames.set(key, shape)
  }
  return frames
}

function currentHtmlVersionId(artifact: DesignArtifact): string {
  return currentDesignArtifactVersion(artifact)?.id ?? `${artifact.id}-current`
}

function htmlArtifactVersions(artifact: DesignArtifact): DesignArtifactVersion[] {
  if (artifact.versions.length === 0) {
    return [{
      id: currentHtmlVersionId(artifact),
      relativePath: artifact.relativePath,
      createdAt: artifact.updatedAt,
      summary: ''
    }]
  }
  // Versions are persisted newest-first; place historical versions first so a
  // newly-created version is laid out after the frames already on the board.
  return [...artifact.versions].reverse()
}

function htmlFrameKey(artifactId: string, versionId: string): string {
  return `${artifactId}:${versionId}`
}

function effectiveHtmlFrameVersionId(
  shape: CanvasShape,
  artifact: DesignArtifact | undefined
): string {
  return embeddedArtifactOf(shape)?.versionId ?? (artifact ? currentHtmlVersionId(artifact) : `${shape.htmlArtifactId ?? shape.id}-current`)
}

function htmlFrameName(artifact: DesignArtifact, version: DesignArtifactVersion, isCurrent: boolean): string {
  if (isCurrent) return artifact.title || 'Screen'
  return `${artifact.title || 'Screen'} · ${designArtifactVersionLabel(version, artifact.versions.length)}`
}

function documentHasHtmlFrameForArtifact(doc: CanvasDocument, artifactId: string): boolean {
  for (const id of documentShapeIdsInOrder(doc)) {
    const shape = doc.objects[id]
    const reference = shape ? embeddedArtifactOf(shape) : null
    if (shape && isHtmlFrame(shape) && reference?.id === artifactId) return true
  }
  return false
}

export function removedLinkedHtmlArtifactIds(
  before: CanvasDocument,
  after: CanvasDocument
): string[] {
  const removed = new Set<string>()
  for (const id of documentShapeIdsInOrder(before)) {
    const shape = before.objects[id]
    if (!shape || !isHtmlFrame(shape) || !shape.htmlArtifactId) continue
    if (!documentHasHtmlFrameForArtifact(after, shape.htmlArtifactId)) {
      removed.add(shape.htmlArtifactId)
    }
  }
  return [...removed]
}

function nodeRect(node: DesignArtifactNode): Rect {
  return { x: node.x, y: node.y, width: node.width, height: node.height }
}

function ensureHtmlFrameMinSize(size: Pick<Rect, 'width' | 'height'>): Pick<Rect, 'width' | 'height'> {
  return {
    width: Math.max(BOARD_HTML_FRAME_MIN_WIDTH, size.width),
    height: Math.max(BOARD_HTML_FRAME_MIN_HEIGHT, size.height)
  }
}

/**
 * Minimum sensible height for a PENDING width-locked screen, derived from the
 * target's aspect ratio. This is a FLOOR, not a hard set: it exists to restore
 * frames stuck at a stale short skeleton measurement, and must never shrink a
 * taller frame the user explicitly drew — their drawn height should hold until
 * real content is measured.
 */
function pendingFrameAspectHeight(
  artifact: DesignArtifact,
  width: number,
  designTarget: DesignTarget | undefined
): number | null {
  if (artifact.previewStatus !== 'pending') return null
  const generic = genericFrameSizeForArtifact(artifact, designTarget)
  if (generic.width <= 0 || generic.height <= 0) return null
  return Math.max(BOARD_HTML_FRAME_MIN_HEIGHT, Math.round(width * (generic.height / generic.width)))
}

function frameRectFromNode(
  node: DesignArtifactNode,
  artifact: DesignArtifact,
  designTarget: DesignTarget | undefined
): Rect {
  const aspectFloor =
    node.sizeMode === 'manual-width-auto-height'
      ? pendingFrameAspectHeight(artifact, node.width, designTarget)
      : null
  const height = aspectFloor === null ? node.height : Math.max(node.height, aspectFloor)
  return { x: node.x, y: node.y, ...ensureHtmlFrameMinSize({ width: node.width, height }) }
}

function artifactNodeIsDefault(node: DesignArtifactNode | undefined, index: number): boolean {
  if (!node) return false
  const matchesDefaultNode = (slotIndex: number): boolean => {
    const base = defaultDesignArtifactNode(slotIndex)
    return [
      base,
      { ...base, ...defaultPreviewNodeSizeForDesignTarget('web') },
      { ...base, ...defaultPreviewNodeSizeForDesignTarget('app') }
    ].some((candidate) => rectsAlmostEqual(nodeRect(node), candidate))
  }
  if (matchesDefaultNode(index)) return true
  // Persisted preview-card defaults can survive artifact reordering. Treat any
  // of the legacy default grid slots as implicit so they don't shrink board
  // screens to the old 420x340 card size.
  for (let i = 0; i < 60; i += 1) {
    if (i !== index && matchesDefaultNode(i)) return true
  }
  return false
}

function shouldUseArtifactNode(node: DesignArtifactNode | undefined, index: number): node is DesignArtifactNode {
  return Boolean(node && node.sizeMode !== 'auto' && !artifactNodeIsDefault(node, index))
}

function isFoundationArtifact(artifact: DesignArtifact): boolean {
  return Boolean(inferDesignArtifactFoundationRole(artifact))
}

function foundationNodeLooksLegacyDefault(node: DesignArtifactNode | undefined): boolean {
  if (!node || node.sizeMode !== 'manual') return false
  const legacySizes = [
    defaultPreviewNodeSizeForDesignTarget('web'),
    defaultPreviewNodeSizeForDesignTarget('app'),
    defaultFrameSizeForDesignTarget('app')
  ]
  return legacySizes.some(
    (size) => Math.abs(node.width - size.width) < 1 && Math.abs(node.height - size.height) < 1
  )
}

function shouldUseArtifactNodeForFrame(artifact: DesignArtifact, index: number): artifact is DesignArtifact & { node: DesignArtifactNode } {
  if (!shouldUseArtifactNode(artifact.node, index)) return false
  // Foundation docs used to be persisted as compact preview cards or app-sized
  // placeholders. Keep upgrading those legacy defaults to full desktop frames,
  // but trust any deliberate custom manual resize from the user.
  return !isFoundationArtifact(artifact) || !foundationNodeLooksLegacyDefault(artifact.node)
}

function autoArtifactNode(artifact: DesignArtifact, index: number): DesignArtifactNode | null {
  return artifact.node?.sizeMode === 'auto' && !artifactNodeIsDefault(artifact.node, index) ? artifact.node : null
}

/** The generic, content-agnostic frame size for an artifact's current target/role. */
function genericFrameSizeForArtifact(
  artifact: DesignArtifact,
  designTarget: DesignTarget | undefined
): Pick<Rect, 'width' | 'height'> {
  return isFoundationArtifact(artifact)
    ? defaultFrameSizeForDesignTarget('web')
    : defaultFrameSizeForDesignTarget(designTarget)
}

/**
 * Only foundation reference docs (design system / logo) are allowed to
 * auto-grow their frame WIDTH from measured content — they legitimately need
 * to widen to show component grids/specimens. Regular screens represent a
 * fixed device viewport (e.g. a 390px-wide phone mockup); their width must
 * stay pinned to the device target regardless of any measured/stored width,
 * matching `htmlFrameAllowsWidthAutoGrow` in HtmlFrameOverlay.tsx (the other
 * half of this width policy — that side stops WRITING a measured width for
 * regular screens, this side stops TRUSTING one that's already stored).
 */
function measuredFrameHeightForArtifact(artifact: DesignArtifact, index: number): number | null {
  if (artifact.previewStatus === 'pending') return null
  const measuredAutoNode = autoArtifactNode(artifact, index)
  if (!measuredAutoNode) return null
  return Math.max(BOARD_HTML_FRAME_MIN_HEIGHT, Math.round(measuredAutoNode.height))
}

function measuredFrameWidthForFoundationArtifact(artifact: DesignArtifact, index: number): number | null {
  const measuredAutoNode = autoArtifactNode(artifact, index)
  if (!measuredAutoNode) return null
  const measuredWidth = Math.round(measuredAutoNode.width)
  // Foundation frames migrated from the old compact 420-wide "card" preset
  // report that legacy width as their auto node before ever being measured
  // for real; treat that as "not yet measured".
  const compact = defaultDesignArtifactNode(index)
  if (Math.abs(measuredWidth - compact.width) < 1) return null
  return Math.max(BOARD_HTML_FRAME_MIN_WIDTH, measuredWidth)
}

function defaultFrameSizeForArtifact(
  artifact: DesignArtifact,
  index: number,
  designTarget: DesignTarget | undefined
): Pick<Rect, 'width' | 'height'> {
  const generic = genericFrameSizeForArtifact(artifact, designTarget)
  const measuredHeight = measuredFrameHeightForArtifact(artifact, index)
  const measuredWidth = isFoundationArtifact(artifact)
    ? measuredFrameWidthForFoundationArtifact(artifact, index)
    : null
  return {
    width: measuredWidth ?? generic.width,
    height: measuredHeight ?? generic.height
  }
}

function defaultDevicePresetForArtifact(
  artifact: DesignArtifact,
  designTarget: DesignTarget | undefined
): 'desktop' | 'mobile' {
  return isFoundationArtifact(artifact) ? 'desktop' : defaultDevicePresetForDesignTarget(designTarget)
}

function frameNodePatch(shape: CanvasShape): DesignArtifactNode | null {
  if (!shape.htmlArtifactId || shape.width < BOARD_HTML_FRAME_MIN_WIDTH || shape.height < BOARD_HTML_FRAME_MIN_HEIGHT) {
    return null
  }
  return {
    x: Math.round(shape.x),
    y: Math.round(shape.y),
    width: Math.round(shape.width),
    height: Math.round(shape.height),
    sizeMode: 'manual',
    boardHidden: false,
    viewMode: 'preview'
  }
}

function frameNodeSizeMode(
  shape: CanvasShape,
  artifact: DesignArtifact,
  index: number,
  designTarget: DesignTarget | undefined
): DesignArtifactNode['sizeMode'] {
  const current = artifact.node
  // A freshly generated screen has no node yet: default to 'auto' so the frame
  // follows the current Web/App target. Horizontal resize promotes it to
  // 'manual-width-auto-height'; vertical/corner resize promotes it to 'manual'.
  if (!current) return 'auto'
  if (current.sizeMode === 'auto') return 'auto'
  if (current.sizeMode === 'manual-width-auto-height') return 'manual-width-auto-height'
  if (
    artifactNodeIsDefault(current, index) &&
    rectsAlmostEqual(
      { x: shape.x, y: shape.y, width: shape.width, height: shape.height },
      { x: shape.x, y: shape.y, ...defaultFrameSizeForDesignTarget(designTarget) }
    )
  ) {
    return 'auto'
  }
  return 'manual'
}

export function syncHtmlArtifactsToBoardDocument(
  doc: CanvasDocument,
  artifacts: readonly DesignArtifact[]
): SyncHtmlArtifactsToBoardResult {
  const htmlArtifacts = artifacts.filter((artifact) => artifact.kind === 'html')
  const addedFrameIds: string[] = []
  const updatedFrameIds: string[] = []
  const removedFrameIds: string[] = []
  let next: CanvasDocument | null = null
  const htmlArtifactsById = new Map(htmlArtifacts.map((artifact) => [artifact.id, artifact]))
  const seenFrameKeys = new Set<string>()

  for (const id of documentShapeIdsInOrder(doc)) {
    const shape = doc.objects[id]
    const reference = shape ? embeddedArtifactOf(shape) : null
    if (!shape || !isHtmlFrame(shape) || !reference?.id) continue
    const artifact = htmlArtifactsById.get(reference.id)
    const versionId = effectiveHtmlFrameVersionId(shape, artifact)
    const duplicateLinkedFrame = seenFrameKeys.has(htmlFrameKey(reference.id, versionId))
    const missingArtifact = !htmlArtifactsById.has(reference.id)
    if (!duplicateLinkedFrame && !missingArtifact) {
      seenFrameKeys.add(htmlFrameKey(reference.id, versionId))
      continue
    }
    if (!next) next = cloneDocument(doc)
    const existing = next.objects[shape.id]
    if (!existing) continue
    const removeIds = [shape.id, ...descendantIds(next.objects, shape.id)]
    for (const id of removeIds) delete next.objects[id]
    if (existing.parentId && next.objects[existing.parentId]) {
      const parent = next.objects[existing.parentId]
      next.objects[existing.parentId] = {
        ...parent,
        children: parent.children.filter((childId) => childId !== shape.id)
      }
    }
    removedFrameIds.push(shape.id)
  }

  const workingDoc = next ?? doc
  const root = workingDoc.objects[workingDoc.rootId]
  if (!root) return { document: workingDoc, addedFrameIds, updatedFrameIds, removedFrameIds }

  const designTarget = useDesignWorkspaceStore.getState().designContext.designTarget
  const framesByVersion = linkedHtmlFrames(workingDoc, htmlArtifacts)
  const frameSpecs = htmlArtifacts.flatMap((artifact, index) => {
    const currentVersionId = currentHtmlVersionId(artifact)
    return htmlArtifactVersions(artifact).map((version) => ({
      artifact,
      version,
      index,
      isCurrent: version.id === currentVersionId
    }))
  })
  const autoPlaceArtifacts = frameSpecs.filter(({ artifact, version, isCurrent, index }) =>
    !artifact.node?.boardHidden &&
    !framesByVersion.has(htmlFrameKey(artifact.id, version.id)) &&
    (isCurrent ? !shouldUseArtifactNodeForFrame(artifact, index) : true)
  )
  const autoRects = layoutRectsInViewport(
    autoPlaceArtifacts.map(({ artifact, index }) =>
      defaultFrameSizeForArtifact(artifact, index, designTarget)
    ),
    useCanvasViewportStore.getState().vbox
  )
  const occupiedAutoRects: Rect[] = Object.values(workingDoc.objects)
    .filter((shape) => shape.visible !== false && isArtifactFrame(shape))
    .map((shape) => ({
      x: shape.x,
      y: shape.y,
      width: shape.width,
      height: shape.height
    }))
  const placedAutoRects: Rect[] = []
  let autoIndex = 0

  frameSpecs.forEach(({ artifact, version, index, isCurrent }) => {
    const existing = framesByVersion.get(htmlFrameKey(artifact.id, version.id))
    const customNode = isCurrent && shouldUseArtifactNodeForFrame(artifact, index) ? artifact.node : null
    const autoNode = isCurrent ? autoArtifactNode(artifact, index) : null
    const defaultFrameSize = defaultFrameSizeForArtifact(artifact, index, designTarget)
    const defaultDevicePreset = defaultDevicePresetForArtifact(artifact, designTarget)
    if (!existing && isCurrent && artifact.node?.boardHidden) return
    if (existing) {
      const rootHasFrame = root.children.includes(existing.id)
      if (existing.parentId !== workingDoc.rootId || !rootHasFrame || existing.frameId !== null) {
        if (!next) next = cloneDocument(workingDoc)
        const current = next.objects[existing.id]
        const currentRoot = next.objects[next.rootId]
        if (current && currentRoot) {
          if (current.parentId && current.parentId !== next.rootId && next.objects[current.parentId]) {
            const oldParent = next.objects[current.parentId]
            next.objects[current.parentId] = {
              ...oldParent,
              children: oldParent.children.filter((childId) => childId !== current.id)
            }
          }
          next.objects[current.id] = { ...current, parentId: next.rootId, frameId: null }
          if (!currentRoot.children.includes(current.id)) {
            next.objects[next.rootId] = { ...currentRoot, children: [...currentRoot.children, current.id] }
          }
          if (!updatedFrameIds.includes(current.id)) updatedFrameIds.push(current.id)
        }
      }
      const patch: Partial<CanvasShape> = {}
      const expectedEmbeddedArtifact = {
        id: artifact.id,
        kind: 'html' as const,
        versionId: version.id
      }
      if (
        existing.embeddedArtifact?.id !== expectedEmbeddedArtifact.id ||
        existing.embeddedArtifact.kind !== expectedEmbeddedArtifact.kind ||
        existing.embeddedArtifact.versionId !== expectedEmbeddedArtifact.versionId
      ) {
        // Stamp legacy/current frames with the exact snapshot they render. This
        // lets the next generated version get its own frame without treating
        // the older frame as an unversioned alias of the latest one.
        patch.embeddedArtifact = expectedEmbeddedArtifact
      }
      if (!isCurrent) {
        // Historical version frames are snapshots. Keep their position, size,
        // and label stable while the artifact's current version evolves.
        if (Object.keys(patch).length > 0) {
          if (!next) next = cloneDocument(workingDoc)
          next.objects[existing.id] = { ...next.objects[existing.id], ...patch }
          if (Object.keys(patch).some((key) => key !== 'embeddedArtifact') && !updatedFrameIds.includes(existing.id)) {
            updatedFrameIds.push(existing.id)
          }
        }
        return
      }
      const nextName = artifact.title || existing.name
      if (existing.name !== nextName) patch.name = nextName
      const minSize = ensureHtmlFrameMinSize(existing)
      if (Math.abs(minSize.width - existing.width) > 0.5) patch.width = minSize.width
      if (Math.abs(minSize.height - existing.height) > 0.5) patch.height = minSize.height
      if (customNode?.sizeMode === 'manual-width-auto-height') {
        // Grow-only floor: rescue frames stuck at a stale short skeleton
        // measurement, but never shrink a taller frame the user drew — the
        // drawn height holds until real content is measured.
        const nextHeight = pendingFrameAspectHeight(artifact, existing.width, designTarget)
        if (nextHeight !== null && existing.height < nextHeight - 0.5) {
          patch.height = nextHeight
        }
      }
      if (!customNode) {
        // A stale device preset means the design target genuinely changed for
        // this frame (e.g. Web -> App) — snap it to the new target's base size
        // even if it still holds an old measurement. Otherwise trust a real
        // content measurement (defaultFrameSize already prefers it) instead of
        // resetting to the generic placeholder size on every unrelated sync.
        const presetChanged = existing.devicePreset !== defaultDevicePreset
        const nextSize = presetChanged
          ? genericFrameSizeForArtifact(artifact, designTarget)
          : defaultFrameSize
        if (!rectsAlmostEqual({ x: existing.x, y: existing.y, width: existing.width, height: existing.height }, {
          x: existing.x,
          y: existing.y,
          ...nextSize
        })) {
          patch.width = nextSize.width
          patch.height = nextSize.height
        }
        if (presetChanged) patch.devicePreset = defaultDevicePreset
      }
      if (Object.keys(patch).length > 0) {
        if (!next) next = cloneDocument(workingDoc)
        next.objects[existing.id] = { ...next.objects[existing.id], ...patch }
        if (Object.keys(patch).some((key) => key !== 'embeddedArtifact') && !updatedFrameIds.includes(existing.id)) {
          updatedFrameIds.push(existing.id)
        }
      }
      return
    }

    if (!next) next = cloneDocument(workingDoc)
    const nextRoot = next.objects[next.rootId]
    if (!nextRoot) return

    const rect = customNode
      ? frameRectFromNode(customNode, artifact, designTarget)
      : autoNode
        ? { x: autoNode.x, y: autoNode.y, ...defaultFrameSize }
      : occupiedAutoRects.length === 0
        ? autoRects[autoIndex++] ?? { x: 0, y: 0, ...defaultFrameSize }
        : placeRectInViewportAvoiding(
            defaultFrameSize,
            useCanvasViewportStore.getState().vbox,
            [...occupiedAutoRects, ...placedAutoRects]
          )
    const frame = createHtmlFrameShape(
      htmlFrameName(artifact, version, isCurrent),
      rect.x,
      rect.y,
      artifact.id,
      defaultDevicePreset,
      version.id
    )
    frame.width = rect.width
    frame.height = rect.height
    frame.name = htmlFrameName(artifact, version, isCurrent)
    frame.parentId = next.rootId
    if (customNode) occupiedAutoRects.push({ x: frame.x, y: frame.y, width: frame.width, height: frame.height })
    else placedAutoRects.push({ x: frame.x, y: frame.y, width: frame.width, height: frame.height })

    next.objects[frame.id] = frame
    next.objects[next.rootId] = {
      ...nextRoot,
      children: [...nextRoot.children, frame.id]
    }
    addedFrameIds.push(frame.id)
  })

  return { document: next ?? workingDoc, addedFrameIds, updatedFrameIds, removedFrameIds }
}

export function syncHtmlFrameNodesToArtifacts(doc: CanvasDocument): void {
  const designStore = useDesignWorkspaceStore.getState()
  const syncedArtifactIds = new Set<string>()
  for (const id of documentShapeIdsInOrder(doc)) {
    const shape = doc.objects[id]
    if (!shape || !isHtmlFrame(shape) || !shape.htmlArtifactId) continue
    const artifactIndex = designStore.artifacts.findIndex((item) => item.id === shape.htmlArtifactId)
    const artifact = artifactIndex >= 0 ? designStore.artifacts[artifactIndex] : undefined
    if (!artifact || artifact.kind !== 'html') continue
    const reference = embeddedArtifactOf(shape)
    const versionId = reference?.versionId
    if (versionId && versionId !== currentHtmlVersionId(artifact)) continue
    if (syncedArtifactIds.has(shape.htmlArtifactId)) continue
    syncedArtifactIds.add(shape.htmlArtifactId)
    const patch = frameNodePatch(shape)
    if (!patch) continue
    const nextNode = {
      ...patch,
      sizeMode: frameNodeSizeMode(shape, artifact, artifactIndex, designStore.designContext.designTarget),
      viewMode: artifact.node?.viewMode ?? patch.viewMode
    }
    const current = artifact.node
    if (
      current &&
      rectsAlmostEqual(nodeRect(current), nodeRect(nextNode)) &&
      (current.viewMode ?? 'preview') === (nextNode.viewMode ?? 'preview') &&
      current.sizeMode === nextNode.sizeMode &&
      current.boardHidden === nextNode.boardHidden
    ) {
      continue
    }
    designStore.updateArtifactNode(artifact.id, nextNode)
  }
}

export async function ensureDesignBoardArtifact(
  workspaceRoot: string
): Promise<(DesignArtifact & { kind: 'canvas' }) | null> {
  const trimmedRoot = workspaceRoot.trim()
  if (!trimmedRoot) return null

  const store = useDesignWorkspaceStore.getState()
  const existing = findDesignBoardArtifact(store.artifacts)
  if (existing) {
    if (store.activeArtifactId !== existing.id) store.setActiveArtifact(existing.id)
    return existing
  }

  const docId = store.ensureActiveDocument()
  const createdAt = new Date().toISOString()
  const artifactId = createDesignArtifactId()
  const relativePath = `.kun-design/${docId}/${artifactId}/canvas.json`
  const artifact: DesignArtifact & { kind: 'canvas' } = {
    id: artifactId,
    kind: 'canvas',
    title: 'Design board',
    relativePath,
    createdAt,
    updatedAt: createdAt,
    versions: [{ id: `${artifactId}-v1`, relativePath, createdAt, summary: '' }]
  }

  const write = await writeDesignWorkspaceFile({
    path: relativePath,
    workspaceRoot: trimmedRoot,
    content: serializeCanvasDocument(createEmptyDocument())
  })
  if (!write.ok) return null

  useDesignWorkspaceStore.getState().upsertArtifact(artifact)
  return artifact
}

export function createScreenFrameArtifact(options: {
  boardArtifactId: string
  brief?: string
  title?: string
  width?: number
  height?: number
  x?: number
  y?: number
}): CreateScreenFrameArtifactResult {
  const created = createLinkedHtmlScreen({
    boardArtifactId: options.boardArtifactId,
    name: options.title,
    brief: options.brief,
    x: options.x,
    y: options.y,
    width: options.width,
    height: options.height
  })
  if (!created) throw new Error('Cannot create screen artifact')
  return created
}
