import { create } from 'zustand'
import type { TrajectoryFilter } from '../agent/trajectory'

export type TrajectoryUiState = {
  view: 'chat' | 'trajectory'
  filter: TrajectoryFilter
  query: string
  selectedRecordId: string | null
  collapsedTurnIds: string[]
  scrollOffset: number
  inspectorWidth: number
  timelineMode: 'actual' | 'equal'
}

const DEFAULT_STATE: TrajectoryUiState = {
  view: 'chat',
  filter: 'all',
  query: '',
  selectedRecordId: null,
  collapsedTurnIds: [],
  scrollOffset: 0,
  inspectorWidth: 420,
  timelineMode: 'actual'
}

type Store = {
  byThread: Record<string, TrajectoryUiState>
  lru: string[]
  update: (threadId: string, patch: Partial<TrajectoryUiState>) => void
  remove: (threadId: string) => void
}

const MAX_THREAD_STATES = 32

export const useTrajectoryUiStore = create<Store>((set) => ({
  byThread: {},
  lru: [],
  update: (threadId, patch) => set((state) => {
    if (!threadId) return state
    const lru = [...state.lru.filter((id) => id !== threadId), threadId]
    const byThread = {
      ...state.byThread,
      [threadId]: { ...(state.byThread[threadId] ?? DEFAULT_STATE), ...patch }
    }
    while (lru.length > MAX_THREAD_STATES) {
      const evicted = lru.shift()
      if (evicted) delete byThread[evicted]
    }
    return { byThread, lru }
  }),
  remove: (threadId) => set((state) => {
    const byThread = { ...state.byThread }
    delete byThread[threadId]
    return { byThread, lru: state.lru.filter((id) => id !== threadId) }
  })
}))

export function trajectoryUiState(
  byThread: Record<string, TrajectoryUiState>,
  threadId: string | null
): TrajectoryUiState {
  return threadId ? byThread[threadId] ?? DEFAULT_STATE : DEFAULT_STATE
}
