import { randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type {
  ImageGenerationResolution,
  KunCapabilitiesConfig
} from '../../contracts/capabilities.js'
import type { AttachmentContent, AttachmentStore } from '../../attachments/attachment-store.js'
import { detectImage } from '../../attachments/attachment-store.js'
import type { ToolHostContext } from '../../ports/tool-host.js'
import type { CapabilityToolProvider } from './capability-registry.js'
import { resolveWorkspacePath } from './builtin-tool-utils.js'
import { LocalToolHost } from './local-tool-host.js'

const GENERATED_IMAGE_DIR = '.kun/images'
const MAX_REFERENCE_IMAGE_BYTES = 10 * 1024 * 1024
const REFERENCE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp'])
const ASPECT_RATIOS = new Set(['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3', '21:9'])
const GROK_IMAGINE_ASPECT_RATIOS = [
  '1:1',
  '16:9',
  '9:16',
  '4:3',
  '3:4',
  '3:2',
  '2:3',
  '2:1',
  '1:2',
  '19.5:9',
  '9:19.5',
  '20:9',
  '9:20'
] as const
const KNOWN_ASPECT_RATIOS = new Set([...ASPECT_RATIOS, ...GROK_IMAGINE_ASPECT_RATIOS])
const SIZE_TIERS: Record<string, number> = {
  '1K': 1024,
  '2K': 2048,
  '3K': 3072,
  '4K': 4096
}
const DEFAULT_IMAGE_SIZE_TIERS = ['1K', '2K'] as const
const VOLCENGINE_IMAGE_SIZE_TIERS = ['2K', '3K', '4K'] as const
const COMPATIBLE_SIZE_FALLBACK = SIZE_TIERS['1K']
const SIZE_STEP = 64
const MIN_EDGE = 256
const CODEX_IMAGE_RESPONSES_MODEL = 'gpt-5.5'
const CODEX_IMAGE_INSTRUCTIONS = 'You must fulfill image generation requests by using the image_generation tool.'
const MAX_CODEX_IMAGE_SSE_BYTES = 64 * 1024 * 1024
const MAX_CODEX_IMAGE_SSE_EVENTS = 512
const MAX_CODEX_IMAGE_BASE64_CHARS = 64 * 1024 * 1024

type CodexImageToolChoiceMode = 'allowed_tools' | 'required' | 'none'
type ImageGenerationQuality = 'auto' | 'low' | 'medium' | 'high'

export type GeneratedImage = { data: Buffer; mimeType: string }

export type ImageGenRequest = {
  prompt: string
  model: string
  aspectRatio?: string
  size?: string
  quality?: ImageGenerationQuality
  timeoutMs: number
  signal: AbortSignal
}

export type ImageGenEditRequest = ImageGenRequest & {
  images: { name: string; mimeType: string; data: Buffer }[]
}

export class ImageGenHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string
  ) {
    super(`HTTP ${status}: ${body}`)
  }
}

/**
 * Node's fetch reports every network failure as a bare `TypeError: fetch
 * failed`, hiding the actionable detail (DNS, refused connection, TLS, …)
 * in the `cause` chain. Flatten that chain into one readable message.
 */
export function describeNetworkError(error: unknown): string {
  const parts: string[] = []
  let current: unknown = error
  for (let depth = 0; depth < 5 && current != null; depth += 1) {
    if (current instanceof AggregateError && current.errors.length > 0) {
      current = current.errors[0]
      continue
    }
    if (!(current instanceof Error)) {
      parts.push(String(current))
      break
    }
    const code = (current as { code?: unknown }).code
    const codeText = typeof code === 'string' ? code : ''
    const message = current.message.trim()
    if (message) {
      parts.push(codeText && !message.includes(codeText) ? `${message} (${codeText})` : message)
    } else if (codeText) {
      parts.push(codeText)
    }
    current = current.cause
  }
  const unique = parts.filter((part, index) => parts.indexOf(part) === index)
  return unique.join(': ') || 'unknown network error'
}

function imageFetchFailure(
  url: string,
  error: unknown,
  request: { timeoutMs: number }
): Error {
  const target = url.split('?')[0]
  if (error instanceof DOMException && error.name === 'TimeoutError') {
    return new Error(`image request to ${target} timed out after ${request.timeoutMs}ms`, { cause: error })
  }
  if (error instanceof DOMException && error.name === 'AbortError') {
    return new Error(`image request to ${target} was canceled`, { cause: error })
  }
  return new Error(`image request to ${target} failed: ${describeNetworkError(error)}`, { cause: error })
}

export interface ImageGenClient {
  id: string
  generate(request: ImageGenRequest): Promise<GeneratedImage>
  edit(request: ImageGenEditRequest): Promise<GeneratedImage>
}

export type ImageGenDiagnostic = {
  id: 'imageGen'
  enabled: boolean
  available: boolean
  model?: string
  reason?: string
}

export type ImageGenToolProviderOptions = {
  client?: ImageGenClient
  attachmentStore?: AttachmentStore
  nowIso?: () => string
  resolveCredential?: ProviderCredentialResolver
}

export type ProviderCredentialResolver = (providerId: string) => Promise<{
  apiKey: string
  headers?: Record<string, string>
}>

export type ImageGenToolProviderBuildResult = {
  providers: CapabilityToolProvider[]
  diagnostics: ImageGenDiagnostic[]
  available: boolean
}

/**
 * Map UI-friendly aspect ratio + size tier to an OpenAI-compatible "WxH"
 * size string. Long edge anchors to the explicit tier first, then a custom
 * default size, then the configured default resolution. Short edge follows the
 * ratio snapped to multiples of 64 with a 256px floor. `auto` is passed through
 * when no ratio is requested; a ratio needs concrete dimensions, so an `auto`
 * resolution uses a compatible 1K fallback.
 */
