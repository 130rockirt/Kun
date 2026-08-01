import { describe, expect, it, vi } from 'vitest'
import type { NormalizedThread } from '../agent/types'
import {
  designThreadBelongsToDocument,
  designThreadSelectionSyncForDocument,
  designThreadToSelectForDocument,
  designThreadsForDocument,
  recoverOrphanDesignThreadForDocument,
  registeredDesignThreadIdsForDocument,
  switchDesignThreadForDocument
} from './design-thread-workbench'
import {
  emptyDesignThreadRegistry,
  markDesignThread
} from './design-thread-registry'

function thread(id: string, updatedAt: string, archived = false): NormalizedThread {
  return {
    id,
    title: id,
    workspace: '/workspace',
    model: 'deepseek-chat',
    mode: 'agent',
    updatedAt,
    archived
  }
}

describe('design thread workbench helpers', () => {
  it('selects visible design threads for the active document sorted by update time', () => {
    const registry = markDesignThread(
      '/workspace',
      'doc',
      'thr_1',
      markDesignThread('/workspace', 'doc', 'thr_2', emptyDesignThreadRegistry())
    )
    const threads = [
      thread('thr_1', '2026-07-01T00:00:00.000Z'),
      thread('thr_2', '2026-07-02T00:00:00.000Z'),
      thread('thr_archived', '2026-07-03T00:00:00.000Z', true),
      thread('other', '2026-07-04T00:00:00.000Z')
    ]

    expect(designThreadsForDocument({
      threads,
      workspaceRoot: '/workspace',
      docId: 'doc',
      registry
    }).map((item) => item.id)).toEqual(['thr_2', 'thr_1'])
  })

  it('keeps every registered history id when the runtime thread page is incomplete', () => {
    const registry = markDesignThread(
      '/workspace',
      'doc',
      'thr_loaded',
      markDesignThread('/workspace', 'doc', 'thr_not_loaded', emptyDesignThreadRegistry())
    )

    expect(registeredDesignThreadIdsForDocument({
      workspaceRoot: '/workspace',
      docId: 'doc',
      registry
    })).toEqual(['thr_loaded', 'thr_not_loaded'])
    expect(designThreadsForDocument({
      threads: [thread('thr_loaded', '2026-07-02T00:00:00.000Z')],
      workspaceRoot: '/workspace',
      docId: 'doc',
      registry
    }).map((item) => item.id)).toEqual(['thr_loaded'])
  })

  it('checks whether the active thread belongs to the selected design document', () => {
    const registry = markDesignThread(
      '/workspace',
      'doc',
      'thr_1',
      markDesignThread('/workspace', 'other-doc', 'thr_2', emptyDesignThreadRegistry())
    )
    const threads = [
      thread('thr_1', '2026-07-02T00:00:00.000Z'),
      thread('thr_2', '2026-07-02T00:00:00.000Z')
    ]

    expect(designThreadBelongsToDocument({
      threads,
      workspaceRoot: '/workspace',
      docId: 'doc',
      activeThreadId: 'thr_1',
      registry
    })).toBe(true)
    expect(designThreadBelongsToDocument({
      threads,
      workspaceRoot: '/workspace',
      docId: 'doc',
      activeThreadId: 'thr_2',
      registry
    })).toBe(false)
  })

  it('returns the registered active thread to select when switching design documents', () => {
    const registry = markDesignThread('/workspace', 'doc', 'thr_1', emptyDesignThreadRegistry())

    expect(designThreadToSelectForDocument({
      route: 'design',
      activeThreadId: 'other',
      threads: [thread('thr_1', '2026-07-02T00:00:00.000Z')],
      workspaceRoot: '/workspace',
      docId: 'doc',
      registry
    })).toBe('thr_1')

    expect(designThreadToSelectForDocument({
      route: 'chat',
      activeThreadId: 'other',
      threads: [thread('thr_1', '2026-07-02T00:00:00.000Z')],
      workspaceRoot: '/workspace',
      docId: 'doc',
      registry
    })).toBeNull()
  })

  it('selects the latest design drawing when entering a document with no active thread', () => {
    const registry = markDesignThread(
      '/workspace',
      'doc',
      'thr_old',
      markDesignThread('/workspace', 'doc', 'thr_latest', emptyDesignThreadRegistry())
    )
    const threads = [
      thread('thr_old', '2026-07-01T00:00:00.000Z'),
      thread('thr_latest', '2026-07-03T00:00:00.000Z')
    ]

    expect(designThreadToSelectForDocument({
      route: 'design',
      activeThreadId: null,
      threads,
      workspaceRoot: '/workspace',
      docId: 'doc',
      registry
    })).toBe('thr_latest')
    expect(designThreadSelectionSyncForDocument({
      route: 'design',
      activeThreadId: null,
      threads,
      workspaceRoot: '/workspace',
      docId: 'doc',
      registry
    })).toEqual({ action: 'select', threadId: 'thr_latest' })
  })

  it('asks the workbench to clear a stale active thread when the selected design document has no session', () => {
    const registry = markDesignThread('/workspace', 'other-doc', 'thr_other', emptyDesignThreadRegistry())

    expect(designThreadSelectionSyncForDocument({
      route: 'design',
      activeThreadId: 'thr_other',
      threads: [thread('thr_other', '2026-07-02T00:00:00.000Z')],
      workspaceRoot: '/workspace',
      docId: 'doc',
      registry
    })).toEqual({ action: 'clear' })
  })

  it('keeps the active thread when it belongs to the selected design document', () => {
    const registry = markDesignThread('/workspace', 'doc', 'thr_1', emptyDesignThreadRegistry())

    expect(designThreadSelectionSyncForDocument({
      route: 'design',
      activeThreadId: 'thr_1',
      threads: [thread('thr_1', '2026-07-02T00:00:00.000Z')],
      workspaceRoot: '/workspace',
      docId: 'doc',
      registry
    })).toEqual({ action: 'none' })
  })

  it('keeps a registered active history selected before its thread list page loads', () => {
    const registry = markDesignThread('/workspace', 'doc', 'thr_missing', emptyDesignThreadRegistry())

    expect(designThreadSelectionSyncForDocument({
      route: 'design',
      activeThreadId: 'thr_missing',
      threads: [],
      workspaceRoot: '/workspace',
      docId: 'doc',
      registry
    })).toEqual({ action: 'none' })
  })

  it('marks the switched thread, persists metadata, and selects it', async () => {
    const saveRegistry = vi.fn()
    const persistMeta = vi.fn(async () => true)
    const selectThread = vi.fn(async () => undefined)

    await expect(switchDesignThreadForDocument({
      workspaceRoot: '/workspace',
      docId: 'doc',
      threadId: 'thr_1',
      registry: emptyDesignThreadRegistry(),
      saveRegistry,
      persistMeta,
      selectThread
    })).resolves.toBe(true)

    expect(saveRegistry).toHaveBeenCalledWith(expect.objectContaining({
      workspaces: expect.objectContaining({
        ['/workspace\u0000doc']: { activeThreadId: 'thr_1', threadIds: ['thr_1'] }
      })
    }))
    expect(persistMeta).toHaveBeenCalledWith({
      workspaceRoot: '/workspace',
      docId: 'doc',
      stampThreadId: 'thr_1'
    })
    expect(selectThread).toHaveBeenCalledWith('thr_1')
  })

  it('does not rewrite drawing history bindings while switching is locked', async () => {
    const saveRegistry = vi.fn()
    const persistMeta = vi.fn(async () => true)
    const selectThread = vi.fn(async () => undefined)

    await expect(switchDesignThreadForDocument({
      workspaceRoot: '/workspace',
      docId: 'doc',
      threadId: 'thr_1',
      registry: emptyDesignThreadRegistry(),
      saveRegistry,
      persistMeta,
      selectThread,
      canSwitch: () => false
    })).resolves.toBe(false)

    expect(saveRegistry).not.toHaveBeenCalled()
    expect(persistMeta).not.toHaveBeenCalled()
    expect(selectThread).not.toHaveBeenCalled()
  })

  it('recovers one uniquely titled orphan only after its drawing metadata is durable', async () => {
    let registry = markDesignThread(
      '/Users/test/.kun/design-workspace',
      'doc',
      'thr_empty_existing',
      emptyDesignThreadRegistry()
    )
    const order: string[] = []
    const persistMeta = vi.fn(async (input) => {
      order.push('meta')
      expect(input.record).toEqual({
        activeThreadId: 'thr_orphan',
        threadIds: ['thr_orphan', 'thr_empty_existing']
      })
      return true
    })
    const saveRegistry = vi.fn((next) => {
      order.push('registry')
      registry = next
    })
    const selectThread = vi.fn(async () => {
      order.push('select')
    })

    await expect(recoverOrphanDesignThreadForDocument({
      route: 'design',
      workspaceRoot: '/Users/test/.kun/design-workspace',
      docId: 'doc',
      documents: [{ id: 'doc', title: '帮我做一个 ikun 的官网首页', titleOrigin: 'generated' }],
      threads: [{
        ...thread('thr_orphan', '2026-08-01T00:00:00.000Z'),
        workspace: '/Users/test/code/dsgui-admin',
        agentSurface: 'design'
      }],
      getThreadDetail: vi.fn(async () => ({
        blocks: [{
          kind: 'user' as const,
          id: 'user-1',
          text: 'internal design prompt',
          meta: { displayText: '帮我做一个 ikun 的官网首页' }
        }]
      })),
      selectThread,
      isCurrent: () => true,
      readRegistry: () => registry,
      saveRegistry,
      persistMeta
    })).resolves.toBe(true)

    expect(order).toEqual(['meta', 'registry', 'select'])
    expect(selectThread).toHaveBeenCalledWith('thr_orphan')
  })

  it('does not recover when the drawing title or matching orphan is ambiguous', async () => {
    const getThreadDetail = vi.fn(async (threadId: string) => ({
      blocks: [{ kind: 'user' as const, id: `user-${threadId}`, text: 'Shared drawing' }]
    }))
    const persistMeta = vi.fn(async () => true)
    const selectThread = vi.fn(async () => undefined)
    const orphanThreads = ['thr_1', 'thr_2'].map((id) => ({
      ...thread(id, '2026-08-01T00:00:00.000Z'),
      agentSurface: 'design' as const
    }))

    await expect(recoverOrphanDesignThreadForDocument({
      route: 'design',
      workspaceRoot: '/workspace',
      docId: 'doc',
      documents: [{ id: 'doc', title: 'Shared drawing', titleOrigin: 'generated' }],
      threads: orphanThreads,
      getThreadDetail,
      selectThread,
      isCurrent: () => true,
      persistMeta
    })).resolves.toBe(false)
    await expect(recoverOrphanDesignThreadForDocument({
      route: 'design',
      workspaceRoot: '/workspace',
      docId: 'doc',
      documents: [
        { id: 'doc', title: 'Shared drawing', titleOrigin: 'generated' },
        { id: 'other', title: 'Shared drawing', titleOrigin: 'user' }
      ],
      threads: [orphanThreads[0]],
      getThreadDetail,
      selectThread,
      isCurrent: () => true,
      persistMeta
    })).resolves.toBe(false)

    expect(persistMeta).not.toHaveBeenCalled()
    expect(selectThread).not.toHaveBeenCalled()
  })

  it('defers recovery when another orphan cannot be inspected for uniqueness', async () => {
    const persistMeta = vi.fn(async () => true)
    const selectThread = vi.fn(async () => undefined)

    await expect(recoverOrphanDesignThreadForDocument({
      route: 'design',
      workspaceRoot: '/workspace',
      docId: 'doc',
      documents: [{ id: 'doc', title: 'Recovered drawing', titleOrigin: 'generated' }],
      threads: ['thr_match', 'thr_unreadable'].map((id) => ({
        ...thread(id, '2026-08-01T00:00:00.000Z'),
        agentSurface: 'design' as const
      })),
      getThreadDetail: vi.fn(async (threadId) => {
        if (threadId === 'thr_unreadable') throw new Error('offline')
        return { blocks: [{ kind: 'user' as const, id: 'user-1', text: 'Recovered drawing' }] }
      }),
      selectThread,
      isCurrent: () => true,
      persistMeta
    })).resolves.toBe(false)

    expect(persistMeta).not.toHaveBeenCalled()
    expect(selectThread).not.toHaveBeenCalled()
  })

  it('abandons recovery when route or workspace ownership changes during inspection', async () => {
    let current = true
    const persistMeta = vi.fn(async () => true)
    const saveRegistry = vi.fn()
    const selectThread = vi.fn(async () => undefined)

    await expect(recoverOrphanDesignThreadForDocument({
      route: 'design',
      workspaceRoot: '/workspace',
      docId: 'doc',
      documents: [{ id: 'doc', title: 'Recovered drawing', titleOrigin: 'generated' }],
      threads: [{
        ...thread('thr_orphan', '2026-08-01T00:00:00.000Z'),
        agentSurface: 'design'
      }],
      getThreadDetail: vi.fn(async () => {
        current = false
        return { blocks: [{ kind: 'user' as const, id: 'user-1', text: 'Recovered drawing' }] }
      }),
      selectThread,
      isCurrent: () => current,
      saveRegistry,
      persistMeta
    })).resolves.toBe(false)

    expect(persistMeta).not.toHaveBeenCalled()
    expect(saveRegistry).not.toHaveBeenCalled()
    expect(selectThread).not.toHaveBeenCalled()
  })
})
