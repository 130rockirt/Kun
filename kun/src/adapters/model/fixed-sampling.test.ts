import { describe, expect, it } from 'vitest'
import {
  bodyHasSamplingParams,
  isFixedSamplingModel,
  shouldRetryWithoutSamplingParams,
  stripFixedSamplingParams,
  stripSamplingFromBody
} from './fixed-sampling.js'

describe('fixed sampling helpers', () => {
  it('detects Kimi K3 aliases including custom gateway ids', () => {
    expect(isFixedSamplingModel('k3')).toBe(true)
    expect(isFixedSamplingModel('k3-256k')).toBe(true)
    expect(isFixedSamplingModel('moonshot/k3-256k')).toBe(true)
    expect(isFixedSamplingModel('kimi-k3')).toBe(true)
    expect(isFixedSamplingModel('kimi-k3-preview')).toBe(true)
    expect(isFixedSamplingModel('kimi-for-coding')).toBe(false)
    expect(isFixedSamplingModel('deepseek-v4-pro')).toBe(false)
  })

  it('strips temperature/topP only for fixed-sampling models', () => {
    expect(stripFixedSamplingParams({
      model: 'k3-256k',
      temperature: 0,
      topP: 1
    })).toEqual({ model: 'k3-256k' })
    expect(stripFixedSamplingParams({
      model: 'deepseek-v4-flash',
      temperature: 0,
      topP: 1
    })).toEqual({
      model: 'deepseek-v4-flash',
      temperature: 0,
      topP: 1
    })
  })

  it('strips sampling fields from request bodies for 400 recovery', () => {
    const body = { model: 'k3', temperature: 0, top_p: 1, stream: true }
    expect(bodyHasSamplingParams(body)).toBe(true)
    expect(stripSamplingFromBody(body)).toEqual({ model: 'k3', stream: true })
    expect(shouldRetryWithoutSamplingParams(
      400,
      'invalid temperature: only 1 is allowed for this model',
      body
    )).toBe(true)
    expect(shouldRetryWithoutSamplingParams(400, 'invalid temperature', { model: 'k3' })).toBe(false)
    expect(shouldRetryWithoutSamplingParams(500, 'temperature', body)).toBe(false)
  })
})
