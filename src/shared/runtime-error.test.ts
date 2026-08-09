import { describe, expect, it } from 'vitest'
import {
  isKnownKunErrorCode,
  parseRuntimeErrorBody,
  parseThreadBusyDetails,
  runtimeErrorToError
} from './runtime-error'

describe('runtime error parsing', () => {
  it('parses Kun code, message, and details payloads', () => {
    const parsed = parseRuntimeErrorBody(
      JSON.stringify({
        code: 'attachment_validation_failed',
        message: 'image is too large',
        details: [{ path: ['dataBase64'], message: 'too big' }]
      }),
      'fallback'
    )

    expect(parsed).toEqual({
      code: 'attachment_validation_failed',
      message: 'image is too large',
      details: [{ path: ['dataBase64'], message: 'too big' }]
    })
  })

  it('round trips structured runtime errors through Error instances', () => {
    const error = runtimeErrorToError({
      code: 'provider_unavailable',
      message: 'provider failed',
      details: { status: 503 }
    })

    expect(parseRuntimeErrorBody(error.message, 'fallback')).toEqual({
      code: 'provider_unavailable',
      message: 'provider failed',
      details: { status: 503 }
    })
  })

  it('preserves thread_busy and reads its sanitized structured details', () => {
    const parsed = parseRuntimeErrorBody(
      JSON.stringify({
        code: 'thread_busy',
        message: 'thread already has an active turn',
        details: {
          threadId: 'thr_1',
          activeTurnId: 'turn_1',
          ownerFlavor: 'production',
          acquiredAt: '2026-08-09T10:00:00.000Z',
          expiresAt: '2026-08-09T10:00:30.000Z'
        }
      }),
      'fallback'
    )

    expect(parsed.code).toBe('thread_busy')
    expect(isKnownKunErrorCode(parsed.code)).toBe(true)
    expect(parseThreadBusyDetails(parsed.details)).toEqual({
      threadId: 'thr_1',
      activeTurnId: 'turn_1',
      ownerFlavor: 'production',
      acquiredAt: '2026-08-09T10:00:00.000Z',
      expiresAt: '2026-08-09T10:00:30.000Z'
    })
    expect(JSON.stringify(parsed)).not.toContain('ownerInstanceId')
  })
})
