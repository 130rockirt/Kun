import { create, type StoreApi } from 'zustand'
import { normalizeWorkspaceRoot, workspaceRootIdentityKey } from '../lib/workspace-path'
import { projectBoardApi, ProjectBoardApiError } from './project-board-api'
import {
  DEFAULT_PROJECT_BOARD_FILTERS,
  type ProjectBoardCard,
  type ProjectBoardCategory,
  type ProjectBoardFilters,
  type ProjectBoardPriority,
  type ProjectBoardSnapshot,
  type ProjectBoardStatus,
  type ProjectBoardSummary,
  type ProjectBoardTab
} from './project-board-types'

const SELECTED_WORKSPACE_KEY = 'kun:project-board:selected-workspace:v1'
const FILTERS_KEY_PREFIX = 'kun:project-board:filters:v1:'
const SUMMARY_CACHE_MS = 30_000
const inflightLoads = new Map<string, Promise<void>>()
const summaryLoadedAtByWorkspace = new Map<string, number>()

export type ProjectBoardState = {
  selectedWorkspaceRoot: string
  snapshotByWorkspace: Record<string, ProjectBoardSnapshot>
  summariesByWorkspace: Record<string, ProjectBoardSummary>
  loading: boolean
  mutatingCardId: string | null
  error: string | null
  searchQuery: string
  filters: ProjectBoardFilters
  activeTab: ProjectBoardTab
  selectWorkspace(workspaceRoot: string): void
  setSearchQuery(query: string): void
  setFilters(filters: ProjectBoardFilters): void
  setActiveTab(tab: ProjectBoardTab): void
  loadBoard(workspaceRoot: string, options?: { force?: boolean }): Promise<void>
  loadMore(workspaceRoot: string): Promise<void>
  refreshSummaries(workspaceRoots: string[], options?: { force?: boolean }): Promise<void>
  createManualCard(input: {
    title: string
    description?: string
    status: ProjectBoardStatus
    category?: ProjectBoardCategory
    priority?: ProjectBoardPriority
  }): Promise<string | null>
  patchManualCard(cardId: string, patch: {
    title?: string
    description?: string
    status?: ProjectBoardStatus
    category?: ProjectBoardCategory
    priority?: ProjectBoardPriority
    archived?: boolean
  }): Promise<void>
  deleteManualCard(cardId: string): Promise<void>
  patchTodoOverlay(card: ProjectBoardCard, patch: {
    category?: ProjectBoardCategory | null
    priority?: ProjectBoardPriority
    description?: string
    archived?: boolean
  }): Promise<void>
  moveCard(card: ProjectBoardCard, status: ProjectBoardStatus): Promise<void>
}

