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
})
