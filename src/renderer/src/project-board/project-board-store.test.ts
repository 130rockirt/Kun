import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectBoardSnapshot } from './project-board-types'

const api = vi.hoisted(() => ({
  snapshot: vi.fn(), summaries: vi.fn(), createCard: vi.fn(), patchCard: vi.fn(),
  deleteCard: vi.fn(), patchTodoOverlay: vi.fn(), patchTodoStatus: vi.fn()
}))

vi.mock('./project-board-api', () => ({
  projectBoardApi: api,
  ProjectBoardApiError: class ProjectBoardApiError extends Error {
    constructor(message: string, readonly status: number, readonly snapshot?: ProjectBoardSnapshot) {
      super(message)
      this.name = 'ProjectBoardApiError'
    }
  }
}))

import { ProjectBoardApiError } from './project-board-api'
import { useProjectBoardStore } from './project-board-store'

function snapshot(workspaceRoot: string, revision = 0): ProjectBoardSnapshot {
  return {
    workspaceRoot, revision, cards: [],
    counts: { pending: 0, inProgress: 0, completed: 0, archived: 0, total: 0 },
    truncated: false
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe('project board store', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useProjectBoardStore.setState({
      selectedWorkspaceRoot: '', snapshotByWorkspace: {}, summariesByWorkspace: {},
      loading: false, mutatingCardId: null, error: null, searchQuery: '',
      filters: { categories: [], priorities: [], sources: [], showCompleted: true }, activeTab: 'board'
    })
  })

  it('keeps a late workspace A response from overwriting workspace B page state', async () => {
    const a = deferred<ProjectBoardSnapshot>()
    const b = deferred<ProjectBoardSnapshot>()
    api.snapshot.mockImplementation((workspace: string) => workspace === '/A' ? a.promise : b.promise)
    useProjectBoardStore.getState().selectWorkspace('/A')
    const loadA = useProjectBoardStore.getState().loadBoard('/A')
    useProjectBoardStore.getState().selectWorkspace('/B')
    const loadB = useProjectBoardStore.getState().loadBoard('/B')
    b.resolve(snapshot('/B'))
    await loadB
    a.resolve(snapshot('/A'))
    await loadA

    const state = useProjectBoardStore.getState()
    expect(state.selectedWorkspaceRoot).toBe('/B')
    expect(state.snapshotByWorkspace['/A']?.workspaceRoot).toBe('/A')
    expect(state.snapshotByWorkspace['/B']?.workspaceRoot).toBe('/B')
    expect(state.loading).toBe(false)
  })

  it('rolls an optimistic move back to the authoritative 409 snapshot', async () => {
    const server = snapshot('/A', 2)
    server.cards = [{
      id: 'manual:one', kind: 'manual', workspaceRoot: '/A', title: 'One', description: '',
      status: 'pending', category: 'other', priority: null, archived: false,
      updatedAt: '2026-08-31T00:00:00.000Z', source: { label: 'Manual' }
    }]
    server.counts = { pending: 1, inProgress: 0, completed: 0, archived: 0, total: 1 }
    useProjectBoardStore.setState({ selectedWorkspaceRoot: '/A', snapshotByWorkspace: { '/A': server } })
    api.patchCard.mockRejectedValue(new ProjectBoardApiError('updated elsewhere', 409, server))

    await useProjectBoardStore.getState().moveCard(server.cards[0]!, 'completed')

    expect(useProjectBoardStore.getState().snapshotByWorkspace['/A']?.cards[0]?.status).toBe('pending')
    expect(useProjectBoardStore.getState().error).toBe('updated elsewhere')
  })
})