export function mapImageSize(
  aspectRatio: string | undefined,
  imageSize: string | undefined,
  defaultSize: string | undefined,
  defaultResolution: ImageGenerationResolution = '1K'
): string | undefined {
  if (imageSize) {
    return sizeForLongEdge(aspectRatio, SIZE_TIERS[imageSize] ?? COMPATIBLE_SIZE_FALLBACK)
  }

  if (defaultSize) {
    if (!aspectRatio) return defaultSize
    const longEdge = parseSizeLongEdge(defaultSize)
    if (longEdge) return sizeForLongEdge(aspectRatio, longEdge)
  }

  if (!aspectRatio && defaultResolution === 'auto') return 'auto'
  return sizeForLongEdge(
    aspectRatio,
    SIZE_TIERS[defaultResolution] ?? COMPATIBLE_SIZE_FALLBACK
  )
}

function sizeForLongEdge(aspectRatio: string | undefined, longEdge: number): string {
  const parsed = parseRatio(aspectRatio)
  if (!parsed) return `${longEdge}x${longEdge}`
  const { w, h } = parsed
  if (w === h) return `${longEdge}x${longEdge}`
  const short = Math.max(
    MIN_EDGE,
    Math.round((longEdge * Math.min(w, h)) / Math.max(w, h) / SIZE_STEP) * SIZE_STEP
  )
  return w > h ? `${longEdge}x${short}` : `${short}x${longEdge}`
}

function parseSizeLongEdge(size: string): number | undefined {
  const match = /^(\d+)x(\d+)$/.exec(size.trim())
  if (!match) return undefined
  const width = Number(match[1])
  const height = Number(match[2])
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return undefined
  return Math.max(width, height)
}

function parseRatio(aspectRatio: string | undefined): { w: number; h: number } | null {
  if (!aspectRatio || !KNOWN_ASPECT_RATIOS.has(aspectRatio)) return null
  const [w, h] = aspectRatio.split(':').map(Number)
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null
  return { w, h }
}

/**
 * Whether the configured image protocol performs a GENUINE image-to-image edit
 * (real `/images/edits`). Allowlist on purpose: a new protocol defaults to "no
 * edit" until its edit path is verified. Codex's Responses image_generation
 * path accepts `input_image` references and an explicit `action: "edit"`.
 * MiniMax's reference feature is `subject_reference` = character/identity
 * preservation, NOT a general edit, so routing canvas "edit this image"
 * requests through it silently produces a fresh (wrong) generation — better to
 * fail loudly and have the agent retry without references. `undefined` = the
 * default factory path (OpenAI-compat /images/edits).
 */
export function protocolSupportsImageEdit(protocol: string | undefined): boolean {
  return protocol === undefined ||
    protocol === 'openai-images' ||
    protocol === 'codex-responses-image' ||
    protocol === 'volcengine-ark-image'
}

