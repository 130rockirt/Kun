import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes
} from 'node:crypto'
import { z } from 'zod'
import {
  BROWSER_USE_BRIDGE_CONTRACT_VERSION,
  BrowserUseEncryptedActionEnvelope,
  type BrowserUseEncryptedActionEnvelope as BrowserUseEncryptedActionEnvelopeValue
} from './browser-use.js'

const BROWSER_USE_ACTION_AEAD_DOMAIN = 'kun-browser-use-action-envelope-v1'
const BrowserUseBridgeToken = z.string().regex(/^[A-Za-z0-9_-]{32,256}$/)
const BrowserUseEncryptedActionPayload = z.object({
  bridgeToken: BrowserUseBridgeToken,
  request: z.unknown()
}).strict()

export type BrowserUseEncryptedActionPayload = {
  bridgeToken: string
  request: unknown
}

/** Encrypt all action authority and data before it crosses the loopback port. */
export function encryptBrowserUseActionEnvelope(
  input: BrowserUseEncryptedActionPayload,
  signingKey: string
): BrowserUseEncryptedActionEnvelopeValue {
  const payload = BrowserUseEncryptedActionPayload.parse(input)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', browserUseActionKey(signingKey), iv)
  cipher.setAAD(browserUseActionAad())
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final()
  ])
  return BrowserUseEncryptedActionEnvelope.parse({
    contractVersion: BROWSER_USE_BRIDGE_CONTRACT_VERSION,
    iv: iv.toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
    authTag: cipher.getAuthTag().toString('base64url')
  })
}

/** Fail closed with one generic error for malformed, tampered, or wrong-key data. */
export function decryptBrowserUseActionEnvelope(
  input: unknown,
  signingKey: string
): BrowserUseEncryptedActionPayload {
  try {
    const envelope = BrowserUseEncryptedActionEnvelope.parse(input)
    const decipher = createDecipheriv(
      'aes-256-gcm',
      browserUseActionKey(signingKey),
      Buffer.from(envelope.iv, 'base64url')
    )
    decipher.setAAD(browserUseActionAad())
    decipher.setAuthTag(Buffer.from(envelope.authTag, 'base64url'))
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, 'base64url')),
      decipher.final()
    ])
    return BrowserUseEncryptedActionPayload.parse(JSON.parse(plaintext.toString('utf8')))
  } catch {
    throw new Error('Browser Use encrypted action envelope is invalid')
  }
}

function browserUseActionKey(signingKey: string): Buffer {
  const normalized = signingKey.trim()
  if (!/^[A-Za-z0-9_-]{32,512}$/.test(normalized)) {
    throw new Error('Browser Use host signing key is unavailable')
  }
  return createHmac('sha256', normalized)
    .update(`${BROWSER_USE_ACTION_AEAD_DOMAIN}:key`)
    .digest()
}

function browserUseActionAad(): Buffer {
  return Buffer.from(JSON.stringify([
    BROWSER_USE_ACTION_AEAD_DOMAIN,
    BROWSER_USE_BRIDGE_CONTRACT_VERSION
  ]))
}
