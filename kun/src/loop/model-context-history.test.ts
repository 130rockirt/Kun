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

  it('advances context after an empty model step leaves no assistant item', () => {
    const first = resolveModelContextUpdate({
      ...base,
      stepIndex: 0,
      contextBlocks: [{ kind: 'runtime-context', authority: 'runtime', content: 'Initial step' }],
      history: []
    })
    expect(first).not.toBeNull()
    if (!first) return

    const recovery = resolveModelContextUpdate({
      ...base,
      stepIndex: 1,
      contextBlocks: [{ kind: 'model-recovery', authority: 'runtime', content: 'Recover now' }],
      history: [first.item]
    })

    expect(recovery?.existing).toBe(false)
    expect(recovery?.item.stepIndex).toBe(1)
    expect(recovery?.item.text).toContain('Recover now')
    expect(recovery?.item.text).toContain(
      'kind="runtime-context" authority="runtime" state="inactive"'
    )
  })

  it('carries unchanged block state across user turns without duplicating content', () => {
    const first = resolveModelContextUpdate({
      threadId: base.threadId,
      turnId: 'turn-one',
      stepIndex: 0,
      contextBlocks: [{ kind: 'client-surface', authority: 'runtime', content: 'GUI surface' }],
      history: [],
      createdAt: base.createdAt
    })
    expect(first).not.toBeNull()
    if (!first) return
    const unchanged = resolveModelContextUpdate({
      threadId: base.threadId,
      turnId: 'turn-two',
      stepIndex: 0,
      contextBlocks: [{ kind: 'client-surface', authority: 'runtime', content: 'GUI surface' }],
      history: [first.item],
      createdAt: base.createdAt
    })
    expect(unchanged).toBeNull()
    expect(first.item.text).toContain('GUI surface')
  })

  it('appends only changed and removed block state across user turns', () => {
    const first = resolveModelContextUpdate({
      threadId: base.threadId,
      turnId: 'turn-one',
      stepIndex: 0,
      contextBlocks: [
        { kind: 'client-surface', authority: 'runtime', content: 'GUI surface' },
        { kind: 'runtime-context', authority: 'runtime', content: 'Initial runtime' },
        { kind: 'tool-guidance', authority: 'runtime', content: 'Use read first' }
      ],
      history: [],
      createdAt: base.createdAt
    })
    expect(first).not.toBeNull()
    if (!first) return

    const second = resolveModelContextUpdate({
      threadId: base.threadId,
      turnId: 'turn-two',
      stepIndex: 0,
      contextBlocks: [
        { kind: 'client-surface', authority: 'runtime', content: 'GUI surface' },
        { kind: 'tool-guidance', authority: 'runtime', content: 'Use grep first' }
      ],
      history: [first.item],
      createdAt: base.createdAt
    })

    expect(second?.item.text).toContain('Use grep first')
    expect(second?.item.text).not.toContain('GUI surface')
    expect(second?.item.text).toContain(
      'kind="runtime-context" authority="runtime" state="inactive"'
    )
    expect(first.item.text).toContain('Initial runtime')
  })

  it('writes one thread-wide baseline after legacy turn-scoped context', () => {
    const first = resolveModelContextUpdate({
      threadId: base.threadId,
      turnId: 'turn-one',
      stepIndex: 0,
      contextBlocks: [{ kind: 'client-surface', authority: 'runtime', content: 'GUI surface' }],
      history: [],
      createdAt: base.createdAt
    })
    expect(first).not.toBeNull()
    if (!first) return
    const legacyItem = {
      ...first.item,
      text: first.item.text.replace(
        'Active block state persists across later model steps and user turns until a later update for the same key replaces it or marks it inactive.',
        'Scope: turn "turn-one", model step 0.'
      )
    }

    const migrated = resolveModelContextUpdate({
      threadId: base.threadId,
      turnId: 'turn-two',
      stepIndex: 0,
      contextBlocks: [{ kind: 'client-surface', authority: 'runtime', content: 'GUI surface' }],
      history: [legacyItem],
      createdAt: base.createdAt
    })

    expect(migrated?.item.text).toContain('GUI surface')
    expect(migrated?.item.text).toContain('Active block state persists across later model steps')
  })

  it('can keep request-local host control out of a durable capsule', () => {
    const requestBlocks = [
      { kind: 'runtime-context', authority: 'runtime' as const, content: 'Stable runtime' },
      { kind: 'host-control', authority: 'runtime' as const, content: 'Private turn control' }
    ]
    const persisted = resolveModelContextUpdate({
      ...base,
      stepIndex: 0,
      contextBlocks: requestBlocks.filter((block) => block.kind !== 'host-control'),
      history: []
    })
    expect(persisted?.item.text).toContain('Stable runtime')
    expect(persisted?.item.text).not.toContain('Private turn control')
  })
})