export function buildImageGenToolProviders(
  config: KunCapabilitiesConfig['imageGen'] | undefined,
  options: ImageGenToolProviderOptions = {}
): ImageGenToolProviderBuildResult {
  if (!config?.enabled) {
    return { providers: [], diagnostics: [], available: false }
  }

  const missing = [
    !config.baseUrl ? 'baseUrl' : undefined,
    !config.apiKey && !(config.providerId && options.resolveCredential) ? 'apiKey' : undefined,
    !config.model ? 'model' : undefined
  ].filter((field): field is string => Boolean(field))

  if (missing.length > 0) {
    const reason = `image generation provider is not configured (missing ${missing.join(', ')})`
    return {
      providers: [{ id: 'imageGen', kind: 'image', enabled: true, available: false, reason, tools: [] }],
      diagnostics: [{ id: 'imageGen', enabled: true, available: false, model: config.model, reason }],
      available: false
    }
  }

  const model = config.model!
  // Only advertise (and accept) image-to-image when the active protocol can truly
  // edit; otherwise the param is dropped so the model never tries a reference edit
  // the provider would silently mishandle.
  const supportsEdit = protocolSupportsImageEdit(config.protocol)
  const isGrokImagine = config.protocol === 'grok-imagine-image'
  const isVolcengineArk = config.protocol === 'volcengine-ark-image'
  const imageSizeTiers = isVolcengineArk
    ? VOLCENGINE_IMAGE_SIZE_TIERS
    : DEFAULT_IMAGE_SIZE_TIERS
  const imageSizeTierDescription = isVolcengineArk
    ? '2K, 3K, or 4K'
    : '1K or 2K'
  const effectiveDefaultResolution: ImageGenerationResolution = isVolcengineArk
    ? config.defaultResolution === '3K' || config.defaultResolution === '4K'
      ? config.defaultResolution
      : '2K'
    : config.defaultResolution === 'auto' ||
        config.defaultResolution === '1K' ||
        config.defaultResolution === '2K'
      ? config.defaultResolution
      : '1K'

  const tool = LocalToolHost.defineTool({
    name: 'generate_image',
    toolKind: 'file_change',
    description: [
      'Generate an image from a text prompt using the configured image provider.',
      supportsEdit
        ? 'Optionally pass reference_image_paths (workspace files) and/or reference_attachment_ids (authorized image attachments from the current thread) to guide the result (image-to-image).'
        : '',
      `The generated image is saved under ${GENERATED_IMAGE_DIR}/ in the workspace and returned as an inline attachment preview.`,
      'Generates exactly one image per call; call again for variations.',
      'Image quality is applied automatically from Settings and is independent of resolution.',
      'If you can see images, the generated result is shown back to you — inspect it and call again to refine if it does not match what was asked.'
    ].filter(Boolean).join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Detailed description of the image to generate' },
        aspect_ratio: {
          type: 'string',
          enum: isGrokImagine ? [...GROK_IMAGINE_ASPECT_RATIOS] : [...ASPECT_RATIOS],
          description: 'Optional output aspect ratio. It changes proportions while preserving the selected or default resolution.'
        },
        image_size: {
          type: 'string',
          enum: [...imageSizeTiers],
          description: `Optional resolution override. Set it only when the user explicitly requests ${imageSizeTierDescription}; otherwise omit it so the Settings default resolution is used. Resolution is independent of image quality.`
        },
        ...(supportsEdit
          ? {
              reference_image_paths: {
                type: 'array',
                items: { type: 'string' },
                maxItems: config.maxReferenceImages,
                description: 'Workspace-relative paths of reference images for image-to-image guidance'
              },
              reference_attachment_ids: {
                type: 'array',
                items: { type: 'string' },
                maxItems: config.maxReferenceImages,
                description: 'Authorized image attachment IDs from the current thread or workspace for image-to-image guidance'
              }
            }
          : {})
      },
      required: ['prompt'],
      additionalProperties: false
    },
    policy: 'untrusted',
    execute: async (args, context) => {
      const startedAt = Date.now()
      const prompt = pickString(args.prompt)
      if (!prompt) return toolError('invalid_prompt', 'prompt is required')

      const aspectRatio = pickString(args.aspect_ratio)
      const imageSize = pickString(args.image_size)
      const size = mapImageSize(
        aspectRatio,
        imageSize,
        isGrokImagine ? undefined : config.defaultSize,
        effectiveDefaultResolution
      )

      const references = await collectReferenceImages(
        args.reference_image_paths,
        args.reference_attachment_ids,
        context,
        config.maxReferenceImages,
        options.attachmentStore
      )
      if ('error' in references) return references.error

      const endpoint = references.images.length > 0 ? 'edits' : 'generations'
      // Fail loudly BEFORE any network call when the active provider can't truly
      // edit (e.g. MiniMax, whose subject_reference is identity preservation, not
      // a general edit) — a silently-wrong fresh generation is worse than an error
      // the agent recovers from by retrying without references.
      if (endpoint === 'edits' && !supportsEdit) {
        return toolError(
          'edits_unsupported',
          'the active image provider does not support editing an existing image (its reference feature is subject/identity guidance, not a faithful edit); retry generate_image WITHOUT reference_image_paths'
        )
      }
      let image: GeneratedImage
      let client = options.client
      const requestTelemetry = () => telemetry(startedAt, client?.id ?? 'image-provider')
      try {
        if (!client) {
          const credential = config.providerId && options.resolveCredential
            ? await options.resolveCredential(config.providerId)
            : undefined
          client = createImageGenClient({
            ...config,
            ...(credential ? {
              apiKey: credential.apiKey,
              headers: { ...(config.headers ?? {}), ...(credential.headers ?? {}) }
            } : {})
          })
        }
        const request = {
          prompt,
          model,
          ...(aspectRatio ? { aspectRatio } : {}),
          ...(size && size !== 'auto' ? { size } : {}),
          quality: config.quality,
          timeoutMs: config.timeoutMs,
          signal: context.abortSignal
        }
        image = endpoint === 'edits'
          ? await client.edit({ ...request, images: references.images })
          : await client.generate(request)
      } catch (error) {
        if (error instanceof ImageGenHttpError) {
          if (endpoint === 'edits' && (error.status === 404 || error.status === 405 || error.status === 501)) {
            return toolError(
              'edits_unsupported',
              'the configured image provider does not support reference image edits; retry generate_image without reference_image_paths'
            )
          }
          return toolError('provider_error', error.message, requestTelemetry())
        }
        return toolError('generation_failed', errorMessage(error), requestTelemetry())
      }

      const detected = detectImage(image.data)
      const mimeType = detected?.mimeType ?? image.mimeType ?? 'image/png'
      const ext = mimeType === 'image/jpeg' ? 'jpg' : mimeType === 'image/webp' ? 'webp' : 'png'
      const stamp = (options.nowIso?.() ?? new Date().toISOString()).replace(/\D/g, '').slice(0, 14)
      const fileName = `img-${stamp}-${randomBytes(2).toString('hex')}.${ext}`
      // Forward slashes regardless of platform: the path is echoed back to the
      // model and rendered in chat, where POSIX-style relative paths are expected.
      const relativePath = `${GENERATED_IMAGE_DIR}/${fileName}`
      let absolutePath: string
      try {
        const target = await resolveWorkspacePath(relativePath, context, { enforceWorkspaceBoundary: true })
        await mkdir(dirname(target.absolutePath), { recursive: true })
        // Re-check after directory creation: an existing generated-dir symlink
        // is the common escape path, and a racing replacement must not turn an
        // otherwise lexical in-workspace path into an outside write.
        absolutePath = (await resolveWorkspacePath(relativePath, context, {
          enforceWorkspaceBoundary: true
        })).absolutePath
        await writeFile(absolutePath, image.data)
      } catch (error) {
        return toolError('workspace_path_escape', errorMessage(error), requestTelemetry())
      }

      const warnings: string[] = []
      const attachments: { id: string; name: string; mimeType: string; width?: number; height?: number }[] = []
      if (options.attachmentStore) {
        try {
          const attachment = await options.attachmentStore.create({
            name: fileName,
            data: image.data,
            mimeType,
            threadId: context.threadId,
            workspace: context.workspace
          })
          attachments.push({
            id: attachment.id,
            name: attachment.name,
            mimeType: attachment.mimeType,
            ...(attachment.width ? { width: attachment.width } : {}),
            ...(attachment.height ? { height: attachment.height } : {})
          })
        } catch (error) {
          warnings.push(`inline preview unavailable: ${errorMessage(error)}`)
        }
      } else {
        warnings.push('inline preview unavailable: attachment store is disabled')
      }

      return {
        output: {
          files: [{
            relativePath,
            absolutePath,
            mimeType,
            byteSize: image.data.byteLength,
            ...(detected?.width ? { width: detected.width } : {}),
            ...(detected?.height ? { height: detected.height } : {})
          }],
          attachments,
          model,
          ...(size ? { size } : {}),
          quality: config.quality,
          endpoint,
          mode: endpoint === 'edits' ? 'edit' : 'generation',
          referenceImageCount: references.images.length,
          warnings,
          telemetry: requestTelemetry()
        }
      }
    }
  })

  return {
    providers: [{ id: 'imageGen', kind: 'image', enabled: true, available: true, tools: [tool] }],
    diagnostics: [{ id: 'imageGen', enabled: true, available: true, model }],
    available: true
  }
}

type ReferenceImages = { images: { name: string; mimeType: string; data: Buffer }[] }
type ReferenceError = { error: { output: unknown; isError: true } }

