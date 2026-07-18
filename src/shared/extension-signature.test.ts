import { describe, expect, it } from 'vitest'
import {
  buildExtensionSignaturePayload,
  isExtensionSignatureCurrent,
  parseExtensionPackageSignature,
  type ExtensionPackageSignature
} from './extension-signature'

const valid: ExtensionPackageSignature = {
  payloadVersion: 1,
  algorithm: 'ed25519',
  publisherId: 'acme',
  keyId: 'release-2026.07',
  extensionId: 'acme.demo',
  extensionVersion: '1.2.3',
  packageSha256: 'a'.repeat(64),
  signedAt: '2026-07-01T00:00:00.000Z',
  expiresAt: '2026-08-01T00:00:00.000Z',
  signatureBase64: `${'A'.repeat(86)}==`
}

describe('extension package signature contract', () => {
  it('accepts the exact bounded payload version 1 envelope', () => {
    expect(parseExtensionPackageSignature(valid)).toEqual({ success: true, data: valid })
  })

  it('rejects unknown, missing, and self-asserted key material fields', () => {
    const { keyId: _keyId, ...missingKeyId } = valid
    expect(parseExtensionPackageSignature({ ...valid, unexpected: true }).success).toBe(false)
    expect(parseExtensionPackageSignature(missingKeyId).success).toBe(false)
    expect(parseExtensionPackageSignature({ ...valid, publicKeyBase64: 'attacker-key' }).success).toBe(false)
  })

  it('rejects unsupported algorithms, versions, and non-canonical cryptographic values', () => {
    expect(parseExtensionPackageSignature({ ...valid, payloadVersion: 2 }).success).toBe(false)
    expect(parseExtensionPackageSignature({ ...valid, algorithm: 'rsa-pss' }).success).toBe(false)
    expect(parseExtensionPackageSignature({ ...valid, packageSha256: 'A'.repeat(64) }).success).toBe(false)
    expect(parseExtensionPackageSignature({ ...valid, signatureBase64: `${'A'.repeat(85)}B==` }).success).toBe(false)
    expect(parseExtensionPackageSignature({ ...valid, signatureBase64: 'not-base64' }).success).toBe(false)
    expect(parseExtensionPackageSignature({
      ...valid,
      extensionVersion: `${'1'.repeat(125)}.0.0`
    }).success).toBe(false)
  })

  it('binds the publisher identity and canonical validity window', () => {
    expect(parseExtensionPackageSignature({ ...valid, publisherId: 'other' }).success).toBe(false)
    expect(parseExtensionPackageSignature({ ...valid, signedAt: '2026-07-01T00:00:00Z' }).success).toBe(false)
    expect(parseExtensionPackageSignature({ ...valid, signedAt: '2026-02-30T00:00:00.000Z' }).success).toBe(false)
    expect(parseExtensionPackageSignature({ ...valid, expiresAt: valid.signedAt }).success).toBe(false)
  })
})

describe('buildExtensionSignaturePayload', () => {
  it('emits a deterministic golden payload with every security identity field', () => {
    const { signatureBase64: _signatureBase64, ...payload } = valid
    expect(buildExtensionSignaturePayload(payload)).toBe(
      `{"payloadVersion":1,"algorithm":"ed25519","publisherId":"acme","keyId":"release-2026.07",` +
      `"extensionId":"acme.demo","extensionVersion":"1.2.3","packageSha256":"${'a'.repeat(64)}",` +
      `"signedAt":"2026-07-01T00:00:00.000Z","expiresAt":"2026-08-01T00:00:00.000Z"}`
    )
  })

  it.each([
    ['publisherId', 'other'],
    ['keyId', 'release-2026.08'],
    ['extensionId', 'acme.other'],
    ['extensionVersion', '1.2.4'],
    ['packageSha256', 'b'.repeat(64)],
    ['signedAt', '2026-07-02T00:00:00.000Z'],
    ['expiresAt', '2026-08-02T00:00:00.000Z']
  ] as const)('changes the signed bytes when %s changes', (field, value) => {
    const { signatureBase64: _signatureBase64, ...payload } = valid
    const baseline = buildExtensionSignaturePayload(payload)
    const changed = { ...payload, [field]: value }
    if (field === 'publisherId') changed.extensionId = `${value}.demo`

    expect(buildExtensionSignaturePayload(changed)).not.toBe(baseline)
  })
})

describe('isExtensionSignatureCurrent', () => {
  it('uses a half-open deterministic validity window and fails closed for invalid clocks', () => {
    expect(isExtensionSignatureCurrent(valid, Date.parse(valid.signedAt))).toBe(true)
    expect(isExtensionSignatureCurrent(valid, Date.parse(valid.expiresAt) - 1)).toBe(true)
    expect(isExtensionSignatureCurrent(valid, Date.parse(valid.expiresAt))).toBe(false)
    expect(isExtensionSignatureCurrent(valid, Date.parse(valid.signedAt) - 1)).toBe(false)
    expect(isExtensionSignatureCurrent(valid, Number.NaN)).toBe(false)
  })
})
