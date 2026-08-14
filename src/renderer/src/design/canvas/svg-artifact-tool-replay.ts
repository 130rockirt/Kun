import type { ChatBlock, ToolBlock } from '../../agent/types'
import type { DesignArtifact } from '../design-types'
import {
  extractSvgArtifactCreateSpecsFromValue,
  isDesignCanvasToolName,
  type SvgArtifactCreateSpec
} from './apply-shape-ops'

export type SvgArtifactApplyResult = { artifactId: string; shapeId: string } | null
export type SvgArtifactRequestHandler = (
  request: SvgArtifactCreateSpec,
  userPrompt: string
) => SvgArtifactApplyResult | Promise<SvgArtifactApplyResult>

const sharedSvgApplyTasks = new Map<string, Promise<ApplySvgArtifactToolBlockResult>>()

function userText(block: ChatBlock): string {
  if (block.kind !== 'user') return ''
  const displayText = block.meta?.displayText
  return typeof displayText === 'string' && displayText.trim() ? displayText : block.text
}

function blockIndexById(blocks: readonly ChatBlock[], blockId: string): number {
  return blocks.findIndex((block) => block.id === blockId)
}

export function userTextBeforeToolBlock(blocks: readonly ChatBlock[], blockId: string): string {
  const toolIndex = blockIndexById(blocks, blockId)
  if (toolIndex < 0) return ''
  for (let index = toolIndex - 1; index >= 0; index -= 1) {
    const block = blocks[index]
    if (block.kind === 'user') return userText(block)
  }
  return ''
}

export function hasDispatchedSvgFollowup(
  blocks: readonly ChatBlock[],
  toolBlockId: string,
  artifactRelativePath: string
): boolean {
  const toolIndex = blockIndexById(blocks, toolBlockId)
  if (toolIndex < 0 || !artifactRelativePath) return false
  return blocks.slice(toolIndex + 1).some((block) =>
    block.kind === 'user' && block.text.includes(`Reserved SVG file: ${artifactRelativePath}`)
  )
}

export function shouldApplyDurableSvgCreate(options: {
  artifactId?: string
  toolBlockId: string
  artifacts: readonly DesignArtifact[]
  blocks: readonly ChatBlock[]
}): boolean {
  if (!options.artifactId) return false
  const existing = options.artifacts.find((artifact) =>
    artifact.kind === 'svg' && artifact.id === options.artifactId
  )
  if (!existing) return true
  if (existing.previewStatus !== 'pending') return false
  return !hasDispatchedSvgFollowup(options.blocks, options.toolBlockId, existing.relativePath)
}

export function shouldApplyDesignCanvasToolBlock(block: ToolBlock): boolean {
  if (!isDesignCanvasToolName(block.meta?.toolName) || block.status !== 'success') return false
  const sourceItemKind = block.meta?.sourceItemKind
  return sourceItemKind === undefined || sourceItemKind === 'tool_result'
}

export type ApplySvgArtifactToolBlockOptions = {
  block: ToolBlock
  allowLegacy: boolean
  busy: boolean
  blocks: readonly ChatBlock[]
  artifacts: readonly DesignArtifact[]
  appliedBlockIds: Set<string>
  processingBlockIds: Set<string>
  onDefer: (block: ToolBlock) => void
  onRequest: SvgArtifactRequestHandler
}

export type ApplySvgArtifactToolBlockResult =
  | { status: 'ignored' | 'processing' | 'deferred' | 'failed'; shapeIds: [] }
  | { status: 'applied'; shapeIds: string[] }

export async function applySvgArtifactToolBlock(
  options: ApplySvgArtifactToolBlockOptions
): Promise<ApplySvgArtifactToolBlockResult> {
  const { block } = options
  if (options.appliedBlockIds.has(block.id)) {
    return { status: 'ignored', shapeIds: [] }
  }
  if (options.processingBlockIds.has(block.id)) return { status: 'processing', shapeIds: [] }
  if (!shouldApplyDesignCanvasToolBlock(block) || block.meta?.toolName !== 'design_svg_create') {
    return { status: 'ignored', shapeIds: [] }
  }
  const detail = block.detail?.trim()
  if (!detail) return { status: 'ignored', shapeIds: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(detail)
  } catch {
    return { status: 'ignored', shapeIds: [] }
  }
  const specs = extractSvgArtifactCreateSpecsFromValue(parsed)
  if (specs.length === 0 || (!options.allowLegacy && specs.some((spec) => !spec.artifactId))) {
    return { status: 'ignored', shapeIds: [] }
  }
  if (options.busy) {
    options.onDefer(block)
    return { status: 'deferred', shapeIds: [] }
  }
  const actionable = specs.filter((spec) => spec.artifactId
    ? shouldApplyDurableSvgCreate({
        artifactId: spec.artifactId,
        toolBlockId: block.id,
        artifacts: options.artifacts,
        blocks: options.blocks
      })
    : options.allowLegacy
  )
  if (actionable.length === 0) {
    options.appliedBlockIds.add(block.id)
    return { status: 'applied', shapeIds: [] }
  }

  const sharedKey = [
    block.id,
    ...actionable.map((spec) => spec.artifactId ?? `legacy:${spec.name}:${spec.brief}`)
  ].join('\0')
  const sharedTask = sharedSvgApplyTasks.get(sharedKey)
  if (sharedTask) {
    const result = await sharedTask
    if (result.status === 'applied') options.appliedBlockIds.add(block.id)
    return result
  }

  options.processingBlockIds.add(block.id)
  const task = (async (): Promise<ApplySvgArtifactToolBlockResult> => {
    const prompt = userTextBeforeToolBlock(options.blocks, block.id)
    const shapeIds: string[] = []
    for (const spec of actionable) {
      let created: SvgArtifactApplyResult
      try {
        created = await options.onRequest(spec, prompt)
      } catch {
        created = null
      }
      if (!created) return { status: 'failed', shapeIds: [] }
      shapeIds.push(created.shapeId)
    }
    return { status: 'applied', shapeIds }
  })()
  sharedSvgApplyTasks.set(sharedKey, task)
  try {
    const result = await task
    if (result.status === 'applied') options.appliedBlockIds.add(block.id)
    return result
  } finally {
    if (sharedSvgApplyTasks.get(sharedKey) === task) sharedSvgApplyTasks.delete(sharedKey)
    options.processingBlockIds.delete(block.id)
  }
}
