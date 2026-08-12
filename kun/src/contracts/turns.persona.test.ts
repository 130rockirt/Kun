import { describe, expect, it } from 'vitest'
import { StartTurnRequest, TURN_PERSONA_MAX_CHARS } from './turns.js'
import { ThreadSchema } from './threads.js'
import { createTurnRecord } from '../domain/turn.js'

describe('StartTurnRequest.persona', () => {
  it('accepts a persona within the cap', () => {
    const parsed = StartTurnRequest.safeParse({ prompt: 'hi', persona: 'Be skeptical.' })
    expect(parsed.success).toBe(true)
    expect(parsed.success && parsed.data.persona).toBe('Be skeptical.')
  })

  it('is optional', () => {
    const parsed = StartTurnRequest.safeParse({ prompt: 'hi' })
    expect(parsed.success).toBe(true)
    expect(parsed.success && parsed.data.persona).toBeUndefined()
  })

  it('rejects a persona over the cap so it cannot displace conversation context', () => {
    const parsed = StartTurnRequest.safeParse({
      prompt: 'hi',
      persona: 'x'.repeat(TURN_PERSONA_MAX_CHARS + 1)
    })
    expect(parsed.success).toBe(false)
  })
})

describe('createTurnRecord persona', () => {
  const base = { id: 't1', threadId: 'th1', prompt: 'hi', model: 'm' }

  it('persists a trimmed persona on the turn record', () => {
    expect(createTurnRecord({ ...base, persona: '  Be terse.  ' }).persona).toBe('Be terse.')
  })

  it('omits the field for blank or missing personas', () => {
    expect(createTurnRecord({ ...base, persona: '   ' }).persona).toBeUndefined()
    expect(createTurnRecord(base).persona).toBeUndefined()
  })

  it('survives the ThreadSchema persistence round-trip', () => {
    const turn = createTurnRecord({ ...base, persona: 'Be terse.' })
    const thread = ThreadSchema.parse({
      id: 'th1',
      workspace: '/tmp',
      title: 't',
      model: 'm',
      mode: 'agent',
      status: 'running',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      turns: [turn]
    })
    expect(thread.turns[0].persona).toBe('Be terse.')
  })
})
