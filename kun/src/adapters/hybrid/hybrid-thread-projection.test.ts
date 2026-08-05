import { describe, expect, it } from 'vitest'
import { makeGoalContextItem, makeUserItem } from '../../domain/item.js'
import { createThreadRecord } from '../../domain/thread.js'
import { createTurnRecord } from '../../domain/turn.js'
import { hydrateThreadItems } from './hybrid-thread-projection.js'

describe('hydrateThreadItems', () => {
  it('does not rehydrate internal goal context into the public thread projection', () => {
    const threadId = 'thread_goal_projection'
    const turnId = 'turn_goal_projection'
    const prompt = 'Continue the goal.'
    const user = makeUserItem({
      id: 'item_goal_user',
      threadId,
      turnId,
      text: prompt
    })
    const goal = makeGoalContextItem({
      id: 'item_goal_context',
      threadId,
      turnId,
      text: 'Internal stable goal context.',
      createdAt: '2026-08-06T00:00:00.000Z'
    })
    const thread = {
      ...createThreadRecord({
        id: threadId,
        title: 'Goal projection',
        workspace: '/tmp/workspace',
        model: 'test-model'
      }),
      turns: [createTurnRecord({
        id: turnId,
        threadId,
        prompt,
        status: 'completed'
      })]
    }

    const hydrated = hydrateThreadItems(thread, [user, goal], {
      preserveExistingItemsWhenNoFileItems: false
    })

    expect(hydrated.turns[0]?.items).toEqual([user])
    expect(JSON.stringify(hydrated)).not.toContain('Internal stable goal context.')
  })

  it('filters an internal goal context from a preserved legacy item mirror', () => {
    const threadId = 'thread_goal_legacy_projection'
    const turnId = 'turn_goal_legacy_projection'
    const prompt = 'Keep the public history.'
    const user = makeUserItem({
      id: 'item_goal_legacy_user',
      threadId,
      turnId,
      text: prompt
    })
    const goal = makeGoalContextItem({
      id: 'item_goal_legacy_context',
      threadId,
      turnId,
      text: 'Do not expose this model-only goal context.',
      createdAt: '2026-08-06T00:00:00.000Z'
    })
    const thread = {
      ...createThreadRecord({
        id: threadId,
        title: 'Legacy goal projection',
        workspace: '/tmp/workspace',
        model: 'test-model'
      }),
      turns: [{
        ...createTurnRecord({
          id: turnId,
          threadId,
          prompt,
          status: 'completed'
        }),
        items: [user, goal]
      }]
    }

    const hydrated = hydrateThreadItems(thread, [], {
      preserveExistingItemsWhenNoFileItems: true
    })

    expect(hydrated.turns[0]?.items).toEqual([user])
    expect(JSON.stringify(hydrated)).not.toContain('Do not expose this model-only goal context.')
  })
})