async function collectReferenceImages(
  pathValue: unknown,
  attachmentIdValue: unknown,
  context: ToolHostContext,
  maxCount: number,
  attachmentStore: AttachmentStore | undefined
): Promise<ReferenceImages | ReferenceError> {
  const paths = parseReferenceStrings(pathValue, 'reference_image_paths', 'invalid_reference_path')
  if ('error' in paths) return paths
  const attachmentIds = parseReferenceStrings(
    attachmentIdValue,
    'reference_attachment_ids',
    'invalid_reference_attachment'
  )
  if ('error' in attachmentIds) return attachmentIds
  if (paths.values.length + attachmentIds.values.length > maxCount) {
    return {
      error: toolError(
        'invalid_reference_count',
        `at most ${maxCount} reference images are allowed across reference_image_paths and reference_attachment_ids`
      )
    }
  }

  const images: ReferenceImages['images'] = []
  for (const rawPath of paths.values) {
    let resolved: string
    try {
      resolved = (await resolveWorkspacePath(rawPath, context, { enforceWorkspaceBoundary: true })).absolutePath
    } catch {
      return { error: toolError('invalid_reference_path', `reference image must be inside the workspace: ${rawPath}`) }
    }
    let data: Buffer
    try {
      data = await readFile(resolved)
    } catch {
      return { error: toolError('invalid_reference_path', `reference image not found: ${rawPath}`) }
    }
    const validated = validateReferenceImage(data, rawPath, 'invalid_reference_path')
    if ('error' in validated) return validated
    images.push({
      name: rawPath.split(/[\\/]/).pop() || 'reference.png',
      mimeType: validated.mimeType,
      data
    })
  }

  if (attachmentIds.values.length > 0 && !attachmentStore) {
    return {
      error: toolError(
        'invalid_reference_attachment',
        'reference attachments are unavailable because the attachment store is disabled'
      )
    }
  }
  for (const id of attachmentIds.values) {
    let attachment: AttachmentContent
    try {
      attachment = await attachmentStore!.resolveContent(id, {
        threadId: context.threadId,
        workspace: context.workspace
      })
    } catch {
      return {
        error: toolError(
          'invalid_reference_attachment',
          `reference attachment is unavailable or unauthorized: ${id}`
        )
      }
    }
    const validated = validateReferenceImage(
      attachment.data,
      id,
      'invalid_reference_attachment'
    )
    if ('error' in validated) return validated
    images.push({ name: attachment.name, mimeType: validated.mimeType, data: attachment.data })
  }
  return { images }
}

type ReferenceErrorCode = 'invalid_reference_path' | 'invalid_reference_attachment'

function parseReferenceStrings(
  value: unknown,
  field: string,
  code: ReferenceErrorCode
): { values: string[] } | ReferenceError {
  if (value === undefined || value === null) return { values: [] }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    return { error: toolError(code, `${field} must be an array of strings`) }
  }
  return { values: value.map((entry) => entry.trim()).filter(Boolean) }
}

function validateReferenceImage(
  data: Buffer,
  label: string,
  code: ReferenceErrorCode
): { mimeType: string } | ReferenceError {
  if (data.byteLength > MAX_REFERENCE_IMAGE_BYTES) {
    return {
      error: toolError(code, `reference image exceeds ${MAX_REFERENCE_IMAGE_BYTES} byte limit: ${label}`)
    }
  }
  const detected = detectImage(data)
  if (!detected || !REFERENCE_MIME_TYPES.has(detected.mimeType)) {
    return {
      error: toolError(code, `reference image must be png, jpeg, or webp: ${label}`)
    }
  }
  return { mimeType: detected.mimeType }
}

type ImagesApiPayload = { data?: { b64_json?: string; url?: string }[] }
type VolcengineArkImagesPayload = {
  data?: { b64_json?: string; url?: string }[]
  error?: { code?: string; message?: string }
}
type CodexResponsesImageEvent = {
  type?: string
  partial_image_b64?: string
  item?: {
    type?: string
    result?: string
    revised_prompt?: string
  }
  response?: {
    output?: Array<{
      type?: string
      result?: string
      revised_prompt?: string
    }>
  }
  error?: {
    code?: string
    message?: string
  }
  message?: string
}
type MiniMaxImagePayload = {
  data?: {
    image_base64?: string[]
    image_urls?: string[]
  }
  base_resp?: {
    status_code?: number
    status_msg?: string
  }
}

export function createImageGenClient(config: {
  protocol?: string
  baseUrl?: string
  apiKey?: string
  headers?: Record<string, string>
}): ImageGenClient {
  if (config.protocol === 'minimax-image') {
    return new MiniMaxImageClient(config.baseUrl!, config.apiKey!)
  }
  if (config.protocol === 'codex-responses-image') {
    return new CodexResponsesImageClient(config.baseUrl!, config.apiKey!, config.headers)
  }
  if (config.protocol === 'grok-imagine-image') {
    return new GrokImagineImageClient(config.baseUrl!, config.apiKey!, config.headers)
  }
  if (config.protocol === 'volcengine-ark-image') {
    return new VolcengineArkImageClient(config.baseUrl!, config.apiKey!)
  }
  return new OpenAiCompatImageClient(config.baseUrl!, config.apiKey!)
}

/**
 * Endpoint URL for an OpenAI-compatible images API. Mirrors the chat
 * client's base-url rule so the same provider baseUrl works for both:
 * a versioned base (`…/v1`) gets the endpoint appended, anything else
 * gets `/v1` inserted first (e.g. `https://zenmux.ai/api` →
 * `…/api/v1/images/generations`). A fully-qualified endpoint URL is
 * kept, including re-routing between generations and edits.
 */
export function openAiCompatImageUrl(
  baseUrl: string,
  endpoint: 'generations' | 'edits'
): string {
  const path = `images/${endpoint}`
  let normalized = trimTrailingSlashes(baseUrl.trim())
  if (!normalized) return `/v1/${path}`
  const lower = normalized.toLowerCase()
  if (lower.endsWith(`/${path}`)) return normalized
  for (const known of ['images/generations', 'images/edits']) {
    if (lower.endsWith(`/${known}`)) {
      normalized = trimTrailingSlashes(normalized.slice(0, -known.length))
      break
    }
  }
  const lastSegment = normalized.split('/').pop()?.toLowerCase() ?? ''
  if (isVersionSegment(lastSegment)) return `${normalized}/${path}`
  return `${normalized}/v1/${path}`
}

