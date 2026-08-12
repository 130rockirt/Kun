import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceFileReadResult } from '@shared/workspace-file'
import { clearDesignPersistenceCoordinatorForTests } from '../design/design-persistence-coordinator'
import { useWriteWorkspaceStore } from './write-workspace-store'
import { initialState } from './write-workspace-store-helpers'
import {
  WORK_WHITEBOARD_INDEX,
  parseWorkWhiteboardRegistry,
  serializeWorkWhiteboardRegistry
} from './work-whiteboard'

class MemoryStorage {
  private values = new Map<string, string>()
  getItem(key: string): string | null { return this.values.get(key) ?? null }
  setItem(key: string, value: string): void { this.values.set(key, value) }
  removeItem(key: string): void { this.values.delete(key) }
}

const writeWorkspaceFile = vi.fn(async (payload: { path: string }) => ({
  ok: true as const,
  path: payload.path,
  savedAt: '2026-08-13T00:00:00.000Z'
}))
const deleteWorkspaceEntry = vi.fn(async (payload: { path: string }) => ({
  ok: true as const,
  path: payload.path,
  deletedAt: '2026-08-13T00:00:00.000Z'
}))
const readWorkspaceFile = vi.fn(async (): Promise<WorkspaceFileReadResult> => ({
  ok: false,
  message: 'missing'
}))

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve
  })
  return { promise, resolve }
}

beforeEach(() => {
  writeWorkspaceFile.mockClear()
  deleteWorkspaceEntry.mockClear()
  readWorkspaceFile.mockReset()
  readWorkspaceFile.mockResolvedValue({ ok: false, message: 'missing' })
  vi.stubGlobal('window', {
    localStorage: new MemoryStorage(),
    kunGui: { readWorkspaceFile, writeWorkspaceFile, deleteWorkspaceEntry }
  })
  useWriteWorkspaceStore.setState({
    ...initialState(),
    workspaceRoot: '/work',
    rootDirectory: '/work'
  })
})

afterEach(() => {
  clearDesignPersistenceCoordinatorForTests()
  vi.unstubAllGlobals()
})

