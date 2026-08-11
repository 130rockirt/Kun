import { describe, expect, it } from 'vitest'
import { ToolCallTurnItem } from '../contracts/items.js'
import { toolAction } from './render-utils.js'

describe('TUI tool summaries', () => {
  it('shows the explore batch size', () => {
    const item = ToolCallTurnItem.parse({
      id: 'item_explore',
      turnId: 'turn_1',
      threadId: 'thread_1',
      role: 'assistant',
      status: 'running',
      createdAt: '2026-08-11T00:00:00.000Z',
      kind: 'tool_call',
      toolName: 'explore_agent',
      callId: 'call_explore',
      toolKind: 'tool_call',
      arguments: {
        tasks: [
          { title: 'Runtime', query: 'Inspect runtime' },
          { title: 'Renderer', query: 'Inspect renderer' },
          { title: 'Tests', query: 'Inspect tests' }
        ]
      }
    })

    expect(toolAction(item)).toEqual({ verb: 'Explore', subject: '3 tasks' })
  })
})
