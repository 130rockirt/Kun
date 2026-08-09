import { stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import * as yauzl from 'yauzl'
import {
  createPptReviewManifest,
  pptReviewPromptHash
} from '../../ppt/ppt-review-manifest.js'

export const MAX_EXPORT_OUTPUT_CHARS = 16_000
const MAX_PPTX_BYTES = 500 * 1024 * 1024
const MAX_SLIDE_XML_BYTES = 8 * 1024 * 1024

export type PptAgentLocalToolOptions = {
  enabled?: () => boolean
  toolchainDirectory?: () => string | undefined
}

export type ReviewBundleSlideInput = {
  slideId?: string
  title: string
  prompt: string
  imagePath?: string
  error?: string
}

export function parseReviewSlides(value: unknown): ReviewBundleSlideInput[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return []
    const slide = entry as Record<string, unknown>
    const title = stringArg(slide.title)
    const prompt = stringArg(slide.prompt)
    const imagePath = stringArg(slide.imagePath)
    const error = stringArg(slide.error)
    const slideId = stringArg(slide.slideId)
    if (!title || !prompt || Boolean(imagePath) === Boolean(error)) return []
    return [{ title, prompt, ...(imagePath ? { imagePath } : { error }), ...(slideId ? { slideId } : {}) }]
  })
}

export function reviewSlideRevision(
  slide: ReturnType<typeof createPptReviewManifest>['slides'][number],
  update: ReviewBundleSlideInput,
  styleSpec?: ReturnType<typeof createPptReviewManifest>['styleSpec']
): ReturnType<typeof createPptReviewManifest>['slides'][number] {
  const { previewPath: _previewPath, lastError: _lastError, ...base } = slide
  return {
    ...base,
    title: update.title,
    ...(update.imagePath ? { previewPath: update.imagePath } : {}),
    revision: slide.revision + 1,
    status: update.imagePath ? 'ready' : 'failed',
    attempts: slide.attempts + 1,
    ...(styleSpec ? { promptHash: pptReviewPromptHash(styleSpec, update.prompt) } : {}),
    ...(update.error ? { lastError: update.error } : {})
  }
}

type PreviewRendererOutput = {
  overview: string
  images: Array<{ image: string; page?: string }>
  exporter?: string
}

export function parsePreviewRendererOutput(value: string): PreviewRendererOutput {
  const start = value.indexOf('{')
  if (start < 0) throw new Error('preview renderer did not return a JSON summary')
  const parsed = JSON.parse(value.slice(start)) as Record<string, unknown>
  if (typeof parsed.overview !== 'string' || !Array.isArray(parsed.images)) {
    throw new Error('preview renderer returned an invalid summary')
  }
  const images = parsed.images.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return []
    const image = (entry as { image?: unknown }).image
    const page = (entry as { page?: unknown }).page
    return typeof image === 'string' && image.trim()
      ? [{ image, ...(typeof page === 'string' && page.trim() ? { page } : {}) }]
      : []
  })
  return {
    overview: parsed.overview,
    images,
    ...(typeof parsed.exporter === 'string' ? { exporter: parsed.exporter } : {})
  }
}

export async function validatePptx(
  path: string,
  transition: 'fade' | 'none'
): Promise<{ slides: number; editableSlides: number; fadeTransitions: number; bytes: number }> {
  const info = await stat(path)
  if (!info.isFile() || info.size <= 0 || info.size > MAX_PPTX_BYTES) {
    throw new Error(`exported PPTX has an invalid size: ${info.size}`)
  }
  let archive: yauzl.ZipFile | undefined
  let hasContentTypes = false
  let hasPresentation = false
  let slides = 0
  let editableSlides = 0
  let fadeTransitions = 0
  try {
    archive = await yauzl.openPromise(path, {
      lazyEntries: true,
      decodeStrings: true,
      validateEntrySizes: true,
      strictFileNames: true,
      autoClose: false
    })
    for await (const entry of archive.eachEntry()) {
      if (entry.fileName === '[Content_Types].xml') hasContentTypes = true
      if (entry.fileName === 'ppt/presentation.xml') hasPresentation = true
      if (!/^ppt\/slides\/slide\d+\.xml$/.test(entry.fileName)) continue
      slides += 1
      if (entry.uncompressedSize > MAX_SLIDE_XML_BYTES) {
        throw new Error(`slide XML is unexpectedly large: ${entry.fileName}`)
      }
      const stream = await archive.openReadStreamPromise(entry)
      const chunks: Buffer[] = []
      for await (const chunk of stream) chunks.push(Buffer.from(chunk))
      const xml = Buffer.concat(chunks).toString('utf8')
      if (/<p:transition\b[^>]*>[\s\S]*?<p:fade\b/.test(xml)) fadeTransitions += 1
      if (/<p:(?:sp|graphicFrame|cxnSp)\b/.test(xml)) {
        editableSlides += 1
      } else if (/<p:pic\b/.test(xml)) {
        throw new Error(`editable deck verification failed: ${entry.fileName} contains only raster image content`)
      } else {
        throw new Error(`editable deck verification failed: ${entry.fileName} has no native text, shape, or chart content`)
      }
    }
  } finally {
    archive?.close()
  }
  if (!hasContentTypes || !hasPresentation || slides === 0) {
    throw new Error('exported file is not a valid PPTX presentation package')
  }
  if (transition === 'fade' && fadeTransitions !== slides) {
    throw new Error(`fade transition verification failed: ${fadeTransitions}/${slides} slides`)
  }
  return { slides, editableSlides, fadeTransitions, bytes: info.size }
}

export async function requireToolchainDirectory(options: PptAgentLocalToolOptions): Promise<string> {
  const candidates = [
    options.toolchainDirectory?.()?.trim(),
    process.env.KUN_PPT_TOOLCHAIN_DIR?.trim(),
    resolve(process.cwd(), 'resources', 'ppt-toolchain')
  ].filter((candidate): candidate is string => Boolean(candidate))
  for (const candidate of candidates) {
    try {
      const info = await stat(candidate)
      if (info.isDirectory()) return resolve(candidate)
    } catch {
      // Try the next trusted runtime location.
    }
  }
  throw new Error('Kun PPT toolchain is unavailable; reinstall or repair the Kun application')
}

export function isInside(root: string, target: string): boolean {
  const path = relative(root, target)
  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}

export function stringArg(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function integerArg(
  value: unknown,
  min: number,
  max: number,
  fallback: number
): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
    ? value
    : fallback
}

export function truncate(value: string): string {
  if (value.length <= MAX_EXPORT_OUTPUT_CHARS) return value
  return `${value.slice(0, MAX_EXPORT_OUTPUT_CHARS)}\n…[truncated]`
}
