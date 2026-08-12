import { describe, expect, it } from 'vitest'
import { buildPromptCachePartition, promptCacheKey } from './prompt-cache-partition.js'

const tool = {
  name: 'read_file',
  description: 'Read a file',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path']
  }
}

function partition(overrides: Partial<Parameters<typeof buildPromptCachePartition>[0]> = {}) {
  return buildPromptCachePartition({
    model: 'gpt-5.6-sol',
    providerId: 'openai',
    endpointFormat: 'responses',
    responsesMode: 'lite',
    phase: 'agent',
    immutablePrefixFingerprint: 'stable-prefix',
    threadProfileInstruction: 'thread profile',
    tools: [tool],
    ...overrides
  })
}

describe('prompt cache partition', () => {
  it('is stable across persona, message, and attachment changes because they are not inputs', () => {
    expect(partition()).toEqual(partition())
    expect(promptCacheKey('thread-1', partition().hash)).toBe(
      `thread-1:${partition().hash}`
    )
  })

  it('separates real mode phases and returns to the prior Agent namespace', () => {
    const agent = partition({ phase: 'agent' })
    const plan = partition({ phase: 'plan' })
    const graphPlanning = partition({ phase: 'graph-planning' })
    const graphActive = partition({ phase: 'graph-active' })
    expect(new Set([agent.hash, plan.hash, graphPlanning.hash, graphActive.hash]).size).toBe(4)
    expect(partition({ phase: 'agent' }).hash).toBe(agent.hash)
  })

  it('uses the canonical advertised tool schema and protocol variant', () => {
    const reordered = partition({
      tools: [{
        ...tool,
        inputSchema: {
          required: ['path'],
          properties: { path: { type: 'string' } },
          type: 'object'
        }
      }]
    })
    expect(reordered.hash).toBe(partition().hash)
    expect(partition({ tools: [] }).hash).not.toBe(partition().hash)
    expect(partition({ tools: [{ ...tool, description: 'Changed wire schema' }] }).hash)
      .not.toBe(partition().hash)
    expect(partition({ responsesMode: undefined }).hash).not.toBe(partition().hash)
  })
})