export function codexResponsesImageUrl(baseUrl: string): string {
  const normalized = trimTrailingSlashes(baseUrl.trim())
  if (!normalized) return '/responses'
  if (normalized.toLowerCase().endsWith('/responses')) return normalized
  return `${normalized}/responses`
}

export function volcengineArkImageUrl(baseUrl: string): string {
  const normalized = trimTrailingSlashes(baseUrl.trim())
  if (!normalized) return '/images/generations'
  if (normalized.toLowerCase().endsWith('/images/generations')) return normalized
  return `${normalized}/images/generations`
}

function imageDataUrl(image: { mimeType: string; data: Buffer }): string {
  const mimeType = image.mimeType.trim() || 'image/png'
  return `data:${mimeType};base64,${image.data.toString('base64')}`
}

async function readLimitedResponseText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) {
    const text = await response.text()
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      throw new Error('Codex image generation response exceeded size limit')
    }
    return text
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const chunks: string[] = []
  let byteLength = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (value) {
        byteLength += value.byteLength
        if (byteLength > maxBytes) {
          await reader.cancel().catch(() => undefined)
          throw new Error('Codex image generation response exceeded size limit')
        }
        chunks.push(decoder.decode(value, { stream: !done }))
      }
      if (done) {
        const tail = decoder.decode()
        if (tail) chunks.push(tail)
        return chunks.join('')
      }
    }
  } finally {
    reader.releaseLock()
  }
}

function parseCodexResponsesImageEvents(body: string): CodexResponsesImageEvent[] {
  const events: CodexResponsesImageEvent[] = []
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith('data: ')) continue
    const data = line.slice(6).trim()
    if (!data || data === '[DONE]') continue
    try {
      events.push(JSON.parse(data) as CodexResponsesImageEvent)
    } catch {
      continue
    }
    if (events.length > MAX_CODEX_IMAGE_SSE_EVENTS) {
      throw new Error('Codex image generation response exceeded event limit')
    }
  }
  return events
}

function decodeCodexImagePayload(payload: string): Buffer {
  if (payload.length > MAX_CODEX_IMAGE_BASE64_CHARS) {
    throw new Error('Codex image generation result exceeded size limit')
  }
  return Buffer.from(payload, 'base64')
}

function codexImageFromResult(result: string | undefined): GeneratedImage | null {
  if (!result) return null
  return { data: decodeCodexImagePayload(result), mimeType: 'image/png' }
}

function codexResponseOutputText(event: CodexResponsesImageEvent): string {
  const output = event.response?.output ?? []
  const parts: string[] = []
  for (const item of output) {
    const record = item as Record<string, unknown>
    const content = record.content
    if (!Array.isArray(content)) continue
    for (const entry of content) {
      if (!entry || typeof entry !== 'object') continue
      const text = (entry as Record<string, unknown>).text
      if (typeof text === 'string' && text.trim()) parts.push(text.trim())
    }
  }
  return parts.join(' ').replace(/\s+/g, ' ').slice(0, 300)
}

function summarizeCodexResponsesImage(body: string): string {
  try {
    const events = parseCodexResponsesImageEvents(body)
    const types = [...new Set(events.map((event) => event.type).filter((type): type is string => Boolean(type)))]
      .slice(0, 8)
      .join(', ')
    const completed = events.find((event) => event.type === 'response.completed')
    const outputTypes = [...new Set((completed?.response?.output ?? []).map((item) => item.type).filter(Boolean))]
      .slice(0, 8)
      .join(', ')
    const text = completed ? codexResponseOutputText(completed) : ''
    const parts = [
      types ? `events: ${types}` : '',
      outputTypes ? `output: ${outputTypes}` : '',
      text ? `text: ${text}` : ''
    ].filter(Boolean)
    return parts.length > 0 ? ` (${parts.join('; ')})` : ''
  } catch {
    return ''
  }
}

function isCodexToolChoiceError(status: number, body: string): boolean {
  if (status !== 400) return false
  return /tool[_ ]choice|allowed_tools|image_generation.*tools|tools.*image_generation/i.test(body)
}

function codexImageModelSupportsInputFidelity(model: string): boolean {
  const normalized = model.trim().toLowerCase()
  return normalized !== 'gpt-image-2' && normalized !== 'gpt-image-2-codex'
}

function isCodexInputFidelityModelError(status: number, body: string): boolean {
  if (status !== 400) return false
  if (/invalid_input_fidelity_model/i.test(body)) return true
  return /input_fidelity.{0,200}(?:does not support|not supported|unsupported)/is.test(body) ||
    /(?:does not support|not supported|unsupported).{0,200}input_fidelity/is.test(body)
}

function extractCodexResponsesImage(body: string): GeneratedImage | null {
  const events = parseCodexResponsesImageEvents(body)
  const failure = events.find((event) => event.type === 'response.failed' || event.type === 'error')
  if (failure) {
    const message = failure.error?.message ??
      failure.message ??
      (failure.error?.code ? `Codex image generation failed (${failure.error.code})` : '')
    throw new Error(message || 'Codex image generation failed')
  }

  for (const event of events) {
    if (
      event.type === 'response.output_item.done' &&
      event.item?.type === 'image_generation_call'
    ) {
      const image = codexImageFromResult(event.item.result)
      if (image) return image
    }
  }

  let latestPartial: GeneratedImage | null = null
  for (const event of events) {
    if (event.type !== 'response.image_generation_call.partial_image') continue
    latestPartial = codexImageFromResult(event.partial_image_b64) ?? latestPartial
  }

  const completed = events.find((event) => event.type === 'response.completed')
  for (const item of completed?.response?.output ?? []) {
    if (item.type !== 'image_generation_call') continue
    const image = codexImageFromResult(item.result)
    if (image) return image
  }
  return latestPartial
}

export class OpenAiCompatImageClient implements ImageGenClient {
  readonly id = 'openai-compat'
  private readonly baseUrl: string

  constructor(
    baseUrl: string,
    private readonly apiKey: string
  ) {
    this.baseUrl = trimTrailingSlashes(baseUrl)
  }

