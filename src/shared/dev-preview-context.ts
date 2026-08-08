import { normalizeDevPreviewUrlInput } from './dev-preview-url'

export const MAX_DEV_PREVIEW_ELEMENTS = 4
export const MAX_DEV_PREVIEW_ISSUES = 50

export type DevPreviewRect = { x: number; y: number; width: number; height: number }
export type DevPreviewViewport = { width: number; height: number }

export type DevPreviewElementContext = {
  kind: 'element'
  url: string
  tag: string
  selector: string
  text: string
  attributes: Record<string, string>
  styles: Record<string, string>
  rect: DevPreviewRect
  viewport: DevPreviewViewport
}

export type DevPreviewIssue = {
  id: string
  kind: 'console' | 'load'
  message: string
  source?: string
  line?: number
  count: number
  createdAt: number
}

const ALLOWED_ATTRIBUTES = new Set([
  'id', 'class', 'role', 'aria-label', 'aria-labelledby', 'aria-describedby', 'name', 'title',
  'alt', 'href', 'src', 'type', 'data-testid'
])
const ALLOWED_STYLES = new Set([
  'display', 'position', 'color', 'background-color', 'font-family', 'font-size', 'font-weight',
  'line-height', 'text-align', 'border-radius', 'opacity', 'overflow'
])

function boundedString(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : ''
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function normalizeRect(value: unknown): DevPreviewRect | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const x = finiteNumber(raw.x)
  const y = finiteNumber(raw.y)
  const width = finiteNumber(raw.width)
  const height = finiteNumber(raw.height)
  if (x == null || y == null || width == null || height == null || width <= 0 || height <= 0) return null
  if (width > 16_384 || height > 16_384 || Math.abs(x) > 1_000_000 || Math.abs(y) > 1_000_000) return null
  return { x, y, width, height }
}

function normalizeViewport(value: unknown): DevPreviewViewport | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const width = finiteNumber(raw.width)
  const height = finiteNumber(raw.height)
  if (width == null || height == null || width <= 0 || height <= 0 || width > 16_384 || height > 16_384) return null
  return { width, height }
}

function normalizeRecord(
  value: unknown,
  allowed: ReadonlySet<string>,
  maxValue: number
): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const result: Record<string, string> = {}
  for (const [rawKey, rawValue] of Object.entries(value as Record<string, unknown>)) {
    const key = rawKey.toLowerCase()
    if (!allowed.has(key) || key.startsWith('on') || key === 'value') continue
    const normalized = boundedString(rawValue, maxValue)
    if (normalized) result[key] = normalized
  }
  return result
}

export function normalizeDevPreviewElementContext(value: unknown): DevPreviewElementContext | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  if (raw.crossOriginFrame === true || raw.sensitive === true) return null
  const url = typeof raw.url === 'string' ? normalizeDevPreviewUrlInput(raw.url) : null
  const tag = boundedString(raw.tag, 32).toLowerCase()
  const selector = boundedString(raw.selector, 512)
  const rect = normalizeRect(raw.rect)
  const viewport = normalizeViewport(raw.viewport)
  const type = boundedString((raw.attributes as Record<string, unknown> | undefined)?.type, 32).toLowerCase()
  if (!url || !tag || !selector || !rect || !viewport) return null
  if (tag === 'script' || tag === 'style' || tag === 'noscript') return null
  if (tag === 'input' && (type === 'password' || type === 'hidden' || type === 'file')) return null
  return {
    kind: 'element',
    url,
    tag,
    selector,
    text: boundedString(raw.text, 1_024),
    attributes: normalizeRecord(raw.attributes, ALLOWED_ATTRIBUTES, 512),
    styles: normalizeRecord(raw.styles, ALLOWED_STYLES, 128),
    rect,
    viewport
  }
}

function issueKey(input: Pick<DevPreviewIssue, 'kind' | 'message' | 'source' | 'line'>): string {
  return [input.kind, input.message.toLowerCase(), input.source ?? '', input.line ?? 0].join('|')
}

export function createDevPreviewIssue(input: {
  kind: 'console' | 'load'
  message: unknown
  source?: unknown
  line?: unknown
  createdAt?: number
}): DevPreviewIssue | null {
  const message = boundedString(input.message, 2_048)
  if (!message) return null
  const source = boundedString(input.source, 512)
  const line = finiteNumber(input.line)
  const key = issueKey({ kind: input.kind, message, ...(source ? { source } : {}), ...(line != null ? { line } : {}) })
  let hash = 2166136261
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return {
    id: `preview-issue:${(hash >>> 0).toString(16).padStart(8, '0')}`,
    kind: input.kind,
    message,
    ...(source ? { source } : {}),
    ...(line != null && line >= 0 ? { line: Math.floor(line) } : {}),
    count: 1,
    createdAt: input.createdAt ?? Date.now()
  }
}

export function appendDevPreviewIssue(
  issues: readonly DevPreviewIssue[],
  next: DevPreviewIssue | null
): DevPreviewIssue[] {
  if (!next) return [...issues]
  const index = issues.findIndex((issue) => issueKey(issue) === issueKey(next))
  if (index >= 0) {
    return issues.map((issue, candidateIndex) => candidateIndex === index
      ? { ...issue, count: Math.min(9_999, issue.count + 1), createdAt: next.createdAt }
      : issue)
  }
  return [...issues, next].slice(-MAX_DEV_PREVIEW_ISSUES)
}

export function paddedDevPreviewCaptureRect(
  rect: DevPreviewRect,
  viewport: DevPreviewViewport,
  padding = 32
): DevPreviewRect {
  const x = Math.max(0, rect.x - padding)
  const y = Math.max(0, rect.y - padding)
  const right = Math.min(viewport.width, rect.x + rect.width + padding)
  const bottom = Math.min(viewport.height, rect.y + rect.height + padding)
  return { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) }
}

