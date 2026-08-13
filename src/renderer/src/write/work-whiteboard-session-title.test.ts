import { describe, expect, it, vi } from 'vitest'
import type { WorkWhiteboard } from './write-workspace-store-types'
import { renameWorkWhiteboardSession } from './work-whiteboard-session-title'

const board = (overrides: Partial<WorkWhiteboard> = {}): WorkWhiteboard => ({
  id: 'board-1',
  title: 'Untitled whiteboard',
  workspaceRoot: '/work',
  threadId: 'thread-1',
  phase: 'blank',
  revision: 0,
  createdAt: '2026-08-13T00:00:00.000Z',
  updatedAt: '2026-08-13T00:00:00.000Z',
  ...overrides
})

describe('Work whiteboard session titles', () => {
  it('renames the session before updating the whiteboard cache', async () => {
    let sessionTitle = 'Untitled whiteboard'
    const renameSession = vi.fn(async (_threadId: string, title: string) => { sessionTitle = title })
    const renameWhiteboard = vi.fn(async () => true)

    await expect(renameWorkWhiteboardSession({
      board: board(),
      title: 'FastAPI architecture',
      renameSession,
      readSessionTitle: () => sessionTitle,
      renameWhiteboard
    })).resolves.toBe(true)

    expect(renameSession).toHaveBeenCalledWith('thread-1', 'FastAPI architecture')
    expect(renameWhiteboard).toHaveBeenCalledWith('board-1', 'FastAPI architecture')
  })

  it('does not split the names when the session rename fails', async () => {
    const renameWhiteboard = vi.fn(async () => true)
    await expect(renameWorkWhiteboardSession({
      board: board(),
      title: 'FastAPI architecture',
      renameSession: vi.fn(async () => undefined),
      readSessionTitle: () => 'Untitled whiteboard',
      renameWhiteboard
    })).resolves.toBe(false)

    expect(renameWhiteboard).not.toHaveBeenCalled()
  })

  it('updates an unbound whiteboard without touching any session', async () => {
    const renameSession = vi.fn(async () => undefined)
    const renameWhiteboard = vi.fn(async () => true)

    await expect(renameWorkWhiteboardSession({
      board: board({ threadId: null }),
      title: 'Standalone board',
      renameSession,
      readSessionTitle: () => null,
      renameWhiteboard
    })).resolves.toBe(true)

    expect(renameSession).not.toHaveBeenCalled()
    expect(renameWhiteboard).toHaveBeenCalledWith('board-1', 'Standalone board')
  })
})