  async generate(request: ImageGenRequest): Promise<GeneratedImage> {
    const body = (includeResponseFormat: boolean, includeQuality: boolean) =>
      JSON.stringify({
        model: request.model,
        prompt: request.prompt,
        n: 1,
        ...(request.size ? { size: request.size } : {}),
        ...(includeQuality && request.quality && request.quality !== 'auto' ? { quality: request.quality } : {}),
        ...(includeResponseFormat ? { response_format: 'b64_json' } : {})
      })
    return this.requestImage(
      openAiCompatImageUrl(this.baseUrl, 'generations'),
      (includeResponseFormat, includeQuality) => ({
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: body(includeResponseFormat, includeQuality)
      }),
      request
    )
  }

  async edit(request: ImageGenEditRequest): Promise<GeneratedImage> {
    const buildForm = (includeResponseFormat: boolean, includeQuality: boolean) => {
      const form = new FormData()
      form.set('model', request.model)
      form.set('prompt', request.prompt)
      if (request.size) form.set('size', request.size)
      if (includeQuality && request.quality && request.quality !== 'auto') form.set('quality', request.quality)
      if (includeResponseFormat) form.set('response_format', 'b64_json')
      const field = request.images.length > 1 ? 'image[]' : 'image'
      for (const image of request.images) {
        form.append(field, new Blob([new Uint8Array(image.data)], { type: image.mimeType }), image.name)
      }
      return form
    }
    return this.requestImage(
      openAiCompatImageUrl(this.baseUrl, 'edits'),
      (includeResponseFormat, includeQuality) => ({
        headers: { Authorization: `Bearer ${this.apiKey}` },
        body: buildForm(includeResponseFormat, includeQuality)
      }),
      request
    )
  }

  /**
   * POST with two compat fallbacks: providers that reject `response_format`
   * (e.g. gpt-image-1) get one retry without it, and providers that return a
   * URL instead of b64_json (e.g. SiliconFlow default) get a second download.
   */
  private async requestImage(
    url: string,
    init: (
      includeResponseFormat: boolean,
      includeQuality: boolean
    ) => { headers: Record<string, string>; body: string | FormData },
    request: { timeoutMs: number; signal: AbortSignal; quality?: ImageGenerationQuality }
  ): Promise<GeneratedImage> {
    const signal = withTimeout(request.signal, request.timeoutMs)
    const post = async (includeResponseFormat: boolean, includeQuality: boolean): Promise<Response> => {
      try {
        return await fetch(url, { method: 'POST', ...init(includeResponseFormat, includeQuality), signal })
      } catch (error) {
        throw imageFetchFailure(url, error, request)
      }
    }
    let includeResponseFormat = true
    let includeQuality = Boolean(request.quality && request.quality !== 'auto')
    let response = await post(includeResponseFormat, includeQuality)
    if (!response.ok && response.status >= 400 && response.status < 500) {
      let errorBody = await response.text()
      if (includeQuality && /quality/i.test(errorBody)) {
        includeQuality = false
        response = await post(includeResponseFormat, includeQuality)
        if (!response.ok && response.status >= 400 && response.status < 500) {
          errorBody = await response.text()
        }
      }
      if (!response.ok && response.status >= 400 && response.status < 500) {
        if (!/response_format/i.test(errorBody)) throw new ImageGenHttpError(response.status, errorBody)
        includeResponseFormat = false
        response = await post(includeResponseFormat, includeQuality)
      }
    }
    if (!response.ok) {
      throw new ImageGenHttpError(response.status, await response.text())
    }
    const payload = (await response.json()) as ImagesApiPayload
    const entry = payload.data?.[0]
    if (entry?.b64_json) {
      return { data: Buffer.from(entry.b64_json, 'base64'), mimeType: 'image/png' }
    }
    if (entry?.url) {
      let download: Response
      try {
        download = await fetch(entry.url, { signal })
      } catch (error) {
        throw imageFetchFailure(entry.url, error, request)
      }
      if (!download.ok) throw new ImageGenHttpError(download.status, await download.text())
      const mimeType = download.headers.get('content-type')?.split(';')[0] || 'image/png'
      return { data: Buffer.from(await download.arrayBuffer()), mimeType }
    }
    throw new Error('image provider returned no image data')
  }
}

export class VolcengineArkImageClient implements ImageGenClient {
  readonly id = 'volcengine-ark-image'
  private readonly endpointUrl: string

  constructor(
    baseUrl: string,
    private readonly apiKey: string
  ) {
    this.endpointUrl = volcengineArkImageUrl(baseUrl)
  }

  generate(request: ImageGenRequest): Promise<GeneratedImage> {
    return this.requestImage(request)
  }

  edit(request: ImageGenEditRequest): Promise<GeneratedImage> {
    return this.requestImage(request, request.images)
  }

  private async requestImage(
    request: ImageGenRequest,
    images: ImageGenEditRequest['images'] = []
  ): Promise<GeneratedImage> {
    const signal = withTimeout(request.signal, request.timeoutMs)
    let response: Response
    try {
      response = await fetch(this.endpointUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: request.model,
          prompt: request.prompt,
          ...(images.length > 0 ? { image: images.map(imageDataUrl) } : {}),
          ...(request.size ? { size: request.size } : { size: '2K' }),
          output_format: 'png',
          response_format: 'b64_json',
          sequential_image_generation: 'disabled',
          stream: false,
          watermark: false
        }),
        signal
      })
    } catch (error) {
      throw imageFetchFailure(this.endpointUrl, error, request)
    }
    if (!response.ok) {
      throw new ImageGenHttpError(response.status, await response.text())
    }
    const payload = (await response.json()) as VolcengineArkImagesPayload
    const entry = payload.data?.[0]
    if (entry?.b64_json) {
      return { data: Buffer.from(entry.b64_json, 'base64'), mimeType: 'image/png' }
    }
    if (entry?.url) {
      let download: Response
      try {
        download = await fetch(entry.url, { signal })
      } catch (error) {
        throw imageFetchFailure(entry.url, error, request)
      }
      if (!download.ok) throw new ImageGenHttpError(download.status, await download.text())
      const mimeType = download.headers.get('content-type')?.split(';')[0] || 'image/png'
      return { data: Buffer.from(await download.arrayBuffer()), mimeType }
    }
    const detail = payload.error?.message?.trim() || payload.error?.code?.trim()
    throw new Error(detail
      ? `Volcano Ark image provider returned no image data: ${detail}`
      : 'Volcano Ark image provider returned no image data')
  }
}

