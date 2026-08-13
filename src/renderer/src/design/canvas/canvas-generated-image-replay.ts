import type { ChatBlock, GeneratedFileReference } from '../../agent/types'
import type { DesignImagePlacementTarget } from '../../agent/design-task-profile'
import { isImplicitImageSlot, type CanvasDocument } from './canvas-types'

export type GeneratedImageFallbackTarget = { id: string; imageUrl: string }
export type GeneratedImageResult = { imageUrl: string; completionIdentity: string }

const EXISTING_IMAGE_EDIT_PATTERN =
  /(?:按图片批注修改|修改|编辑|改成|改为|改一下|换成?|替换|重画|重绘|修复|调整|变成|去掉|去除|清除|换个颜色|change|edit|modify|replace|transform|restyle|redo|fix|recolor|remove|clean up)/i

export function looksLikeExistingCanvasImageEditRequest(text: string): boolean {
  return EXISTING_IMAGE_EDIT_PATTERN.test(text)
}

export function resolveGeneratedImageFallbackTarget(options: {
  document: CanvasDocument
  selectedIds: ReadonlySet<string>
  userText: string
}): GeneratedImageFallbackTarget | null {
  if (!looksLikeExistingCanvasImageEditRequest(options.userText) || options.selectedIds.size !== 1) {
    return null
  }
  const [id] = [...options.selectedIds]
  if (!id) return null
  const shape = options.document.objects[id]
  if (shape?.type !== 'image' || !shape.imageUrl) return null
  return { id, imageUrl: shape.imageUrl }
}

export function resolveGeneratedImagePlacementTarget(options: {
  document: CanvasDocument
  selectedIds: ReadonlySet<string>
  userText: string
}): DesignImagePlacementTarget | null {
  const editedImage = resolveGeneratedImageFallbackTarget(options)
  if (editedImage) {
    return { shapeId: editedImage.id, expectedImageUrl: editedImage.imageUrl }
  }
  if (options.selectedIds.size !== 1) return null
  const [shapeId] = [...options.selectedIds]
  const shape = shapeId ? options.document.objects[shapeId] : undefined
  if (!shape) return null
  if (shape.aiImageHolder) {
    return shape.imageUrl
      ? { shapeId, expectedImageUrl: shape.imageUrl }
      : { shapeId, expectedHolderKind: 'explicit' }
  }
  if (!isImplicitImageSlot(shape)) return null
  const expectedHolderKind = shape.type === 'image'
    ? 'implicit-image' as const
    : shape.type === 'frame'
      ? 'implicit-frame' as const
      : 'implicit-rect' as const
  return { shapeId, expectedHolderKind }
}

function isGenerateImageToolName(value: unknown): boolean {
  return typeof value === 'string' && (value === 'generate_image' || value.endsWith('__generate_image'))
}

function generatedFileRelativePath(file: unknown): string {
  if (!file || typeof file !== 'object') return ''
  const candidate = file as GeneratedFileReference
  return typeof candidate.relativePath === 'string' && candidate.relativePath.trim()
    ? candidate.relativePath.trim()
    : ''
}

function generatedFileAbsolutePath(file: unknown): string {
  if (!file || typeof file !== 'object') return ''
  const candidate = file as GeneratedFileReference
  return typeof candidate.absolutePath === 'string' && candidate.absolutePath.trim()
    ? candidate.absolutePath.trim()
    : ''
}

function generatedFileImageUrl(file: unknown): string {
  return generatedFileAbsolutePath(file) || generatedFileRelativePath(file)
}

function generatedFileCompletionIdentity(
  blockId: string,
  file: unknown,
  index: number
): string {
  if (!file || typeof file !== 'object') return `${blockId}:file:${index}`
  const candidate = file as GeneratedFileReference
  const explicit = candidate.completionIdentity?.trim()
  if (explicit) return explicit
  const owned = candidate.artifactId?.trim() || candidate.mediaHandleId?.trim() ||
    candidate.id?.trim() || candidate.provenance?.invocationId?.trim() ||
    candidate.provenance?.jobId?.trim()
  if (owned) return owned
  return `${blockId}:${generatedFileImageUrl(candidate) || `file:${index}`}`
}

