import { describe, expect, it } from 'vitest'
import { MODEL_REQUEST_TRACE_REDACTED_VALUE } from '../contracts/model-request-trace.js'
import {
  BoundedModelTraceBodyAccumulator,
  boundedModelTraceText,
  redactModelTraceValues,
  sanitizeModelTraceHeaders,
  sanitizeModelTraceUrl
} from './model-request-trace-safety.js'

describe('model request trace safety', () => {
  it('redacts URL credentials and secret query values before retention', () => {
    const result = sanitizeModelTraceUrl(
      'https://user:pass@example.test/v1/chat?api_key=secret&project=visible&signature=signed'
    )

    expect(result.redacted).toBe(true)
    expect(result.value).not.toContain('user')
    expect(result.value).not.toContain('pass')
    expect(result.value).not.toContain('secret')
    expect(result.value).not.toContain('signed')
    expect(new URL(result.value).searchParams.get('project')).toBe('visible')
    expect(new URL(result.value).searchParams.get('api_key')).toBe(MODEL_REQUEST_TRACE_REDACTED_VALUE)
  })

  it('retains header names while redacting credentials and secret values', () => {
    const result = sanitizeModelTraceHeaders({
      Authorization: 'Bearer top-secret',
      'x-api-key': 'top-secret',
      'x-custom-auth-token': 'custom-secret',
      'x-project': 'visible',
      'x-opaque': 'top-secret'
    }, ['top-secret'])

    expect(result.values).toEqual({
      Authorization: MODEL_REQUEST_TRACE_REDACTED_VALUE,
      'x-api-key': MODEL_REQUEST_TRACE_REDACTED_VALUE,
      'x-custom-auth-token': MODEL_REQUEST_TRACE_REDACTED_VALUE,
      'x-project': 'visible',
      'x-opaque': MODEL_REQUEST_TRACE_REDACTED_VALUE
    })
    expect(result.redactedNames).toEqual([
      'Authorization', 'x-api-key', 'x-custom-auth-token', 'x-opaque'
    ])
  })

  it('truncates retained text at a valid UTF-8 boundary and keeps byte counts', () => {
    const result = boundedModelTraceText('ab🙂cd', 5)

    expect(result).toEqual({
      text: 'ab',
      capturedBytes: 2,
      originalBytes: 8,
      truncated: true
    })
  })

  it('bounds incremental response retention while counting every byte', () => {
    const accumulator = new BoundedModelTraceBodyAccumulator(5)
    accumulator.append(Buffer.from('abc'))
    accumulator.append(Buffer.from('defghi'))

    expect(accumulator.finish()).toEqual({
      text: 'abcde',
      capturedBytes: 5,
      originalBytes: 9,
      truncated: true
    })
  })

  it('redacts exact model-only values from JSON traces without hiding adjacent diagnostics', () => {
    const goalText = 'Internal active-goal instruction with a private objective.'
    const result = redactModelTraceValues(JSON.stringify({
      messages: [
        { role: 'user', content: 'visible user request' },
        { role: 'system', content: goalText }
      ],
      nested: { transcript: `before ${goalText} after` }
    }), [goalText])

    expect(result).not.toContain(goalText)
    expect(result).toContain('visible user request')
    expect(result).toContain(MODEL_REQUEST_TRACE_REDACTED_VALUE)
    expect(JSON.parse(result)).toMatchObject({
      messages: [
        { content: 'visible user request' },
        { content: MODEL_REQUEST_TRACE_REDACTED_VALUE }
      ],
      nested: { transcript: `before ${MODEL_REQUEST_TRACE_REDACTED_VALUE} after` }
    })
  })
})
