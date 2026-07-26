import type { TurnItem } from '../contracts/items.js'

/**
 * Shared helpers for routing images returned by tools (the `read` tool
 * reading a picture, the `computer_use` tool returning a screenshot)
 * back into the model as real vision parts.
 *
 * Three pipeline layers strip or budget tool-result `data_base64` before
 * it ever reaches the model (token economy, request hygiene, and the
 * model client's plain-text serialization). These helpers give those
 * layers a single predicate to recognise model-visible images so the
 * recent ones survive, and give the agent loop a way to keep only the
 * most recent screenshots inline (Anthropic-style "keep last N images").
 */

export type ToolResultImage = {
  mimeType: string
  dataBase64: string
  width?: number
  height?: number
}

/**
 * Flat per-image token allowance used by the token estimators and the
 * request-hygiene budget. A forwarded screenshot costs the model a bounded
 * number of vision tokens regardless of its base64 length, so counting the
 * raw base64 (~hundreds of thousands of chars) would wildly over-estimate
 * context and force premature compaction.
 */
export const IMAGE_TOOL_RESULT_TOKEN_ESTIMATE = 1_200

/**
 * Tool output `kind` values whose images we forward to a vision model.
 * `image` is the read tool; `computer_screenshot` is computer_use. Other
 * base64-bearing outputs (e.g. generate_image, which saves to disk) are
 * intentionally excluded to preserve their existing behaviour and token
 * cost.
 */
const MODEL_VISIBLE_IMAGE_KINDS = new Set(['image', 'computer_screenshot', 'browser_screenshot'])

const EVICTED_IMAGE_PLACEHOLDER =
  '[older screenshot omitted to save context; take another screenshot if you need the current view]'
const BROWSER_USE_TRANSIENT_TTL_MS = 2 * 60_000
const BROWSER_USE_TRANSIENT_MAX = 8

type TransientBrowserUseOutput = {
  threadId: string
  output: unknown
  expiresAt: number
}

const transientBrowserUseOutputs = new Map<string, TransientBrowserUseOutput>()

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function prepareBrowserUseToolResultForPersistence(item: TurnItem): TurnItem {
  if (
    item.kind !== 'tool_result' ||
    item.toolName !== 'browser_use' ||
    !isRecord(item.output)
  ) {
    return item
  }
  const sanitized = sanitizeBrowserUseOutput(item.output)
  if (sanitized === item.output) return item
  purgeTransientBrowserUseOutputs()
  transientBrowserUseOutputs.set(item.id, {
    threadId: item.threadId,
    output: item.output,
    expiresAt: Date.now() + BROWSER_USE_TRANSIENT_TTL_MS
  })
  while (transientBrowserUseOutputs.size > BROWSER_USE_TRANSIENT_MAX) {
    const oldest = transientBrowserUseOutputs.keys().next().value
    if (typeof oldest !== 'string') break
    transientBrowserUseOutputs.delete(oldest)
  }
  return { ...item, output: sanitized }
}

export function rehydrateTransientBrowserUseOutputsForForward(history: TurnItem[]): TurnItem[] {
  purgeTransientBrowserUseOutputs()
  let changed = false
  const output = history.map((item) => {
    if (item.kind !== 'tool_result' || item.toolName !== 'browser_use') return item
    const transient = transientBrowserUseOutputs.get(item.id)
    if (!transient || transient.threadId !== item.threadId) return item
    transientBrowserUseOutputs.delete(item.id)
    changed = true
    return { ...item, output: transient.output }
  })
  return changed ? output : history
}

export function clearTransientBrowserUseOutputsForTest(): void {
  transientBrowserUseOutputs.clear()
}

function sanitizeBrowserUseOutput(output: Record<string, unknown>): Record<string, unknown> {
  let changed = false
  const sanitized: Record<string, unknown> = { ...output }
  if (Array.isArray(output.images)) {
    delete sanitized.images
    sanitized.images_omitted = output.images.length
    sanitized.note = 'Browser screenshot was forwarded transiently and was not persisted.'
    changed = true
  }
  if (isRecord(output.snapshot) && Array.isArray(output.snapshot.nodes)) {
    sanitized.snapshot = {
      ...output.snapshot,
      title: '[redacted]',
      nodes: [],
      truncated: true
    }
    sanitized.snapshot_nodes_omitted = output.snapshot.nodes.length
    changed = true
  }
  return changed ? sanitized : output
}

function purgeTransientBrowserUseOutputs(): void {
  const now = Date.now()
  for (const [id, entry] of transientBrowserUseOutputs) {
    if (entry.expiresAt <= now) transientBrowserUseOutputs.delete(id)
  }
}

function toImage(value: unknown): ToolResultImage | null {
  if (!isRecord(value)) return null
  const dataBase64 = typeof value.data_base64 === 'string' ? value.data_base64 : ''
  const mimeType = typeof value.mime_type === 'string' ? value.mime_type : ''
  if (!dataBase64 || !mimeType) return null
  const width = typeof value.width === 'number' ? value.width : undefined
  const height = typeof value.height === 'number' ? value.height : undefined
  return {
    mimeType,
    dataBase64,
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {})
  }
}

/**
 * Extract every model-visible image carried by a tool result output.
 * Supports the read-tool shape (`data_base64`/`mime_type` at the top
 * level) and the computer_use shape (an `images` array). Returns `[]`
 * for any output that is not a recognised image kind or carries no
 * base64 payload.
 */
