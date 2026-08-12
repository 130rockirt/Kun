import { describe, expect, it } from 'vitest'
import { isPublicTurnItem } from '../contracts/items.js'
import { makeAssistantTextItem } from '../domain/item.js'
import { resolveModelContextUpdate } from './model-context-history.js'

const base = {
  threadId: 'thread-context',
  turnId: 'turn-context',
  createdAt: '2026-08-12T00:00:00.000Z'
}

describe('append-only model context history', () => {
  it('persists a complete first capsule and only changed blocks afterward', () => {
    const first = resolveModelContextUpdate({
      ...base,
      stepIndex: 0,
      modeInstruction: 'Plan mode policy',
      contextBlocks: [
        { kind: 'runtime-context', authority: 'runtime', content: 'Time A' },
        { kind: 'persona', authority: 'user', content: 'Be skeptical' }
      ],
      history: []
    })
    expect(first?.existing).toBe(false)
    expect(first?.item.text).toContain('Plan mode policy')
    expect(first?.item.text).toContain('Time A')
    expect(first?.item.text).toContain('Be skeptical')

    const progressedHistory = first ? [
      first.item,
      makeAssistantTextItem({
        id: 'assistant-after-first-context',
        threadId: base.threadId,
        turnId: base.turnId,
        text: 'First step response',
        status: 'completed'
      })
    ] : []
    const unchanged = resolveModelContextUpdate({
      ...base,
      stepIndex: 1,
      modeInstruction: 'Plan mode policy',
      contextBlocks: [
        { kind: 'runtime-context', authority: 'runtime', content: 'Time A' },
        { kind: 'persona', authority: 'user', content: 'Be skeptical' }
      ],
      history: progressedHistory
    })
    expect(unchanged).toBeNull()

    const changed = resolveModelContextUpdate({
      ...base,
      stepIndex: 2,
      modeInstruction: 'Plan mode policy',
      contextBlocks: [
        { kind: 'runtime-context', authority: 'runtime', content: 'Time B' }
      ],
      history: progressedHistory
    })
    expect(changed?.item.text).toContain('Time B')
    expect(changed?.item.text).not.toContain('Plan mode policy\n</kun_context_update>')
    expect(changed?.item.text).toContain('kind="persona" authority="user" state="inactive"')
    expect(first?.item.text).toContain('Be skeptical')
  })

  it('reuses exact bytes for a persisted step and stays private', () => {
    const first = resolveModelContextUpdate({
      ...base,
      stepIndex: 0,
      contextBlocks: [{ kind: 'persona', authority: 'user', content: 'First render' }],
      history: []
    })
    expect(first).not.toBeNull()
    if (!first) return

    const resumed = resolveModelContextUpdate({
      ...base,
      stepIndex: 0,
      contextBlocks: [{ kind: 'persona', authority: 'user', content: 'Changed after restart' }],
      history: [first.item]
    })
    expect(resumed).toEqual({ item: first.item, existing: true })
    expect(isPublicTurnItem(first.item)).toBe(false)
  })

  it('allocates a durable next step after restart when prior model history exists', () => {
    const first = resolveModelContextUpdate({
      ...base,
      stepIndex: 0,
      contextBlocks: [{ kind: 'persona', authority: 'user', content: 'Persona before restart' }],
      history: []
    })
    expect(first).not.toBeNull()
    if (!first) return
    const assistant = makeAssistantTextItem({
      id: 'assistant-before-restart',
      threadId: base.threadId,
      turnId: base.turnId,
      text: 'Persisted model progress',
      status: 'completed'
    })
    const resumed = resolveModelContextUpdate({
      ...base,
      stepIndex: 0,
      contextBlocks: [{ kind: 'persona', authority: 'user', content: 'Persona after restart' }],
      history: [first.item, assistant]
    })

    expect(resumed?.existing).toBe(false)
    expect(resumed?.item.stepIndex).toBe(1)
    expect(resumed?.item.text).toContain('Persona after restart')
    expect(first.item.text).toContain('Persona before restart')
  })

  it('starts each user turn with a scoped full capsule without mutating prior history', () => {
    const first = resolveModelContextUpdate({
      threadId: base.threadId,
      turnId: 'turn-one',
      stepIndex: 0,
      contextBlocks: [{ kind: 'persona', authority: 'user', content: 'Persona one' }],
      history: [],
      createdAt: base.createdAt
    })
    expect(first).not.toBeNull()
    if (!first) return
    const second = resolveModelContextUpdate({
      threadId: base.threadId,
      turnId: 'turn-two',
      stepIndex: 0,
      contextBlocks: [{ kind: 'persona', authority: 'user', content: 'Persona two' }],
      history: [first.item],
      createdAt: base.createdAt
    })
    expect(second?.item.text).toContain('Persona two')
    expect(second?.item.text).not.toContain('Persona one')
    expect(first.item.text).toContain('Persona one')
  })
})