export const useProjectBoardStore = create<ProjectBoardState>((set, get) => ({
  selectedWorkspaceRoot: readStorage(SELECTED_WORKSPACE_KEY),
  snapshotByWorkspace: {},
  summariesByWorkspace: {},
  loading: false,
  mutatingCardId: null,
  error: null,
  searchQuery: '',
  filters: DEFAULT_PROJECT_BOARD_FILTERS,
  activeTab: 'board',

  selectWorkspace(workspaceRoot) {
    const normalized = normalizeWorkspaceRoot(workspaceRoot)
    if (!normalized) return
    writeStorage(SELECTED_WORKSPACE_KEY, normalized)
    set({
      selectedWorkspaceRoot: normalized,
      searchQuery: '',
      filters: readFilters(normalized),
      error: null
    })
  },

  setSearchQuery(searchQuery) { set({ searchQuery }) },
  setFilters(filters) {
    const workspace = get().selectedWorkspaceRoot
    if (workspace) writeStorage(`${FILTERS_KEY_PREFIX}${workspaceRootIdentityKey(workspace)}`, JSON.stringify(filters))
    set({ filters })
  },
  setActiveTab(activeTab) { set({ activeTab }) },

  async loadBoard(workspaceRoot, _options = {}) {
    const workspace = normalizeWorkspaceRoot(workspaceRoot)
    if (!workspace) return
    const key = workspaceRootIdentityKey(workspace)
    if (inflightLoads.has(key)) return inflightLoads.get(key)
    const selectedAtStart = get().selectedWorkspaceRoot
    const task = (async () => {
      if (workspaceRootIdentityKey(selectedAtStart) === key) set({ loading: true, error: null })
      try {
        const snapshot = await projectBoardApi.snapshot(workspace, { includeArchived: true })
        set((state) => ({
          snapshotByWorkspace: {
            ...state.snapshotByWorkspace,
            [workspace]: snapshot,
            [snapshot.workspaceRoot]: snapshot
          },
          ...(workspaceRootIdentityKey(state.selectedWorkspaceRoot) === key
            ? { loading: false, error: snapshot.warning ?? null }
            : {})
        }))
      } catch (error) {
        set((state) => workspaceRootIdentityKey(state.selectedWorkspaceRoot) === key
          ? { loading: false, error: errorMessage(error) }
          : state)
      }
    })().finally(() => {
      if (inflightLoads.get(key) === task) inflightLoads.delete(key)
    })
    inflightLoads.set(key, task)
    return task
  },

  async loadMore(workspaceRoot) {
    const workspace = normalizeWorkspaceRoot(workspaceRoot)
    const current = get().snapshotByWorkspace[workspace]
    if (!current?.nextCursor) return
    try {
      const page = await projectBoardApi.snapshot(workspace, {
        includeArchived: true,
        cursor: current.nextCursor
      })
      set((state) => ({
        snapshotByWorkspace: {
          ...state.snapshotByWorkspace,
          [workspace]: {
            ...page,
            cards: [...current.cards, ...page.cards]
          }
        }
      }))
    } catch (error) {
      set({ error: errorMessage(error) })
    }
  },

  async refreshSummaries(workspaceRoots, options = {}) {
    const roots = uniqueWorkspaces(workspaceRoots)
    if (roots.length === 0) return
    const now = Date.now()
    const pending = options.force ? roots : roots.filter((workspace) =>
      now - (summaryLoadedAtByWorkspace.get(workspaceRootIdentityKey(workspace)) ?? 0) >= SUMMARY_CACHE_MS)
    if (pending.length === 0) return
    try {
      const batches: string[][] = []
      for (let index = 0; index < pending.length; index += 32) batches.push(pending.slice(index, index + 32))
      const summaries = (await Promise.all(batches.map((batch) => projectBoardApi.summaries(batch)))).flat()
      for (const workspace of pending) {
        summaryLoadedAtByWorkspace.set(workspaceRootIdentityKey(workspace), Date.now())
      }
      set((state) => ({
        summariesByWorkspace: summaries.reduce<Record<string, ProjectBoardSummary>>((all, summary) => {
          all[summary.workspaceRoot] = summary
          const requested = roots.find((root) =>
            workspaceRootIdentityKey(root) === workspaceRootIdentityKey(summary.workspaceRoot))
          if (requested) all[requested] = summary
          return all
        }, { ...state.summariesByWorkspace })
      }))
    } catch {
      // Sidebar summaries are supplementary; the page owns the visible error state.
    }
  },

  async createManualCard(input) {
    const workspace = get().selectedWorkspaceRoot
    const snapshot = get().snapshotByWorkspace[workspace]
    if (!workspace || !snapshot) return null
    const previousIds = new Set(snapshot.cards.map((card) => card.id))
    const next = await mutateSnapshot(set, get, '__new__', () => projectBoardApi.createCard({
      workspace,
      expectedRevision: snapshot.revision,
      ...input
    }))
    return next?.cards.find((card) => !previousIds.has(card.id))?.id ?? null
  },

  async patchManualCard(cardId, patch) {
    const workspace = get().selectedWorkspaceRoot
    const snapshot = get().snapshotByWorkspace[workspace]
    if (!workspace || !snapshot) return
    await mutateSnapshot(set, get, cardId, () => projectBoardApi.patchCard(cardId, {
      workspace,
      expectedRevision: snapshot.revision,
      ...patch
    }))
  },

  async deleteManualCard(cardId) {
    const workspace = get().selectedWorkspaceRoot
    const snapshot = get().snapshotByWorkspace[workspace]
    if (!workspace || !snapshot) return
    await mutateSnapshot(set, get, cardId, () =>
      projectBoardApi.deleteCard(cardId, workspace, snapshot.revision))
  },

  async patchTodoOverlay(card, patch) {
    const workspace = get().selectedWorkspaceRoot
    const snapshot = get().snapshotByWorkspace[workspace]
    if (!workspace || !snapshot) return
    await mutateSnapshot(set, get, card.id, () => projectBoardApi.patchTodoOverlay(card, {
      workspace,
      expectedRevision: snapshot.revision,
      ...patch
    }))
  },

  async moveCard(card, status) {
    if (card.status === status) return
    const workspace = get().selectedWorkspaceRoot
    const snapshot = get().snapshotByWorkspace[workspace]
    if (!workspace || !snapshot) return
    const optimistic = replaceCard(snapshot, card.id, { status, updatedAt: new Date().toISOString() })
    set((state) => ({
      snapshotByWorkspace: { ...state.snapshotByWorkspace, [workspace]: optimistic },
      mutatingCardId: card.id,
      error: null
    }))
    try {
      if (card.kind === 'manual') {
        const next = await projectBoardApi.patchCard(card.id, {
          workspace,
          expectedRevision: snapshot.revision,
          status
        })
        applySnapshot(set, workspace, next)
      } else {
        const response = await projectBoardApi.patchTodoStatus(card, status)
        set((state) => ({
          snapshotByWorkspace: {
            ...state.snapshotByWorkspace,
            [workspace]: response.card
              ? replaceCard(state.snapshotByWorkspace[workspace] ?? snapshot, card.id, {
                  status: response.card.status,
                  updatedAt: response.card.updatedAt
                })
              : state.snapshotByWorkspace[workspace] ?? optimistic
          },
          mutatingCardId: null
        }))
      }
    } catch (error) {
      if (error instanceof ProjectBoardApiError && error.snapshot) {
        applySnapshot(set, workspace, error.snapshot, error.message)
      } else {
        set((state) => ({
          snapshotByWorkspace: { ...state.snapshotByWorkspace, [workspace]: snapshot },
          mutatingCardId: null,
          ...(workspaceRootIdentityKey(state.selectedWorkspaceRoot) === workspaceRootIdentityKey(workspace)
            ? { error: errorMessage(error) }
            : {})
        }))
      }
    }
  }
}))