export function extractToolResultImages(output: unknown): ToolResultImage[] {
  if (!isRecord(output)) return []
  const kind = typeof output.kind === 'string' ? output.kind : ''
  if (!MODEL_VISIBLE_IMAGE_KINDS.has(kind)) return []
  const images: ToolResultImage[] = []
  if (Array.isArray(output.images)) {
    for (const entry of output.images) {
      const image = toImage(entry)
      if (image) images.push(image)
    }
  }
  const single = toImage(output)
  if (single && !images.some((image) => image.dataBase64 === single.dataBase64)) {
    images.push(single)
  }
  return images
}

/** True when the output should be forwarded to the model as image(s). */
export function isModelVisibleImageOutput(output: unknown): boolean {
  return extractToolResultImages(output).length > 0
}

/**
 * Serialize a tool result output to text for the model while leaving the
 * heavy base64 payload out (it travels as a real image part instead).
 */
export function toolResultTextWithoutImages(output: unknown): string {
  if (typeof output === 'string') return output
  if (!isRecord(output)) {
    try {
      return JSON.stringify(output) ?? ''
    } catch {
      return String(output)
    }
  }
  const clone: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(output)) {
    if (key === 'data_base64' || key === 'images') continue
    clone[key] = value
  }
  try {
    return JSON.stringify(clone)
  } catch {
    return ''
  }
}

function stripImagesFromOutput(output: unknown): unknown {
  if (!isRecord(output)) return output
  const clone: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(output)) {
    if (key === 'data_base64') {
      // Removing the transport field is required: leaving any non-empty
      // string here makes extractToolResultImages() treat the placeholder as
      // real base64 and forwards the supposedly-evicted image again.
      continue
    }
    if (key === 'images') {
      clone.images_omitted = Array.isArray(value) ? value.length : 1
      continue
    }
    clone[key] = value
  }
  if (typeof clone.note !== 'string') clone.note = EVICTED_IMAGE_PLACEHOLDER
  return clone
}

/**
 * Keep inline image payloads only on the most recent `maxKept`
 * image-bearing tool results in the sent history; older screenshots are
 * collapsed to a small text note. This bounds context growth for long
 * computer-use sessions and keeps the downstream hygiene/economy layers
 * cheap (they only ever see a handful of base64 payloads). Operates on a
 * copy — the persisted session log is untouched.
 */
/**
 * How many of the most recent generated images to forward back to the model so a
 * vision-capable design agent can SEE what it produced and self-review/regenerate.
 * Small on purpose — the just-generated one for the current turn is the priority.
 */
export const MAX_FORWARDED_GENERATED_IMAGES = 1

/** True for a successful generate_image tool result (no base64 persisted on it). */
export function isGeneratedImageToolResult(item: TurnItem | undefined): boolean {
  return Boolean(item) && item!.kind === 'tool_result' && item!.toolName === 'generate_image' && item!.isError !== true
}

/**
 * Return a COPY of `history` where the most recent N successful generate_image
 * results are augmented — IN MEMORY ONLY — into the model-visible image shape
 * (`kind:'image'` + base64), reading the bytes via `resolve` (the caller wires it
 * to the already-persisted attachment store / disk file). The persisted tool
 * output is NEVER mutated, so the deliberate "no base64 in generate_image output"
 * guard stays intact; the base64 lives only in this transient request copy.
 * Reusing `kind:'image'` means the four downstream layers (model client vision
 * forwarding, token estimate, economy, hygiene) handle it with zero extra wiring.
 */
export async function rehydrateGeneratedImagesForForward(
  history: TurnItem[],
  resolve: (output: Record<string, unknown>) => Promise<ToolResultImage | null>,
  maxForwarded: number = MAX_FORWARDED_GENERATED_IMAGES
): Promise<TurnItem[]> {
  const keep = Math.max(0, Math.floor(maxForwarded))
  if (keep === 0) return history
  const targets: number[] = []
  for (let index = history.length - 1; index >= 0 && targets.length < keep; index -= 1) {
    if (isGeneratedImageToolResult(history[index])) targets.push(index)
  }
  if (targets.length === 0) return history
  const resolved = new Map<number, ToolResultImage>()
  await Promise.all(
    targets.map(async (index) => {
      const item = history[index]
      if (item.kind !== 'tool_result' || !isRecord(item.output)) return
      try {
        const image = await resolve(item.output)
        if (image) resolved.set(index, image)
      } catch {
        // graceful: a scope miss / missing file just means "no image forwarded"
      }
    })
  )
  if (resolved.size === 0) return history
  return history.map((item, index) => {
    const image = resolved.get(index)
    if (!image || item.kind !== 'tool_result' || !isRecord(item.output)) return item
    return {
      ...item,
      output: {
        ...item.output,
        kind: 'image',
        mime_type: image.mimeType,
        data_base64: image.dataBase64,
        ...(image.width !== undefined ? { width: image.width } : {}),
        ...(image.height !== undefined ? { height: image.height } : {})
      }
    }
  })
}

export function capToolResultImages(history: TurnItem[], maxKept: number): TurnItem[] {
  const keep = Math.max(0, Math.floor(maxKept))
  const imageIndexes: number[] = []
  for (let index = 0; index < history.length; index += 1) {
    const item = history[index]
    if (item?.kind === 'tool_result' && isModelVisibleImageOutput(item.output)) {
      imageIndexes.push(index)
    }
  }
  if (imageIndexes.length <= keep) return history
  const evict = new Set(imageIndexes.slice(0, imageIndexes.length - keep))
  return history.map((item, index) => {
    if (!evict.has(index) || item.kind !== 'tool_result') return item
    return { ...item, output: stripImagesFromOutput(item.output) }
  })
}
