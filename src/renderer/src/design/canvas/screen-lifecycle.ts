import { artifactDesignMdPath, artifactDirPath } from '../design-artifact-persistence'
import { defaultDevicePresetForDesignTarget, defaultFrameSizeForDesignTarget } from '../design-context'
import { prepareDesignPreviewFile } from '../design-preview-file'
import { createDesignArtifactId } from '../design-types'
import { useDesignWorkspaceStore } from '../design-workspace-store'
import {
  createHtmlFrameShape,
  isArtifactFrame,
  shapeBounds,
  type CanvasShape,
  type DevicePreset,
  type Rect
} from './canvas-types'
import { useCanvasSelectionStore } from './canvas-selection-store'
import { useCanvasShapeStore } from './canvas-shape-store'
import { placeRectInViewportAvoiding } from './canvas-placement'
import { currentCanvasOccupiedRects } from './canvas-occupied-regions'
import { useCanvasViewportStore } from './canvas-viewport-store'

export type CreateLinkedHtmlScreenOptions = Partial<Rect> & {
  boardArtifactId: string
  name?: string
  brief?: string
  devicePreset?: DevicePreset
  targetFrameId?: string
  preparePreview?: boolean
  select?: boolean
  /**
   * How the provided width/height should be persisted on the artifact node:
   * - 'manual-width-auto-height': lock the width as an explicit user sizing
   *   (board sync keeps it instead of snapping back to the design target's
   *   default device size) while the height keeps following rendered content.
   * - 'manual': lock both width and height.
   * Defaults to 'auto'.
   */
  sizeMode?: 'auto' | 'manual' | 'manual-width-auto-height'
}

export type CreateLinkedHtmlScreenResult = {
  artifactId: string
  relativePath: string
  designMdPath: string
  shape: CanvasShape
}

function screenTitle(name: string | undefined, brief: string | undefined): string {
  const source = name?.trim() || brief?.trim() || 'Screen'
  return source.length > 48 ? `${source.slice(0, 48)}...` : source
}

function uniqueRootScreenTitle(title: string): string {
  const { document } = useCanvasShapeStore.getState()
  const root = document.objects[document.rootId]
  const existing = new Set<string>()
  if (root) {
    for (const id of root.children) {
      const name = document.objects[id]?.name
      if (name) existing.add(name)
    }
  }
  for (const artifact of useDesignWorkspaceStore.getState().artifacts) {
    if (artifact.kind === 'html' && artifact.title) existing.add(artifact.title)
  }
  if (!existing.has(title)) return title

  const match = title.match(/^(.*?)(?:\s+(\d+))?$/)
  const rawBase = match?.[1]?.trim() || title
  for (let index = 2; index < 10_000; index += 1) {
    const suffix = ` ${index}`
    const base = rawBase.length + suffix.length > 51
      ? rawBase.slice(0, Math.max(1, 51 - suffix.length))
      : rawBase
    const candidate = `${base}${suffix}`
    if (!existing.has(candidate)) return candidate
  }
  return `${title} ${Date.now()}`
}

export function isReusableScreenTargetFrame(shape: CanvasShape | undefined): shape is CanvasShape {
  return Boolean(
    shape &&
      shape.type === 'frame' &&
      !isArtifactFrame(shape) &&
      shape.visible !== false &&
      !shape.locked &&
      shape.children.length === 0
  )
}

export function selectedReusableScreenTargetFrameId(): string | null {
  const selectedIds = useCanvasSelectionStore.getState().selectedIds
  if (selectedIds.size !== 1) return null
  const [id] = [...selectedIds]
  const shape = useCanvasShapeStore.getState().document.objects[id]
  return isReusableScreenTargetFrame(shape) ? id : null
}

