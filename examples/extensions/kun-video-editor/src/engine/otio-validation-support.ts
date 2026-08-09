import { createHash } from 'node:crypto'
import { engineError } from './errors.js'
import {
  VideoProjectSchema,
  validateProjectRoundTrip,
  type Caption,
  type EffectInstance,
  type KeyframeTrack,
  type Rational,
  type Sequence,
  type TimelineItem,
  type Track,
  type VideoProject
} from './schema.js'
import { framesToMicroseconds, microsecondsToFrames, rescaleFrames } from './time.js'
import { containsNullOrLineBreak, replaceNullOrLineBreaks } from '../text-safety.js'
import {
  OTIO_ADAPTER_ID,
  OTIO_ADAPTER_VERSION,
  OTIO_LIMITS,
  type InterchangeLossEntry,
  type InterchangeLossManifest
} from './otio-interchange.js'
import { visit } from './otio-export-support.js'

export type LossCollector = {
  entries: InterchangeLossEntry[]
  truncated: number
  keys: Set<string>
}

export function parseLossManifest(value: unknown): InterchangeLossManifest {
  const manifest = record(value, 'lossManifest')
  if (manifest.adapterId !== OTIO_ADAPTER_ID || manifest.adapterVersion !== OTIO_ADAPTER_VERSION) {
    invalid('OTIO loss manifest adapter identity is invalid')
  }
  if (typeof manifest.portableLossless !== 'boolean' || typeof manifest.kunRoundTripLossless !== 'boolean') {
    invalid('OTIO loss manifest flags are invalid')
  }
  if (!Array.isArray(manifest.entries) || manifest.entries.length > OTIO_LIMITS.lossEntries) {
    invalid('OTIO loss manifest entries exceed their bound')
  }
  if (!Number.isSafeInteger(manifest.truncated) || Number(manifest.truncated) < 0) invalid('OTIO loss manifest truncation is invalid')
  return structuredClone(manifest) as InterchangeLossManifest
}

export function lossCollector(): LossCollector {
  return { entries: [], truncated: 0, keys: new Set() }
}

export function addLoss(collector: LossCollector, entry: InterchangeLossEntry): void {
  const key = `${entry.code}:${entry.nodeId}`
  if (collector.keys.has(key)) return
  collector.keys.add(key)
  if (collector.entries.length >= OTIO_LIMITS.lossEntries) {
    collector.truncated += 1
    return
  }
  collector.entries.push(entry)
}

export function metadataLoss(
  code: string,
  feature: string,
  nodeId: string,
  message: string
): InterchangeLossEntry {
  return { code, severity: 'warning', feature, nodeId, preservation: 'kun-metadata', message }
}

export function lossManifest(
  collector: LossCollector,
  kunRoundTripLossless = true
): InterchangeLossManifest {
  const entries = collector.entries.slice().sort((left, right) =>
    left.code.localeCompare(right.code) || left.nodeId.localeCompare(right.nodeId))
  return {
    adapterId: OTIO_ADAPTER_ID,
    adapterVersion: OTIO_ADAPTER_VERSION,
    portableLossless: entries.every(({ severity }) => severity === 'info') && collector.truncated === 0,
    kunRoundTripLossless,
    entries,
    truncated: collector.truncated
  }
}

export function assertDocumentBounds(document: Record<string, unknown>): void {
  if (document.OTIO_SCHEMA !== 'SerializableCollection.1') invalid('OTIO root schema is invalid')
  visit(document, () => undefined)
  const bytes = Buffer.byteLength(stableStringify(document), 'utf8')
  if (bytes > OTIO_LIMITS.documentBytes) invalid('OTIO document exceeds its byte limit')
}

export function canonicalDigest(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex')
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortJson(value))
}

export function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortJson(entry)]))
  }
  return value
}

export function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${label} must be an object`)
  return value as Record<string, unknown>
}

export function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

export function stringValue(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum || containsNullOrLineBreak(value)) {
    invalid(`${label} must be a bounded string`)
  }
  return value
}

export function invalid(message: string): never {
  throw engineError('render_unsupported', message)
}
