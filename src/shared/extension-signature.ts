export const EXTENSION_SIGNATURE_PAYLOAD_VERSION = 1 as const
export const EXTENSION_SIGNATURE_ALGORITHM = 'ed25519' as const

export type ExtensionSignaturePayload = {
  payloadVersion: typeof EXTENSION_SIGNATURE_PAYLOAD_VERSION
  algorithm: typeof EXTENSION_SIGNATURE_ALGORITHM
  publisherId: string
  keyId: string
  extensionId: string
  extensionVersion: string
  packageSha256: string
  signedAt: string
  expiresAt: string
}

export type ExtensionPackageSignature = ExtensionSignaturePayload & {
  signatureBase64: string
}

export type ExtensionSignatureParseResult =
  | { success: true; data: ExtensionPackageSignature }
  | { success: false; error: string }

const SIGNATURE_FIELDS = new Set([
  'payloadVersion',
  'algorithm',
  'publisherId',
  'keyId',
  'extensionId',
  'extensionVersion',
  'packageSha256',
  'signedAt',
  'expiresAt',
  'signatureBase64'
])
const PUBLISHER_ID = /^[a-z0-9][a-z0-9-]{0,63}$/
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const EXTENSION_ID = /^[a-z0-9][a-z0-9-]{0,63}\.[a-z][a-z0-9-]{0,63}$/
const MAX_EXTENSION_VERSION_LENGTH = 128
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/
const SHA256_HEX = /^[a-f0-9]{64}$/
const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
// Ed25519 signatures are exactly 64 bytes. The last Base64 character is
// restricted to canonical zero pad bits rather than accepting aliases.
const ED25519_SIGNATURE_BASE64 = /^(?:[A-Za-z0-9+/]{4}){21}[A-Za-z0-9+/][AQgw]==$/

/**
 * Parses untrusted signature metadata. Trust lookup and cryptographic
 * verification remain responsibilities of the extension installation layer.
 */
export function parseExtensionPackageSignature(input: unknown): ExtensionSignatureParseResult {
  try {
    if (!isRecord(input)) throw new TypeError('extension signature must be an object')
    const unknownFields = Object.keys(input).filter((field) => !SIGNATURE_FIELDS.has(field))
    if (unknownFields.length > 0 || Object.keys(input).length !== SIGNATURE_FIELDS.size) {
      throw new TypeError('extension signature fields do not match payload version 1')
    }

    const payload = parsePayload(input)
    const signatureBase64 = stringMatching(
      input.signatureBase64,
      ED25519_SIGNATURE_BASE64,
      'signatureBase64 must be a canonical 64-byte Ed25519 signature'
    )

    return { success: true, data: { ...payload, signatureBase64 } }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'invalid extension package signature'
    }
  }
}

/**
 * Returns the exact UTF-8 JSON text covered by the Ed25519 signature. Field
 * order is part of payload version 1 and must not be changed in place.
 */
export function buildExtensionSignaturePayload(input: ExtensionSignaturePayload): string {
  const payload = parsePayload(input as unknown as Record<string, unknown>)
  return JSON.stringify({
    payloadVersion: payload.payloadVersion,
    algorithm: payload.algorithm,
    publisherId: payload.publisherId,
    keyId: payload.keyId,
    extensionId: payload.extensionId,
    extensionVersion: payload.extensionVersion,
    packageSha256: payload.packageSha256,
    signedAt: payload.signedAt,
    expiresAt: payload.expiresAt
  })
}

export function isExtensionSignatureCurrent(
  signature: ExtensionSignaturePayload,
  now: Date | number = Date.now()
): boolean {
  const timestamp = now instanceof Date ? now.getTime() : now
  const signedAt = Date.parse(signature.signedAt)
  const expiresAt = Date.parse(signature.expiresAt)
  return Number.isFinite(timestamp) &&
    Number.isFinite(signedAt) &&
    Number.isFinite(expiresAt) &&
    timestamp >= signedAt &&
    timestamp < expiresAt
}

function parsePayload(record: Record<string, unknown>): ExtensionSignaturePayload {
  if (record.payloadVersion !== EXTENSION_SIGNATURE_PAYLOAD_VERSION) {
    throw new TypeError('unsupported extension signature payload version')
  }
  if (record.algorithm !== EXTENSION_SIGNATURE_ALGORITHM) {
    throw new TypeError('unsupported extension signature algorithm')
  }

  const publisherId = stringMatching(record.publisherId, PUBLISHER_ID, 'publisherId is invalid')
  const keyId = stringMatching(record.keyId, KEY_ID, 'keyId is invalid')
  const extensionId = stringMatching(record.extensionId, EXTENSION_ID, 'extensionId is invalid')
  if (!extensionId.startsWith(`${publisherId}.`)) {
    throw new TypeError('extensionId publisher does not match publisherId')
  }
  const extensionVersion = stringMatching(
    record.extensionVersion,
    SEMVER,
    'extensionVersion must be valid SemVer',
    MAX_EXTENSION_VERSION_LENGTH
  )
  const packageSha256 = stringMatching(
    record.packageSha256,
    SHA256_HEX,
    'packageSha256 must be a lowercase SHA-256 digest'
  )
  const signedAt = parseCanonicalTimestamp(record.signedAt, 'signedAt')
  const expiresAt = parseCanonicalTimestamp(record.expiresAt, 'expiresAt')
  if (Date.parse(expiresAt) <= Date.parse(signedAt)) {
    throw new TypeError('expiresAt must be later than signedAt')
  }

  return {
    payloadVersion: EXTENSION_SIGNATURE_PAYLOAD_VERSION,
    algorithm: EXTENSION_SIGNATURE_ALGORITHM,
    publisherId,
    keyId,
    extensionId,
    extensionVersion,
    packageSha256,
    signedAt,
    expiresAt
  }
}

function parseCanonicalTimestamp(value: unknown, field: string): string {
  const timestamp = stringMatching(value, CANONICAL_TIMESTAMP, `${field} must be a canonical UTC timestamp`)
  const milliseconds = Date.parse(timestamp)
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== timestamp) {
    throw new TypeError(`${field} must be a canonical UTC timestamp`)
  }
  return timestamp
}

function stringMatching(value: unknown, pattern: RegExp, error: string, maxLength = Number.POSITIVE_INFINITY): string {
  if (typeof value !== 'string' || value.length > maxLength || !pattern.test(value)) throw new TypeError(error)
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
