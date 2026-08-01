import { describe, expect, it } from 'vitest'
import { createThreadRecord, resolveThreadAgentSurface, toThreadSummary } from './thread.js'
import { createTurnRecord } from './turn.js'

function legacyThreadWithSurfaces(surfaces: Array<'code' | 'write' | 'design' | undefined>) {
  const thread = createThreadRecord({
    id: 'thr_legacy_surface',
    title: 'Legacy surface',
    workspace: '/tmp/project',
    model: 'test-model',
    createdAt: '2026-08-01T00:00:00.000Z'
  })
  return {
    ...thread,
    turns: surfaces.map((agentSurface, index) => createTurnRecord({
      id: `turn_${index}`,
      threadId: thread.id,
      prompt: `turn ${index}`,
      model: thread.model,
      ...(agentSurface ? { agentSurface } : {}),
      createdAt: `2026-08-01T00:00:0${index + 1}.000Z`
    }))
  }
}

describe('resolveThreadAgentSurface', () => {
  it('honors explicit thread ownership even when legacy turns are mixed', () => {
    const thread = {
      ...legacyThreadWithSurfaces(['code', 'design']),
      agentSurface: 'write' as const
    }

    expect(resolveThreadAgentSurface(thread)).toBe('write')
    expect(toThreadSummary(thread).agentSurface).toBe('write')
  })

  it('infers a non-Code surface only from a non-empty homogeneous annotated history', () => {
    expect(resolveThreadAgentSurface(legacyThreadWithSurfaces(['design', 'design']))).toBe('design')
    expect(resolveThreadAgentSurface(legacyThreadWithSurfaces(['write', 'write']))).toBe('write')
    expect(resolveThreadAgentSurface(legacyThreadWithSurfaces(['design', 'code']))).toBe('code')
    expect(resolveThreadAgentSurface(legacyThreadWithSurfaces(['design', undefined]))).toBe('code')
    expect(resolveThreadAgentSurface(legacyThreadWithSurfaces([]))).toBe('code')
  })
})
