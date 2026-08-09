import { createHash } from 'node:crypto'

const RAW_ARGUMENT_KEY = '__raw'

/**
 * Keep raw-envelope parsing below the dispatch repair's normal string budget.
 * Larger values remain opaque so normalization cannot turn a bounded transport
 * fallback into an unexpectedly expensive JSON parse.
 */
export const MAX_RAW_TOOL_ARGUMENT_ENVELOPE_BYTES = 512 * 1024

/**
 * Fields added by model/provider transports around a tool argument payload.
 * These fields are not tool business arguments and are discarded when a
 * complete `__raw` JSON object is recovered.
 */
const TOOL_ARGUMENT_TRANSPORT_METADATA_KEYS = new Set([
  'toolName',
  'tool_name',
  'callId',
  'call_id',
  'providerId',
  'provider_id',
  'providerKind',
  'provider_kind',
  'toolKind',
  'tool_kind'
])

/**
 * Whether the record is a transport-only `__raw` envelope. This intentionally
 * examines keys only: callers can classify an unresolved envelope without
 * reading, returning, or logging the raw payload.
 */
export function isUnresolvedRawToolArgumentsEnvelope(
  args: Record<string, unknown>
): boolean {
  if (!Object.prototype.hasOwnProperty.call(args, RAW_ARGUMENT_KEY)) return false
  return Object.keys(args).every((key) => (
    key === RAW_ARGUMENT_KEY || TOOL_ARGUMENT_TRANSPORT_METADATA_KEYS.has(key)
  ))
}

/**
 * Recover a provider-supplied `__raw` argument envelope only when it contains
 * one complete JSON object and no outer business arguments. Truncated JSON,
 * arrays, scalars, oversized strings, and conflicting envelopes are returned
 * unchanged. Returning the original object on the unchanged path also makes
 * successful normalization observable without exposing the raw string.
 */
export function normalizeRawToolArgumentsEnvelope(
  args: Record<string, unknown>
): Record<string, unknown> {
  let current = args
  while (isUnresolvedRawToolArgumentsEnvelope(current)) {
    const raw = current[RAW_ARGUMENT_KEY]
    if (typeof raw !== 'string') return current
    if (Buffer.byteLength(raw, 'utf8') > MAX_RAW_TOOL_ARGUMENT_ENVELOPE_BYTES) return current

    try {
      const parsed: unknown = JSON.parse(raw)
      if (!isJsonObject(parsed)) return current
      current = parsed
    } catch {
      return current
    }
  }
  return current
}

/**
 * Canonicalize complete transport envelopes and omit any remaining raw string
 * from durable arguments, returning only a bounded, non-reversible summary.
 * Execution keeps using the original arguments; this projection is for
 * history, events, and diagnostics only.
 */
export function projectToolArgumentsForPersistence(
  args: Record<string, unknown>
): {
  arguments: Record<string, unknown>
  rawSummary?: string
} {
  const normalized = normalizeRawToolArgumentsEnvelope(args)
  const raw = normalized[RAW_ARGUMENT_KEY]
  if (typeof raw !== 'string') return { arguments: normalized }
  const { [RAW_ARGUMENT_KEY]: _omitted, ...argumentsWithoutRaw } = normalized
  const utf8Bytes = Buffer.byteLength(raw, 'utf8')
  const sha256 = createHash('sha256').update(raw).digest('hex')
  return {
    arguments: isUnresolvedRawToolArgumentsEnvelope(normalized) ? {} : argumentsWithoutRaw,
    rawSummary: `Incomplete tool arguments omitted (${utf8Bytes} UTF-8 bytes; sha256 ${sha256}).`
  }
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