type StoreSet = StoreApi<ProjectBoardState>['setState']
type StoreGet = StoreApi<ProjectBoardState>['getState']

async function mutateSnapshot(
  set: StoreSet,
  get: StoreGet,
  cardId: string,
  mutation: () => Promise<ProjectBoardSnapshot>
): Promise<ProjectBoardSnapshot | null> {
  const workspace = get().selectedWorkspaceRoot
  set({ mutatingCardId: cardId, error: null })
  try {
    const next = await mutation()
    applySnapshot(set, workspace, next)
    return next
  } catch (error) {
    if (error instanceof ProjectBoardApiError && error.snapshot) {
      applySnapshot(set, workspace, error.snapshot, error.message)
    } else {
      set((state) => ({
        mutatingCardId: null,
        ...(workspaceRootIdentityKey(state.selectedWorkspaceRoot) === workspaceRootIdentityKey(workspace)
          ? { error: errorMessage(error) }
          : {})
      }))
    }
    return null
  }
}

function applySnapshot(
  set: StoreSet,
  workspace: string,
  snapshot: ProjectBoardSnapshot,
  error: string | null = null
): void {
  set((state) => ({
    snapshotByWorkspace: {
      ...state.snapshotByWorkspace,
      [workspace]: snapshot,
      [snapshot.workspaceRoot]: snapshot
    },
    mutatingCardId: null,
    ...(workspaceRootIdentityKey(state.selectedWorkspaceRoot) === workspaceRootIdentityKey(workspace)
      ? { error }
      : {})
  }))
}

function replaceCard(
  snapshot: ProjectBoardSnapshot,
  cardId: string,
  patch: Partial<ProjectBoardCard> | ProjectBoardCard
): ProjectBoardSnapshot {
  const cards = snapshot.cards.map((card) => card.id === cardId ? { ...card, ...patch } : card)
  return { ...snapshot, cards, counts: countsFor(cards) }
}

function countsFor(cards: ProjectBoardCard[]): ProjectBoardSnapshot['counts'] {
  const active = cards.filter((card) => !card.archived)
  return {
    pending: active.filter((card) => card.status === 'pending').length,
    inProgress: active.filter((card) => card.status === 'in_progress').length,
    completed: active.filter((card) => card.status === 'completed').length,
    archived: cards.length - active.length,
    total: active.length
  }
}

function uniqueWorkspaces(workspaces: string[]): string[] {
  const seen = new Set<string>()
  return workspaces.map(normalizeWorkspaceRoot).filter((workspace) => {
    const key = workspaceRootIdentityKey(workspace)
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function readFilters(workspace: string): ProjectBoardFilters {
  try {
    const raw = readStorage(`${FILTERS_KEY_PREFIX}${workspaceRootIdentityKey(workspace)}`)
    if (!raw) return DEFAULT_PROJECT_BOARD_FILTERS
    const value = JSON.parse(raw) as Partial<ProjectBoardFilters>
    return {
      categories: Array.isArray(value.categories) ? value.categories : [],
      priorities: Array.isArray(value.priorities) ? value.priorities : [],
      sources: Array.isArray(value.sources) ? value.sources : [],
      showCompleted: value.showCompleted !== false
    }
  } catch {
    return DEFAULT_PROJECT_BOARD_FILTERS
  }
}

function readStorage(key: string): string {
  try { return window.localStorage.getItem(key) ?? '' } catch { return '' }
}
function writeStorage(key: string, value: string): void {
  try { window.localStorage.setItem(key, value) } catch { /* storage is optional */ }
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
