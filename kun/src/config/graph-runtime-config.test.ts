import { describe, expect, it } from 'vitest'
import {
  DEFAULT_GRAPH_RUNTIME_CONFIG,
  GraphRuntimeConfigSchema
} from './kun-config.js'

describe('Graph runtime token accounting', () => {
  it('accepts and drops a legacy scheduler token ceiling', () => {
    const parsed = GraphRuntimeConfigSchema.parse({
      ...DEFAULT_GRAPH_RUNTIME_CONFIG,
      scheduler: {
        ...DEFAULT_GRAPH_RUNTIME_CONFIG.scheduler,
        maxTotalTokens: 1
      }
    })

    expect(parsed.scheduler).not.toHaveProperty('maxTotalTokens')
  })

  it('defaults Graph node wall time to 24 hours while preserving an explicit lower limit', () => {
    const parsedDefault = GraphRuntimeConfigSchema.parse({
      ...DEFAULT_GRAPH_RUNTIME_CONFIG,
      scheduler: {
        ...DEFAULT_GRAPH_RUNTIME_CONFIG.scheduler,
        maxNodeWallTimeMs: undefined
      }
    })
    const parsedLower = GraphRuntimeConfigSchema.parse({
      ...DEFAULT_GRAPH_RUNTIME_CONFIG,
      scheduler: {
        ...DEFAULT_GRAPH_RUNTIME_CONFIG.scheduler,
        maxNodeWallTimeMs: 2 * 60 * 60_000
      }
    })

    expect(DEFAULT_GRAPH_RUNTIME_CONFIG.scheduler.maxNodeWallTimeMs).toBe(24 * 60 * 60_000)
    expect(parsedDefault.scheduler.maxNodeWallTimeMs).toBe(24 * 60 * 60_000)
    expect(parsedLower.scheduler.maxNodeWallTimeMs).toBe(2 * 60 * 60_000)
  })
})