const GENERATED_IMAGE_PATH_PREFIXES = ['.kun/images/', '.deepseekgui-images/'] as const

function isGeneratedImagePath(path: string): boolean {
  return GENERATED_IMAGE_PATH_PREFIXES.some((prefix) => path.startsWith(prefix))
}

function latestGeneratedImageMarkdownPath(text: string): string | null {
  let latest: string | null = null
  const re = /!\[[^\]]*]\(([^)\s]+)\)/g
  for (const match of text.matchAll(re)) {
    const path = match[1]?.trim()
    if (path && isGeneratedImagePath(path)) latest = path
  }
  return latest
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function generatedImageUrlAliasesForTurn(blocks: readonly ChatBlock[]): Map<string, string> {
  const aliases = new Map<string, string>()
  for (const block of blocks) {
    if (block.kind !== 'tool' || block.status !== 'success' ||
      !isGenerateImageToolName(block.meta?.toolName)) continue
    const files = block.meta?.generatedFiles
    if (!Array.isArray(files)) continue
    for (const file of files) {
      const relativePath = generatedFileRelativePath(file)
      const imageUrl = generatedFileImageUrl(file)
      if (relativePath && imageUrl) aliases.set(relativePath, imageUrl)
    }
  }
  return aliases
}

export function rewriteGeneratedImageUrlsForTurn(value: unknown, blocks: readonly ChatBlock[]): unknown {
  const aliases = generatedImageUrlAliasesForTurn(blocks)
  return aliases.size === 0 ? value : rewriteGeneratedImageUrls(value, aliases)
}

function rewriteGeneratedImageUrls(value: unknown, aliases: ReadonlyMap<string, string>): unknown {
  if (Array.isArray(value)) return value.map((item) => rewriteGeneratedImageUrls(item, aliases))
  if (!isRecord(value)) return value
  let changed = false
  const next: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    const rewritten = key === 'imageUrl' && typeof entry === 'string'
      ? aliases.get(entry.trim()) ?? entry
      : rewriteGeneratedImageUrls(entry, aliases)
    if (rewritten !== entry) changed = true
    next[key] = rewritten
  }
  return changed ? next : value
}

export function latestGeneratedImageRelativePathForTurn(blocks: readonly ChatBlock[]): string | null {
  let latest: string | null = null
  for (const block of blocks) {
    if (block.kind === 'assistant') {
      latest = latestGeneratedImageMarkdownPath(block.text) ?? latest
      continue
    }
    if (block.kind !== 'tool' || block.status !== 'success' ||
      !isGenerateImageToolName(block.meta?.toolName)) continue
    const files = block.meta?.generatedFiles
    if (!Array.isArray(files)) continue
    for (const file of files) latest = generatedFileRelativePath(file) || latest
  }
  return latest
}

export function latestGeneratedImageUrlForTurn(blocks: readonly ChatBlock[]): string | null {
  let latest: string | null = null
  for (const block of blocks) {
    if (block.kind === 'assistant') {
      latest = latestGeneratedImageMarkdownPath(block.text) ?? latest
      continue
    }
    if (block.kind !== 'tool' || block.status !== 'success' ||
      !isGenerateImageToolName(block.meta?.toolName)) continue
    const files = block.meta?.generatedFiles
    if (!Array.isArray(files)) continue
    for (const file of files) latest = generatedFileImageUrl(file) || latest
  }
  return latest
}

/** Successful tool results only; assistant markdown is not a completion receipt. */
export function generatedImageResultsForTurn(
  blocks: readonly ChatBlock[]
): GeneratedImageResult[] {
  const results = new Map<string, GeneratedImageResult>()
  for (const block of blocks) {
    if (block.kind !== 'tool' || block.status !== 'success' ||
      !isGenerateImageToolName(block.meta?.toolName)) continue
    const files = block.meta?.generatedFiles
    if (!Array.isArray(files)) continue
    files.forEach((file, index) => {
      const imageUrl = generatedFileImageUrl(file)
      if (!imageUrl) return
      const completionIdentity = generatedFileCompletionIdentity(block.id, file, index)
      results.set(completionIdentity, { imageUrl, completionIdentity })
    })
  }
  return [...results.values()]
}
