import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_AUTO_PLAN_BUILD_INTENTS,
  activeAutoPlanBuildIntent,
  clearAutoPlanBuildIntents,
  createAutoPlanBuildIntent,
  listAutoPlanBuildIntents,
  normalizeAutoPlanBuildIntent,
  normalizeAutoPlanBuildRegistry,
  patchAutoPlanBuildIntent,
  saveAutoPlanBuildIntent
} from './auto-plan-build-intents'

class MemoryStorage {
  private values = new Map<string, string>()
  getItem(key: string): string | null { return this.values.get(key) ?? null }
  setItem(key: string, value: string): void { this.values.set(key, value) }
  removeItem(key: string): void { this.values.delete(key) }
}

describe('Automatic plan-build intent registry', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { localStorage: new MemoryStorage() })
  })

  afterEach(() => vi.unstubAllGlobals())

  it('strictly rejects malformed and incomplete scheduled intents', () => {
    expect(normalizeAutoPlanBuildIntent({ version: 1 })).toBeNull()
    const direct = createAutoPlanBuildIntent({
      planId: '/repo:.kunsdd/plan/a.md',
      relativePath: '.kunsdd/plan/a.md',
      workspaceRoot: '/repo',
      threadId: 'thread-1',
      selection: { buildMode: 'direct', useWorktree: true },
      now: 1
    })
    expect(normalizeAutoPlanBuildIntent(direct)).toEqual(direct)
    expect(normalizeAutoPlanBuildIntent({ ...direct, buildMode: 'scheduled' })).toBeNull()
    expect(normalizeAutoPlanBuildIntent({ ...direct, status: 'complete' })).toBeNull()
  })

  it('binds, patches, and discovers a per-thread intent', () => {
    const intent = createAutoPlanBuildIntent({
      planId: '/repo:.kunsdd/plan/a.md',
      relativePath: '.kunsdd/plan/a.md',
      workspaceRoot: '/repo',
      selection: { buildMode: 'direct', useWorktree: false },
      now: 1
    })
    saveAutoPlanBuildIntent(intent)
    expect(activeAutoPlanBuildIntent('thread-1')).toBeNull()
    patchAutoPlanBuildIntent(intent.id, { threadId: 'thread-1', status: 'dispatching' })
    expect(activeAutoPlanBuildIntent('thread-1')).toMatchObject({
      id: intent.id,
      status: 'dispatching',
      useWorktree: false
    })
    clearAutoPlanBuildIntents()
    expect(listAutoPlanBuildIntents()).toEqual([])
  })

  it('keeps only the newest bounded valid intents', () => {
    const intents = Array.from({ length: MAX_AUTO_PLAN_BUILD_INTENTS + 5 }, (_, index) =>
      createAutoPlanBuildIntent({
        planId: `/repo:.kunsdd/plan/${index}.md`,
        relativePath: `.kunsdd/plan/${index}.md`,
        workspaceRoot: '/repo',
        threadId: `thread-${index}`,
        selection: { buildMode: 'direct', useWorktree: true },
        now: index + 1
      }))
    const normalized = normalizeAutoPlanBuildRegistry({
      version: 1,
      intents: Object.fromEntries(intents.map((intent) => [intent.id, intent]))
    })
    expect(Object.keys(normalized.intents)).toHaveLength(MAX_AUTO_PLAN_BUILD_INTENTS)
    expect(Object.values(normalized.intents).some((intent) => intent.planId.endsWith('/0.md'))).toBe(false)
  })

  it('preserves exact one-shot scheduled configuration', () => {
    const intent = createAutoPlanBuildIntent({
      planId: '/repo:.kunsdd/plan/scheduled.md',
      relativePath: '.kunsdd/plan/scheduled.md',
      workspaceRoot: '/repo',
      threadId: 'thread-s',
      selection: {
        buildMode: 'scheduled',
        useWorktree: true,
        scheduled: {
          providerId: 'codex',
          model: 'gpt-5.4',
          reasoningEffort: 'high',
          schedule: {
            kind: 'at',
            atTime: '2030-01-01T01:00:00.000Z',
            timeZone: 'Asia/Shanghai'
          }
        }
      }
    })
    expect(normalizeAutoPlanBuildIntent(intent)?.scheduled).toEqual(intent.scheduled)
  })

  it('fails closed when the recovery intent cannot be persisted', () => {
    vi.stubGlobal('window', {
      localStorage: {
        getItem: () => null,
        setItem: () => { throw new Error('quota exceeded') }
      }
    })
    const intent = createAutoPlanBuildIntent({
      planId: '/repo:.kunsdd/plan/fail.md',
      relativePath: '.kunsdd/plan/fail.md',
      workspaceRoot: '/repo',
      threadId: 'thread-fail',
      selection: { buildMode: 'direct', useWorktree: true }
    })
    expect(saveAutoPlanBuildIntent(intent)).toBe(false)
  })
})
