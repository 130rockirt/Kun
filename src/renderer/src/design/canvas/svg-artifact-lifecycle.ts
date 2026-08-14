import { useDesignWorkspaceStore } from '../design-workspace-store'
import {
  createSvgFrameShape,
  isArtifactFrame,
  shapeBounds,
  type CanvasShape,
  type Rect
} from './canvas-types'
import { placeRectInViewportAvoiding } from './canvas-placement'
import { currentCanvasOccupiedRects } from './canvas-occupied-regions'
import { useCanvasSelectionStore } from './canvas-selection-store'
import { useCanvasShapeStore } from './canvas-shape-store'
import { useCanvasViewportStore } from './canvas-viewport-store'
export { buildSvgArtifactSkeleton } from '../svg/svg-skeleton'

export type CreateLinkedSvgArtifactOptions = Partial<Rect> & {
  boardArtifactId: string
  /** Stable id emitted by design_svg_create so replaying the same tool call is idempotent. */
  artifactId?: string
  name?: string
  brief?: string
  targetFrameId?: string
  select?: boolean
}

export type CreateLinkedSvgArtifactResult = {
  artifactId: string
  relativePath: string
  designMdPath: string
  shape: CanvasShape
  newlyCreated: boolean
  versionCreated: boolean
}

const linkedCreationQueues = new Map<string, Promise<CreateLinkedSvgArtifactResult | null>>()

function uniqueSvgTitle(name?: string, brief?: string): string {
  const source = name?.trim() || brief?.trim() || 'SVG motion'
  const base = source.length > 48 ? `${source.slice(0, 48)}...` : source
  const used = new Set(useDesignWorkspaceStore.getState().artifacts.map((item) => item.title))
  if (!used.has(base)) return base
  for (let index = 2; index < 10_000; index += 1) {
    const candidate = `${base} ${index}`
    if (!used.has(candidate)) return candidate
  }
  return `${base} ${Date.now()}`
}

function reusableTargetFrame(shape: CanvasShape | undefined): shape is CanvasShape {
  const rootId = useCanvasShapeStore.getState().document.rootId
  return Boolean(
    shape &&
      shape.type === 'frame' &&
      shape.parentId === rootId &&
      !isArtifactFrame(shape) &&
      shape.visible !== false &&
      !shape.locked &&
      shape.children.length === 0
  )
}

function geometry(options: CreateLinkedSvgArtifactOptions): Rect {
  const width = Math.min(4096, Math.max(64, options.width ?? 640))
  const height = Math.min(4096, Math.max(64, options.height ?? 480))
  const placed = placeRectInViewportAvoiding(
    { width, height },
    useCanvasViewportStore.getState().vbox,
    currentCanvasOccupiedRects()
  )
  return { x: options.x ?? placed.x, y: options.y ?? placed.y, width, height }
}

async function createLinkedSvgArtifactImpl(
  options: CreateLinkedSvgArtifactOptions
): Promise<CreateLinkedSvgArtifactResult | null> {
  const store = useDesignWorkspaceStore.getState()
  const context = {
    workspaceRoot: store.workspaceRoot,
    documentId: store.activeDocumentId,
    canvasDocumentKey: useCanvasShapeStore.getState().documentKey
  }
  if (
    !context.documentId ||
    !store.artifacts.some((artifact) => artifact.id === options.boardArtifactId && artifact.kind === 'canvas')
  ) {
    throw new Error('SVG creation was cancelled because the active design board is unavailable.')
  }
  const existingArtifact = options.artifactId
    ? store.artifacts.find((item) => item.id === options.artifactId && item.kind === 'svg')
    : undefined
  const title = existingArtifact?.title ?? uniqueSvgTitle(options.name, options.brief)
  const target = options.targetFrameId
    ? useCanvasShapeStore.getState().document.objects[options.targetFrameId]
    : undefined
  const reusable = reusableTargetFrame(target) ? target : null
  const existingFrame = existingArtifact
    ? Object.values(useCanvasShapeStore.getState().document.objects).find((shape) =>
        isArtifactFrame(shape) && shape.embeddedArtifact?.kind === 'svg' && shape.embeddedArtifact.id === existingArtifact.id
      )
    : undefined
  const rect = existingFrame
    ? shapeBounds(existingFrame)
    : reusable
      ? shapeBounds(reusable)
      : existingArtifact?.node
        ? {
            x: existingArtifact.node.x,
            y: existingArtifact.node.y,
            width: existingArtifact.node.width,
            height: existingArtifact.node.height
          }
        : geometry(options)
  const prepared = await store.prepareSvgTurn(options.brief ?? title, {
    forceNew: true,
    artifactId: options.artifactId,
    width: rect.width,
    height: rect.height,
    title
  })
  const currentStore = useDesignWorkspaceStore.getState()
  const currentCanvas = useCanvasShapeStore.getState()
  if (
    currentStore.workspaceRoot !== context.workspaceRoot ||
    currentStore.activeDocumentId !== context.documentId ||
    currentCanvas.documentKey !== context.canvasDocumentKey ||
    !currentStore.artifacts.some(
      (artifact) => artifact.id === options.boardArtifactId && artifact.kind === 'canvas'
    )
  ) {
    throw new Error('SVG creation was cancelled because the active workspace or design board changed.')
  }
  if (prepared.newlyCreated || !existingArtifact?.node) {
    store.updateArtifactNode(prepared.artifactId, {
      ...rect,
      sizeMode: 'manual',
      viewMode: 'preview'
    })
  }
  store.setActiveArtifact(options.boardArtifactId)

  let shape: CanvasShape
  if (existingFrame) {
    shape = existingFrame
  } else if (reusable) {
    useCanvasShapeStore.getState().updateShape(reusable.id, {
      name: title,
      embeddedArtifact: { id: prepared.artifactId, kind: 'svg' },
      clipContent: true,
      ...rect
    })
    shape = useCanvasShapeStore.getState().document.objects[reusable.id] ?? reusable
  } else {
    shape = createSvgFrameShape(title, rect.x, rect.y, prepared.artifactId, rect.width, rect.height)
    useCanvasShapeStore.getState().addShape(shape)
  }
  if (options.select !== false) {
    useCanvasSelectionStore.getState().select([shape.id])
    useCanvasViewportStore.getState().setActiveTool('select')
  }
  const created = useCanvasShapeStore.getState().document.objects[shape.id] ?? shape
  return { ...prepared, shape: created }
}

export function createLinkedSvgArtifact(
  options: CreateLinkedSvgArtifactOptions
): Promise<CreateLinkedSvgArtifactResult | null> {
  const stableId = options.artifactId?.trim()
  if (!stableId) return createLinkedSvgArtifactImpl(options)
  const workspaceRoot = useDesignWorkspaceStore.getState().workspaceRoot
  const key = [workspaceRoot, options.boardArtifactId, stableId].join('\0')
  const pending = linkedCreationQueues.get(key)
  if (pending) {
    return pending.then((result) => result ? { ...result, newlyCreated: false, versionCreated: false } : null)
  }
  const task = createLinkedSvgArtifactImpl(options)
  linkedCreationQueues.set(key, task)
  void task.finally(() => {
    if (linkedCreationQueues.get(key) === task) linkedCreationQueues.delete(key)
  }).catch(() => undefined)
  return task
}