export function resolveLinkedHtmlScreenGeometry(
  options: Pick<CreateLinkedHtmlScreenOptions, 'x' | 'y' | 'width' | 'height' | 'devicePreset'>
): Rect & { devicePreset: DevicePreset } {
  const designTarget = useDesignWorkspaceStore.getState().designContext.designTarget
  const devicePreset = options.devicePreset ?? defaultDevicePresetForDesignTarget(designTarget)
  const presetFrame = options.devicePreset
    ? createHtmlFrameShape('Screen', 0, 0, '__screen_size__', devicePreset)
    : null
  const defaultFrameSize = presetFrame ?? defaultFrameSizeForDesignTarget(designTarget)
  const width = Math.max(240, options.width ?? defaultFrameSize.width)
  const height = Math.max(180, options.height ?? defaultFrameSize.height)
  const autoRect = placeRectInViewportAvoiding(
    { width, height },
    useCanvasViewportStore.getState().vbox,
    currentCanvasOccupiedRects()
  )
  return {
    x: options.x ?? autoRect.x,
    y: options.y ?? autoRect.y,
    width,
    height,
    devicePreset
  }
}

export function createLinkedHtmlScreen(
  options: CreateLinkedHtmlScreenOptions
): CreateLinkedHtmlScreenResult | null {
  const state = useDesignWorkspaceStore.getState()
  const workspaceRoot = state.workspaceRoot
  const docId = state.ensureActiveDocument()
  const createdAt = new Date().toISOString()
  const artifactId = createDesignArtifactId()
  const relativePath = `${artifactDirPath(docId, artifactId)}/v1.html`
  const designMdPath = artifactDesignMdPath(docId, artifactId)
  const title = uniqueRootScreenTitle(screenTitle(options.name, options.brief))
  const targetFrame = options.targetFrameId
    ? useCanvasShapeStore.getState().document.objects[options.targetFrameId]
    : undefined
  const reusableTargetFrame = isReusableScreenTargetFrame(targetFrame) ? targetFrame : null
  const targetDevicePreset = reusableTargetFrame?.devicePreset ?? options.devicePreset
  const geometry = reusableTargetFrame
    ? {
        x: reusableTargetFrame.x,
        y: reusableTargetFrame.y,
        width: reusableTargetFrame.width,
        height: reusableTargetFrame.height,
        devicePreset: targetDevicePreset ?? defaultDevicePresetForDesignTarget(state.designContext.designTarget)
      }
    : resolveLinkedHtmlScreenGeometry(options)

  state.upsertArtifact({
    id: artifactId,
    kind: 'html',
    title,
    relativePath,
    createdAt,
    updatedAt: createdAt,
    versions: [{ id: `${artifactId}-v1`, relativePath, createdAt, summary: options.brief?.trim() ?? '' }],
    designMdPath,
    previewStatus: 'pending',
    node: {
      x: Math.round(geometry.x),
      y: Math.round(geometry.y),
      width: Math.round(geometry.width),
      height: Math.round(geometry.height),
      sizeMode: reusableTargetFrame ? 'manual' : options.sizeMode ?? 'auto',
      viewMode: 'preview'
    }
  })
  useDesignWorkspaceStore.getState().setActiveArtifact(options.boardArtifactId)

  let shape: CanvasShape
  if (reusableTargetFrame) {
    useCanvasShapeStore.getState().updateShape(reusableTargetFrame.id, {
      name: title,
      htmlArtifactId: artifactId,
      embeddedArtifact: { id: artifactId, kind: 'html' },
      devicePreset: geometry.devicePreset,
      x: geometry.x,
      y: geometry.y,
      width: geometry.width,
      height: geometry.height
    })
    shape = useCanvasShapeStore.getState().document.objects[reusableTargetFrame.id] ?? reusableTargetFrame
  } else {
    shape = createHtmlFrameShape(title, geometry.x, geometry.y, artifactId, geometry.devicePreset)
    shape.width = geometry.width
    shape.height = geometry.height
    useCanvasShapeStore.getState().addShape(shape)
  }
  if (options.select !== false) {
    useCanvasSelectionStore.getState().select([shape.id])
    useCanvasViewportStore.getState().setActiveTool('select')
  }
  if (options.preparePreview !== false) {
    void prepareDesignPreviewFile(workspaceRoot, relativePath)
  }

  const createdShape = useCanvasShapeStore.getState().document.objects[shape.id] ?? shape
  return { artifactId, relativePath, designMdPath, shape: createdShape }
}
