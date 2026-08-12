import { defaultFrameSizeForDesignTarget, type DesignContext } from '../design-context'
import { buildCodeCanvasTurnPrompt } from '../design-turn-prompt'
import { takeLastCanvasOpErrors } from './apply-shape-ops'
import type { CanvasSnapshot } from './canvas-snapshot'
import type { CanvasDocument, ViewBox } from './canvas-types'
import { loadDesignSystem } from './design-system-persistence'
import { createEmptyDesignSystem, type DesignSystem } from './design-system-types'
import type { OpError } from './shape-ops'
import {
  resolveWorkCanvasIdentity,
  snapshotWorkCanvasForPrompt
} from './work-canvas'

export type WorkCanvasOutboundDeps = {
  snapshotForPrompt?: typeof snapshotWorkCanvasForPrompt
  loadDesignSystemForPrompt?: (workspaceRoot: string, baseDir: string) => Promise<DesignSystem>
  takeLastErrors?: (key: string) => OpError[]
}

export type BuildWorkCanvasOutboundTextOptions = WorkCanvasOutboundDeps & {
  baseText: string
  canvasBrief: string
  workspaceRoot: string
  boardId: string
  currentDocument: CanvasDocument
  currentDocumentKey?: string | null
  selectedIds: ReadonlySet<string>
  viewBox: ViewBox
  designContext: DesignContext
}

async function readSnapshot(
  options: BuildWorkCanvasOutboundTextOptions
): Promise<CanvasSnapshot | undefined> {
  const snapshotForPrompt = options.snapshotForPrompt ?? snapshotWorkCanvasForPrompt
  return snapshotForPrompt({
    workspaceRoot: options.workspaceRoot,
    boardId: options.boardId,
    currentDocument: options.currentDocument,
    currentDocumentKey: options.currentDocumentKey,
    selectedIds: options.selectedIds,
    viewBox: options.viewBox,
    defaultScreenSize: defaultFrameSizeForDesignTarget(options.designContext.designTarget)
  })
}

async function readDesignSystem(
  options: BuildWorkCanvasOutboundTextOptions,
  baseDir: string
): Promise<DesignSystem> {
  if (options.loadDesignSystemForPrompt) {
    return options.loadDesignSystemForPrompt(options.workspaceRoot, baseDir)
  }
  return (await loadDesignSystem(options.workspaceRoot, baseDir)) ?? createEmptyDesignSystem()
}

/** Adds the active Work board's complete ShapeOps context to a composer turn. */
export async function buildWorkCanvasOutboundText(
  options: BuildWorkCanvasOutboundTextOptions
): Promise<string> {
  const identity = resolveWorkCanvasIdentity(options.workspaceRoot, options.boardId)
  const [snapshot, designSystem] = await Promise.all([
    readSnapshot(options),
    readDesignSystem(options, identity.designSystemBaseDir)
  ])
  const previousOpErrors = (options.takeLastErrors ?? takeLastCanvasOpErrors)(identity.errorKey)
  const canvasPrompt = buildCodeCanvasTurnPrompt({
    workspaceRoot: options.workspaceRoot,
    text: options.canvasBrief,
    designContext: options.designContext,
    canvasFeedbackKey: identity.errorKey,
    canvasDesignSystem: designSystem,
    ...(previousOpErrors.length > 0 ? { previousOpErrors } : {}),
    ...(snapshot ? { canvasSnapshot: snapshot } : {})
  })
  const workOverride = [
    'Work central whiteboard override:',
    `- The durable board id is \`${identity.boardId}\`; keep all ShapeOps scoped to this open Work editor resource.`,
    '- This board can hold general editable diagrams, notes, image placeholders, PPT direction cards, and slide-review cards.',
    '- Use the current selection when the user says “this”, “selected direction”, or “selected slides”; never infer selection from another canvas.',
    '- PPT review actions must preserve workflow, child, slide/direction, and revision identities already present on shapes.'
  ].join('\n')
  return `${options.baseText}\n\n${canvasPrompt}\n\n${workOverride}`
}
