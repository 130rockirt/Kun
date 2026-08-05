import { describe, expect, it } from 'vitest'
import { makeGoalContextItem, makeUserItem } from '../domain/item.js'
import { buildSessionTranscript } from './session-summary.js'

describe('buildSessionTranscript', () => {
  it('never emits model-only goal context into a public summary transcript', () => {
    const user = makeUserItem({
      id: 'item_summary_user',
      threadId: 'thread_summary',
      turnId: 'turn_summary',
      text: 'Summarize this conversation.'
    })
    const goal = makeGoalContextItem({
      id: 'item_summary_goal',
      threadId: 'thread_summary',
      turnId: 'turn_summary',
      goalKey: 'goal_summary',
      text: 'Internal goal instruction that must not reach a public summary.'
    })

    const transcript = buildSessionTranscript([user, goal], 4_096)

    expect(transcript).toContain('Summarize this conversation.')
    expect(transcript).not.toContain('Internal goal instruction')
    expect(transcript).not.toContain('[goal_context]')
  })
})
