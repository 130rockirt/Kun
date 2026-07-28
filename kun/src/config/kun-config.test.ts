import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_KUN_CAPABILITIES_CONFIG } from '../contracts/capabilities.js'
import { expandHomePath, RuntimeTuningConfigSchema } from './kun-config.js'

describe('RuntimeTuningConfigSchema streamIdleTimeoutMs', () => {
  it('accepts a custom timeout, including 0 to disable the guard', () => {
    expect(RuntimeTuningConfigSchema.safeParse({ streamIdleTimeoutMs: 300_000 }).success).toBe(true)
    expect(RuntimeTuningConfigSchema.safeParse({ streamIdleTimeoutMs: 0 }).success).toBe(true)
  })

  it('rejects negative or fractional timeouts', () => {
    expect(RuntimeTuningConfigSchema.safeParse({ streamIdleTimeoutMs: -1 }).success).toBe(false)
    expect(RuntimeTuningConfigSchema.safeParse({ streamIdleTimeoutMs: 1.5 }).success).toBe(false)
  })
})

describe('RuntimeTuningConfigSchema turn admission', () => {
  it('accepts a bounded positive global turn concurrency cap', () => {
    expect(RuntimeTuningConfigSchema.safeParse({
      turnLimits: { maxConcurrentTurns: 4 }
    }).success).toBe(true)
  })

  it('rejects zero, fractions, and excessive global turn caps', () => {
    expect(RuntimeTuningConfigSchema.safeParse({
      turnLimits: { maxConcurrentTurns: 0 }
    }).success).toBe(false)
    expect(RuntimeTuningConfigSchema.safeParse({
      turnLimits: { maxConcurrentTurns: 1.5 }
    }).success).toBe(false)
    expect(RuntimeTuningConfigSchema.safeParse({
      turnLimits: { maxConcurrentTurns: 257 }
    }).success).toBe(false)
  })
})

describe('RuntimeTuningConfigSchema Agent Perspective capture', () => {
  it('defaults an existing llmDebug block to enabled', () => {
    expect(RuntimeTuningConfigSchema.parse({
      llmDebug: {}
    }).llmDebug).toEqual({ enabled: true })
  })

  it('preserves explicit facility and new-thread capture defaults', () => {
    expect(RuntimeTuningConfigSchema.parse({
      llmDebug: { enabled: true, defaultThreadCaptureEnabled: true }
    }).llmDebug).toEqual({ enabled: true, defaultThreadCaptureEnabled: true })
    expect(RuntimeTuningConfigSchema.parse({
      llmDebug: { enabled: false, defaultThreadCaptureEnabled: false }
    }).llmDebug).toEqual({ enabled: false, defaultThreadCaptureEnabled: false })
  })
})

describe('default subagent parallelism', () => {
  it('defaults max parallel subagent runs to 256', () => {
    expect(DEFAULT_KUN_CAPABILITIES_CONFIG.subagents.maxParallel).toBe(256)
  })
})

describe('expandHomePath', () => {
  it('expands Windows-style home-relative paths', () => {
    expect(expandHomePath('~\\kun\\config.json')).toBe(join(homedir(), 'kun', 'config.json'))
  })

  it('leaves non-home tilde prefixes untouched', () => {
    expect(expandHomePath('~other/config.json')).toBe('~other/config.json')
  })
})
