import { describe, expect, it } from 'vitest'
import {
  ModelContextOverflowError,
  modelContextOverflowError,
  normalizeModelContextOverflowError
} from './model-context-overflow.js'

describe('model context overflow classification', () => {
  it('recognizes provider codes and common messages', () => {
    expect(modelContextOverflowError('bad request', 'context_length_exceeded'))
      .toBeInstanceOf(ModelContextOverflowError)
    expect(modelContextOverflowError('Maximum context length is 128000 tokens'))
      .toBeInstanceOf(ModelContextOverflowError)
    expect(normalizeModelContextOverflowError(new Error('Prompt is too long for this model')))
      .toBeInstanceOf(ModelContextOverflowError)
  })

  it('does not classify unrelated provider failures', () => {
    expect(modelContextOverflowError('invalid API key', 'authentication_error')).toBeUndefined()
    expect(modelContextOverflowError('quota exceeded', 'rate_limit_error')).toBeUndefined()
    expect(modelContextOverflowError('model response exceeded 1048576 bytes', 'stream_resource_limit'))
      .toBeUndefined()
  })
})