export class GrokImagineImageClient implements ImageGenClient {
  readonly id = 'grok-imagine-image'
  private readonly endpointUrl: string

  constructor(
    baseUrl: string,
    private readonly apiKey: string,
    private readonly headers: Record<string, string> = {}
  ) {
    this.endpointUrl = openAiCompatImageUrl(baseUrl, 'generations')
  }

  async generate(request: ImageGenRequest): Promise<GeneratedImage> {
    const signal = withTimeout(request.signal, request.timeoutMs)
    let response: Response
    try {
      response = await fetch(this.endpointUrl, {
        method: 'POST',
        headers: {
          ...this.headers,
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: request.model,
          prompt: request.prompt,
          n: 1,
          aspect_ratio: request.aspectRatio ?? 'auto',
          resolution: grokImagineResolution(request.size),
          response_format: 'b64_json'
        }),
        signal
      })
    } catch (error) {
      throw imageFetchFailure(this.endpointUrl, error, request)
    }
    const text = await response.text()
    if (!response.ok) throw new ImageGenHttpError(response.status, text)
    let payload: ImagesApiPayload
    try {
      payload = JSON.parse(text) as ImagesApiPayload
    } catch {
      throw new Error('Grok Imagine image provider returned invalid JSON')
    }
    const b64 = payload.data?.[0]?.b64_json
    if (!b64) throw new Error('Grok Imagine image provider returned no image data')
    return { data: Buffer.from(b64, 'base64'), mimeType: 'image/jpeg' }
  }

  async edit(_request: ImageGenEditRequest): Promise<GeneratedImage> {
    throw new Error('Grok Imagine image editing is not supported by this tool')
  }
}

function grokImagineResolution(size: string | undefined): '1k' | '2k' {
  const longEdge = size ? parseSizeLongEdge(size) : undefined
  return longEdge && longEdge >= SIZE_TIERS['2K'] ? '2k' : '1k'
}

export class CodexResponsesImageClient implements ImageGenClient {
  readonly id = 'codex-responses-image'
  private readonly endpointUrl: string

  constructor(
    baseUrl: string,
    private readonly apiKey: string,
    private readonly headers: Record<string, string> = {}
  ) {
    this.endpointUrl = codexResponsesImageUrl(baseUrl)
  }

  async generate(request: ImageGenRequest): Promise<GeneratedImage> {
    return this.requestImage(request, [])
  }

  async edit(request: ImageGenEditRequest): Promise<GeneratedImage> {
    return this.requestImage(request, request.images)
  }

  private async requestImage(
    request: ImageGenRequest,
    inputImages: { name: string; mimeType: string; data: Buffer }[]
  ): Promise<GeneratedImage> {
    const signal = withTimeout(request.signal, request.timeoutMs)
    const shouldRequestInputFidelity = inputImages.length > 0 &&
      codexImageModelSupportsInputFidelity(request.model)
    const buildBody = (
      toolChoiceMode: CodexImageToolChoiceMode,
      includeInputFidelity: boolean
    ) => JSON.stringify({
      model: CODEX_IMAGE_RESPONSES_MODEL,
      input: [
        {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: request.prompt },
            ...inputImages.map((image) => ({
              type: 'input_image',
              image_url: imageDataUrl(image),
              detail: 'high'
            }))
          ]
        }
      ],
      instructions: CODEX_IMAGE_INSTRUCTIONS,
      tools: [
        {
          type: 'image_generation',
          action: inputImages.length > 0 ? 'edit' : 'generate',
          model: request.model,
          quality: request.quality ?? 'auto',
          output_format: 'png',
          background: 'opaque',
          partial_images: 1,
          ...(includeInputFidelity ? { input_fidelity: 'high' } : {}),
          ...(request.size ? { size: request.size } : {})
        }
      ],
      ...(toolChoiceMode === 'allowed_tools'
        ? {
            tool_choice: {
              type: 'allowed_tools',
              mode: 'required',
              tools: [{ type: 'image_generation' }]
            }
          }
        : toolChoiceMode === 'required'
          ? { tool_choice: 'required' }
          : {}),
      stream: true,
      store: false
    })

    let lastHttpError: ImageGenHttpError | null = null
    let lastEmptyResponse = ''
    let includeInputFidelity = shouldRequestInputFidelity
    let retriedWithoutInputFidelity = false
    const post = async (
      mode: CodexImageToolChoiceMode,
      withInputFidelity: boolean
    ): Promise<{ response: Response; text: string }> => {
      let response: Response
      try {
        response = await fetch(this.endpointUrl, {
          method: 'POST',
          headers: {
            ...this.headers,
            Authorization: `Bearer ${this.apiKey}`,
            Accept: 'text/event-stream',
            'Content-Type': 'application/json'
          },
          body: buildBody(mode, withInputFidelity),
          signal
        })
      } catch (error) {
        throw imageFetchFailure(this.endpointUrl, error, request)
      }
      return {
        response,
        text: await readLimitedResponseText(response, MAX_CODEX_IMAGE_SSE_BYTES)
      }
    }

    for (const mode of ['allowed_tools', 'required', 'none'] satisfies CodexImageToolChoiceMode[]) {
      let { response, text } = await post(mode, includeInputFidelity)
      if (
        !response.ok &&
        includeInputFidelity &&
        !retriedWithoutInputFidelity &&
        isCodexInputFidelityModelError(response.status, text)
      ) {
        // Retry immediately in the same tool-choice mode. Once the provider has
        // established that this routed model rejects the field, keep it omitted
        // from any later tool-choice compatibility attempts in this request.
        includeInputFidelity = false
        retriedWithoutInputFidelity = true
        ;({ response, text } = await post(mode, false))
      }
      if (!response.ok) {
        const error = new ImageGenHttpError(response.status, text)
        lastHttpError = error
        if (isCodexToolChoiceError(response.status, text)) continue
        throw error
      }
      const image = extractCodexResponsesImage(text)
      if (image) return image
      lastEmptyResponse = `Codex image provider returned no image data${summarizeCodexResponsesImage(text)}`
      if (mode !== 'none') continue
    }
    if (lastEmptyResponse) throw new Error(lastEmptyResponse)
    if (lastHttpError) throw lastHttpError
    throw new Error('Codex image provider returned no image data')
  }
}

