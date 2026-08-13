import { describe, expect, it } from 'vitest'
import {
  decryptBrowserUseActionEnvelope,
  encryptBrowserUseActionEnvelope
} from './browser-use-bridge-crypto.js'

const signingKey = 's'.repeat(43)
const payload = {
  bridgeToken: 'b'.repeat(43),
  request: {
    contractVersion: 2 as const,
    requestId: '00000000-0000-4000-8000-000000000001',
    threadId: 'thread-secret',
    turnId: 'turn-secret',
    action: { action: 'snapshot' as const }
  }
}

describe('Browser Use encrypted action envelope', () => {
  it('round-trips complete authority and request without plaintext disclosure', () => {
    const envelope = encryptBrowserUseActionEnvelope(payload, signingKey)

    expect(decryptBrowserUseActionEnvelope(envelope, signingKey)).toEqual(payload)
    expect(JSON.stringify(envelope)).not.toContain(payload.bridgeToken)
    expect(JSON.stringify(envelope)).not.toContain(payload.request.threadId)
    expect(JSON.stringify(envelope)).not.toContain('snapshot')
  })

  it('rejects ciphertext, tag, and key tampering with the same closed error', () => {
    const envelope = encryptBrowserUseActionEnvelope(payload, signingKey)
    const mutations = [
      { ...envelope, ciphertext: flipBase64UrlCharacter(envelope.ciphertext) },
      { ...envelope, authTag: flipBase64UrlCharacter(envelope.authTag) }
    ]
    for (const mutation of mutations) {
      expect(() => decryptBrowserUseActionEnvelope(mutation, signingKey))
        .toThrow('encrypted action envelope is invalid')
    }
    expect(() => decryptBrowserUseActionEnvelope(envelope, 'o'.repeat(43)))
      .toThrow('encrypted action envelope is invalid')
  })
})

function flipBase64UrlCharacter(value: string): string {
  const replacement = value.startsWith('A') ? 'B' : 'A'
  return `${replacement}${value.slice(1)}`
}