describe('Work whiteboard registry', () => {
  it('parses versioned metadata and rejects unsafe board identities', () => {
    const content = JSON.stringify({
      version: 1,
      whiteboards: [
        {
          id: 'board-safe',
          title: 'Review',
          workspaceRoot: '/other',
          threadId: 'thread-1',
          sourcePath: '/work/source.md',
          phase: 'review',
          revision: 2,
          createdAt: '2026-08-13T00:00:00.000Z',
          updatedAt: '2026-08-13T00:00:01.000Z'
        },
        { id: '../escape', title: 'Unsafe' }
      ]
    })

    expect(parseWorkWhiteboardRegistry(content, '/work')).toEqual({
      'board-safe': expect.objectContaining({
        id: 'board-safe',
        workspaceRoot: '/work',
        threadId: 'thread-1',
        phase: 'review',
        revision: 2
      })
    })
  })

  it('loads a workspace registry and preserves stable serialization order', async () => {
    const later = {
      id: 'board-later', title: 'Later', workspaceRoot: '/work', threadId: null,
      phase: 'blank' as const, revision: 0,
      createdAt: '2026-08-13T00:00:01.000Z', updatedAt: '2026-08-13T00:00:01.000Z'
    }
    const earlier = {
      ...later,
      id: 'board-earlier',
      title: 'Earlier',
      createdAt: '2026-08-13T00:00:00.000Z',
      updatedAt: '2026-08-13T00:00:00.000Z'
    }
    const content = serializeWorkWhiteboardRegistry({
      [later.id]: later,
      [earlier.id]: earlier
    })
    readWorkspaceFile.mockResolvedValue({
      ok: true,
      path: '/work/.kun-write/whiteboards/index.json',
      content,
      size: content.length,
      mtimeMs: 1,
      truncated: false
    })

    await useWriteWorkspaceStore.getState().loadWhiteboards('/work')

    expect(readWorkspaceFile).toHaveBeenCalledWith({
      workspaceRoot: '/work',
      path: WORK_WHITEBOARD_INDEX
    })
    expect(Object.keys(useWriteWorkspaceStore.getState().whiteboards)).toEqual([
      'board-earlier',
      'board-later'
    ])
    expect(content.indexOf('board-earlier')).toBeLessThan(content.indexOf('board-later'))
  })

  it('does not apply a whiteboard create after the active workspace changes', async () => {
    const pendingWrite = deferred<{
      ok: true
      path: string
      savedAt: string
    }>()
    writeWorkspaceFile.mockImplementationOnce(() => pendingWrite.promise)

    const creating = useWriteWorkspaceStore.getState().createWhiteboard('/work', {
      title: 'Stale board'
    })
    await vi.waitFor(() => expect(writeWorkspaceFile).toHaveBeenCalledTimes(1))

    useWriteWorkspaceStore.setState({
      ...initialState(),
      workspaceRoot: '/other-workspace',
      rootDirectory: '/other-workspace'
    })
    pendingWrite.resolve({
      ok: true,
      path: WORK_WHITEBOARD_INDEX,
      savedAt: '2026-08-13T00:00:00.000Z'
    })

    await expect(creating).resolves.toBeNull()
    const state = useWriteWorkspaceStore.getState()
    expect(state.workspaceRoot).toBe('/other-workspace')
    expect(state.whiteboards).toEqual({})
    expect(state.activeWhiteboardId).toBeNull()
  })

  it('creates, updates, binds, and deletes a board without a pseudo file session', async () => {
    const board = await useWriteWorkspaceStore.getState().createWhiteboard('/work', {
      title: 'Presentation review',
      sourcePath: '/work/source.md'
    })
    expect(board).not.toBeNull()
    if (!board) return

    let state = useWriteWorkspaceStore.getState()
    expect(state.editorLayout.groups[0]).toMatchObject({
      activePath: `whiteboard:${board.id}`,
      tabs: [{ kind: 'whiteboard', boardId: board.id }]
    })
    expect(state.activeWhiteboardId).toBe(board.id)
    expect(state.activeFilePath).toBeNull()
    expect(state.documentsByPath[`whiteboard:${board.id}`]).toBeUndefined()

    await expect(state.renameWhiteboard(board.id, 'Q3 review')).resolves.toBe(true)
    await expect(state.bindWhiteboardThread(board.id, 'thread-1')).resolves.toBe(true)
    await expect(state.updateWhiteboardPptState(board.id, {
      phase: 'complete', outputPath: '/work/q3.pptx', childId: 'child-1', revision: 4
    })).resolves.toBe(true)
    await expect(state.updateWhiteboardPptState(board.id, { revision: 2 })).resolves.toBe(true)

    state = useWriteWorkspaceStore.getState()
    expect(state.whiteboards[board.id]).toMatchObject({
      title: 'Q3 review',
      threadId: 'thread-1',
      phase: 'complete',
      outputPath: '/work/q3.pptx',
      childId: 'child-1',
      revision: 4
    })

    await expect(state.deleteWhiteboard(board.id)).resolves.toBe(true)
    state = useWriteWorkspaceStore.getState()
    expect(state.whiteboards[board.id]).toBeUndefined()
    expect(state.editorLayout.groups[0].tabs).toEqual([])
    expect(state.activeWhiteboardId).toBeNull()
    expect(deleteWorkspaceEntry).toHaveBeenCalledWith({
      workspaceRoot: '/work',
      path: `.kun-write/whiteboards/${board.id}`
    })
  })

  it('keeps a canonical PPT board bound to its original child and parent thread', async () => {
    const board = await useWriteWorkspaceStore.getState().createWhiteboard('/work', {
      title: 'PPT review', threadId: 'thread-original', workflowId: 'workflow-a', childId: 'child-a'
    })
    expect(board).not.toBeNull()
    if (!board) return

    const state = useWriteWorkspaceStore.getState()
    await expect(state.updateWhiteboardPptState(board.id, {
      phase: 'review', childId: 'child-a', revision: 4
    })).resolves.toBe(true)
    await expect(state.updateWhiteboardPptState(board.id, {
      phase: 'directions', childId: 'child-a', revision: 5
    })).resolves.toBe(true)
    await expect(state.updateWhiteboardPptState(board.id, {
      phase: 'directions', childId: 'late-child', revision: 6
    })).resolves.toBe(true)
    await expect(state.bindWhiteboardThread(board.id, 'late-thread')).resolves.toBe(true)
    await expect(state.findOrCreatePptWhiteboard({
      workspaceRoot: '/work', threadId: 'thread-original', workflowId: 'workflow-a', childId: 'late-child'
    })).resolves.toBeNull()

    expect(useWriteWorkspaceStore.getState().whiteboards[board.id]).toMatchObject({
      threadId: 'thread-original',
      phase: 'review',
      childId: 'child-a',
      revision: 4
    })
  })
})
