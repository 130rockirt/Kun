import { StringDecoder } from 'node:string_decoder'
import {
  MODEL_REQUEST_TRACE_REDACTED_VALUE,
  type ModelRequestTraceBody,
  type ModelRequestTraceHeaders
} from '../contracts/model-request-trace.js'

const SECRET_HEADER_NAME = /(?:^|[-_])(?:api[-_]?key|authorization|bearer|client[-_]?secret|password|passphrase|secret|token|credential|cookie|signature)(?:$|[-_])/i
const SECRET_QUERY_NAME = /(?:key|token|secret|signature|auth|password|credential|cookie)/i

export type SanitizedTraceUrl = { value: string; redacted: boolean }

/**
 * Strip userinfo and redact sensitive query values before a model endpoint is
 * allowed into trace memory. Invalid URLs fail closed because their authority
 * and query boundaries cannot be trusted.
 */
export function sanitizeModelTraceUrl(value: string): SanitizedTraceUrl {
  const trimmed = value.trim()
  if (!trimmed) return { value: '', redacted: false }
  try {
    const url = new URL(trimmed)
    let redacted = Boolean(url.username || url.password)
    url.username = ''
    url.password = ''
    for (const name of [...url.searchParams.keys()]) {
      if (!SECRET_QUERY_NAME.test(name)) continue
      if (url.searchParams.get(name) !== MODEL_REQUEST_TRACE_REDACTED_VALUE) redacted = true
      url.searchParams.set(name, MODEL_REQUEST_TRACE_REDACTED_VALUE)
    }
    return { value: url.toString(), redacted }
  } catch {
    return { value: '[INVALID URL]', redacted: true }
  }
}

/** Redact header values before they enter recorder state. */
export function sanitizeModelTraceHeaders(
  input: Headers | Record<string, string>,
  secretValues: readonly string[] = []
): ModelRequestTraceHeaders {
  const entries = input instanceof Headers ? [...input.entries()] : Object.entries(input)
  const normalizedSecrets = secretValues.map((value) => value.trim()).filter(Boolean)
  const values: Record<string, string> = {}
  const redactedNames: string[] = []
  for (const [rawName, rawValue] of entries) {
    const name = rawName.trim()
    if (!name) continue
    const value = String(rawValue)
    const sensitiveValue = normalizedSecrets.some((secret) => value.includes(secret))
    if (SECRET_HEADER_NAME.test(name) || sensitiveValue) {
      values[name] = MODEL_REQUEST_TRACE_REDACTED_VALUE
      redactedNames.push(name)
    } else {
      values[name] = value
    }
  }
  redactedNames.sort((left, right) => left.localeCompare(right))
  return { values, redactedNames }
}

export function boundedModelTraceText(value: string, maxBytes: number): ModelRequestTraceBody {
  const bytes = Buffer.from(value, 'utf8')
  const limit = normalizeByteLimit(maxBytes)
  if (bytes.byteLength <= limit) {
    return { text: value, capturedBytes: bytes.byteLength, originalBytes: bytes.byteLength, truncated: false }
  }
  const decoder = new StringDecoder('utf8')
  const text = decoder.write(bytes.subarray(0, limit))
  return {
    text,
    capturedBytes: Buffer.byteLength(text, 'utf8'),
    originalBytes: bytes.byteLength,
    truncated: true
  }
}

/**
 * Remove model-only context before a request body reaches the retained trace.
 * Wire bodies are normally JSON, so redact decoded string values rather than
 * relying on the escaped newline spelling in JSON.stringify output. The
 * exact-value fallback also covers non-JSON CLI payloads.
 */
export function redactModelTraceValues(
  value: string,
  redactedValues: readonly string[]
): string {
  const values = [...new Set(redactedValues.filter((candidate) => candidate.length > 0))]
    .sort((left, right) => right.length - left.length)
  if (values.length === 0) return value
  const redactText = (text: string): string => values.reduce(
    (next, candidate) => next.replaceAll(candidate, MODEL_REQUEST_TRACE_REDACTED_VALUE),
    text
  )
  try {
    return JSON.stringify(redactTraceValue(JSON.parse(value), redactText))
  } catch {
    return redactText(value)
  }
}

function redactTraceValue(value: unknown, redactText: (text: string) => string): unknown {
  if (typeof value === 'string') return redactText(value)
  if (Array.isArray(value)) return value.map((entry) => redactTraceValue(entry, redactText))
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      redactTraceValue(entry, redactText)
    ])
  )
}

/** Incremental response accumulator that bounds retained bytes while counting the full clone. */
export class BoundedModelTraceBodyAccumulator {
  private readonly retained: Buffer[] = []
  private retainedBytes = 0
  private originalBytes = 0

  constructor(private readonly maxBytes: number) {}

  append(value: Uint8Array): void {
    this.originalBytes += value.byteLength
    const available = Math.max(0, normalizeByteLimit(this.maxBytes) - this.retainedBytes)
    if (available <= 0) return
    const slice = Buffer.from(value.subarray(0, available))
    this.retained.push(slice)
    this.retainedBytes += slice.byteLength
  }

  finish(): ModelRequestTraceBody {
    const decoder = new StringDecoder('utf8')
    const text = decoder.write(Buffer.concat(this.retained))
    const capturedBytes = Buffer.byteLength(text, 'utf8')
    return {
      text,
      capturedBytes,
      originalBytes: this.originalBytes,
      truncated: this.originalBytes > capturedBytes
    }
  }
}

function normalizeByteLimit(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
}
