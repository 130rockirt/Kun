import { describe, expect, it } from 'vitest'
import { kunGraphPatchSchema } from './settings-graph'

describe('Graph settings IPC schema', () => {
  it('accepts and drops a legacy scheduler token ceiling', () => {
    const parsed = kunGraphPatchSchema.parse({
      scheduler: {
        maxTotalTokens: 1,
        maxConcurrentNodes: 4
      }
    })

    expect(parsed.scheduler).toEqual({ maxConcurrentNodes: 4 })
  })
})
