import type { DesignTaskProfile } from '../agent/design-task-profile'
import { cloneDesignTaskProfile } from '../agent/design-task-profile'
import type { NormalizedThread } from '../agent/types'
import { useDesignWorkspaceStore } from './design-workspace-store'
import { designContextFromTaskProfile } from './design-task-profile-input'

const inflightProfileByThread = new Map<string, Promise<DesignTaskProfile | null>>()

export function mergeThreadDesignProfile(
  threads: readonly NormalizedThread[],
  threadId: string,
  profile: DesignTaskProfile
): NormalizedThread[] {
  const nextProfile = cloneDesignTaskProfile(profile)
  let changed = false
  const next = threads.map((thread) => {
    if (thread.id !== threadId) return thread
    changed = true
    return { ...thread, designProfile: nextProfile }
  })
  return changed ? next : [...threads]
}

export function preserveListedDesignProfiles<T extends { id: string; designProfile?: DesignTaskProfile }>(
  listed: readonly T[],
  localById: ReadonlyMap<string, { designProfile?: DesignTaskProfile }>
): T[] {
  return listed.map((thread) => {
    if (thread.designProfile) return thread
    const localProfile = localById.get(thread.id)?.designProfile
    return localProfile ? { ...thread, designProfile: cloneDesignTaskProfile(localProfile) } : thread
  })
}

export async function restoreLockedDesignDocument(profile: DesignTaskProfile): Promise<boolean> {
  const documentId = profile.documentTarget.documentId
  const boardArtifactId = profile.documentTarget.boardArtifactId
  const documentReady = (): boolean => {
    const state = useDesignWorkspaceStore.getState()
    const document = state.documents.find((candidate) => candidate.id === documentId)
    return Boolean(document?.artifacts.some(
      (artifact) => artifact.id === boardArtifactId && artifact.kind === 'canvas'
    ))
  }
  if (!documentReady()) {
    await useDesignWorkspaceStore.getState().rehydrateArtifacts().catch(() => undefined)
  }
  if (!documentReady()) return false
  const state = useDesignWorkspaceStore.getState()
  state.updateDesignContext(designContextFromTaskProfile(profile))
  if (state.activeDocumentId !== documentId) state.switchActiveDocument(documentId)
  return useDesignWorkspaceStore.getState().activeDocumentId === documentId && documentReady()
}

export async function activateLockedDesignDocument(
  profile: DesignTaskProfile | null,
  onError: (message: string) => void
): Promise<boolean> {
  if (!profile) return true
  const restored = await restoreLockedDesignDocument(profile)
  if (!restored) {
    const message = 'The whiteboard bound to this Design task is unavailable.'
    useDesignWorkspaceStore.getState().setFileError(message)
    onError(message)
    return false
  }
  return true
}

export async function resolveAuthoritativeDesignProfile(input: {
  threadId?: string | null
  localProfile?: DesignTaskProfile | null
  refresh?: boolean
  getThread?: (threadId: string) => NormalizedThread | undefined
  fetchThreadDetail?: (threadId: string) => Promise<{ designProfile?: DesignTaskProfile } | null>
  applyProfile?: (threadId: string, profile: DesignTaskProfile) => void
}): Promise<DesignTaskProfile | null> {
  const threadId = input.threadId?.trim() || ''
  const localProfile = input.localProfile ?? (
    threadId ? input.getThread?.(threadId)?.designProfile : undefined
  ) ?? null
  if (localProfile && !input.refresh) return cloneDesignTaskProfile(localProfile)
  if (!threadId || !input.fetchThreadDetail) {
    return localProfile ? cloneDesignTaskProfile(localProfile) : null
  }

  const existing = inflightProfileByThread.get(threadId)
  if (existing) return existing

  const request = (async () => {
    try {
      const detail = await input.fetchThreadDetail!(threadId)
      const fetched = detail?.designProfile
      if (!fetched) return localProfile ? cloneDesignTaskProfile(localProfile) : null
      const profile = cloneDesignTaskProfile(fetched)
      input.applyProfile?.(threadId, profile)
      return profile
    } catch {
      return localProfile ? cloneDesignTaskProfile(localProfile) : null
    } finally {
      inflightProfileByThread.delete(threadId)
    }
  })()
  inflightProfileByThread.set(threadId, request)
  return request
}