export class MiniMaxImageClient implements ImageGenClient {
  readonly id = 'minimax-image'
  private readonly endpointUrl: string

  constructor(
    baseUrl: string,
    private readonly apiKey: string
  ) {
    this.endpointUrl = minimaxImageGenerationUrl(baseUrl)
  }

  async generate(request: ImageGenRequest): Promise<GeneratedImage> {
    return this.requestImage({
      model: request.model,
      prompt: request.prompt,
      ...minimaxImageDimensionFields(request.model, request.size),
      prompt_optimizer: true,
      response_format: 'base64',
      n: 1
    }, request)
  }

  async edit(request: ImageGenEditRequest): Promise<GeneratedImage> {
    return this.requestImage({
      model: request.model,
      prompt: request.prompt,
      ...minimaxImageDimensionFields(request.model, request.size),
      subject_reference: request.images.map((image) => ({
        type: 'character',
        image_file: `data:${image.mimeType};base64,${image.data.toString('base64')}`
      })),
      prompt_optimizer: true,
      response_format: 'base64',
      n: 1
    }, request)
  }

  private async requestImage(
    body: Record<string, unknown>,
    request: { timeoutMs: number; signal: AbortSignal }
  ): Promise<GeneratedImage> {
    const signal = withTimeout(request.signal, request.timeoutMs)
    let response: Response
    try {
      response = await fetch(this.endpointUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body),
        signal
      })
    } catch (error) {
      throw imageFetchFailure(this.endpointUrl, error, request)
    }
    const text = await response.text()
    if (!response.ok) throw new ImageGenHttpError(response.status, text)
    let payload: MiniMaxImagePayload
    try {
      payload = JSON.parse(text) as MiniMaxImagePayload
    } catch {
      throw new Error('MiniMax image provider returned invalid JSON')
    }
    const statusCode = payload.base_resp?.status_code
    if (typeof statusCode === 'number' && statusCode !== 0) {
      throw new Error(`MiniMax image provider failed (${statusCode}): ${payload.base_resp?.status_msg ?? 'unknown error'}`)
    }
    const b64 = payload.data?.image_base64?.[0]
    if (b64) {
      return { data: Buffer.from(b64, 'base64'), mimeType: 'image/jpeg' }
    }
    const imageUrl = payload.data?.image_urls?.[0]
    if (imageUrl) {
      let download: Response
      try {
        download = await fetch(imageUrl, { signal })
      } catch (error) {
        throw imageFetchFailure(imageUrl, error, request)
      }
      if (!download.ok) throw new ImageGenHttpError(download.status, await download.text())
      const mimeType = download.headers.get('content-type')?.split(';')[0] || 'image/jpeg'
      return { data: Buffer.from(await download.arrayBuffer()), mimeType }
    }
    throw new Error('MiniMax image provider returned no image data')
  }
}

function minimaxImageGenerationUrl(baseUrl: string): string {
  const normalized = trimTrailingSlashes(baseUrl.trim())
  const lower = normalized.toLowerCase()
  if (!normalized) return '/v1/image_generation'
  if (lower.endsWith('/v1/image_generation') || lower.endsWith('/image_generation')) return normalized
  if (lower.endsWith('/v1')) return `${normalized}/image_generation`
  return `${normalized}/v1/image_generation`
}

function trimTrailingSlashes(value: string): string {
  let end = value.length
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1
  return end === value.length ? value : value.slice(0, end)
}

function isVersionSegment(value: string): boolean {
  if (value.length < 2 || value[0] !== 'v') return false
  for (let index = 1; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 48 || code > 57) return false
  }
  return true
}

// aspect_ratio values both MiniMax image models accept (21:9 is image-01
// only, and image-01 receives explicit width/height instead).
const MINIMAX_ASPECT_RATIOS: Array<{ label: string; value: number }> = [
  { label: '1:1', value: 1 },
  { label: '16:9', value: 16 / 9 },
  { label: '4:3', value: 4 / 3 },
  { label: '3:2', value: 3 / 2 },
  { label: '2:3', value: 2 / 3 },
  { label: '3:4', value: 3 / 4 },
  { label: '9:16', value: 9 / 16 }
]

/**
 * MiniMax dimension fields for a `WxH` size. Per the t2i API docs only
 * image-01 accepts explicit width/height (range [512, 2048], multiples
 * of 8); image-01-live rejects them with status 2013, so every other model
 * gets the nearest supported aspect_ratio instead. Nearest (not exact)
 * because mapImageSize rounds edges to multiples of 8 — e.g. 3:2 at the 1K
 * tier becomes 1024x680.
 */
export function minimaxImageDimensionFields(
  model: string,
  size: string | undefined
): Record<string, unknown> {
  const match = size?.trim().match(/^(\d+)x(\d+)$/)
  if (!match) return {}
  const width = Number(match[1])
  const height = Number(match[2])
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return {}
  if (model.trim() === 'image-01') return { width, height }
  const target = width / height
  let best = MINIMAX_ASPECT_RATIOS[0]
  let bestDiff = Number.POSITIVE_INFINITY
  for (const candidate of MINIMAX_ASPECT_RATIOS) {
    const diff = Math.abs(Math.log(candidate.value / target))
    if (diff < bestDiff) {
      bestDiff = diff
      best = candidate
    }
  }
  return { aspect_ratio: best.label }
}

function withTimeout(signal: AbortSignal, timeoutMs: number): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
}

function telemetry(startedAt: number, provider: string): Record<string, unknown> {
  return { provider, durationMs: Date.now() - startedAt }
}

function toolError(code: string, message: string, toolTelemetry?: Record<string, unknown>): { output: unknown; isError: true } {
  return {
    output: {
      error: { code, message },
      ...(toolTelemetry ? { telemetry: toolTelemetry } : {})
    },
    isError: true
  }
}

function pickString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
