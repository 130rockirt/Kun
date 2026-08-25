import type {
  ProviderMutationFlushRequest,
  ProviderMutationFlushRequestHandler,
  ProviderMutationFlushResult
} from '@shared/provider-mutation-barrier'
import {
  drainSharedProviderCatalogMutation,
  drainSharedProviderCredentialMutation,
  enqueueSharedModelMutation,
  sharedProviderMutationCoordinator
} from './shared-provider-mutation-coordinator'

export type ProviderMutationFlushOperations = {
  drainProfile: (providerId: string) => Promise<void>
  drainCatalog: (providerId: string, generation: number) => Promise<void>
  drainCredential: (providerId: string, generation: number) => Promise<void>
  drainDeletion: (providerId: string) => Promise<void>
}

let currentOperations: ProviderMutationFlushOperations | null = null
let installed: (() => void) | null = null

export function registerProviderMutationFlushOperations(
  operations: ProviderMutationFlushOperations
): () => void {
  currentOperations = operations
  return () => {
    if (currentOperations === operations) currentOperations = null
  }
}

export function installProviderMutationFlushHandler(): () => void {
  installed?.()
  const handler: ProviderMutationFlushRequestHandler = async (request) => {
    if (!currentOperations) {
      return {
        requestId: request.requestId,
        ok: false,
        pendingProviderIds: [],
        mutationKinds: [],
        errorCode: 'renderer-unavailable'
      }
    }
    return flushAllPendingProviderMutations(request, currentOperations)
  }
  installed = window.kunGui.onProviderMutationFlushRequest(handler)
  return () => {
    installed?.()
    installed = null
  }
}

export async function flushAllPendingProviderMutations(
  request: ProviderMutationFlushRequest,
  operations: ProviderMutationFlushOperations
): Promise<ProviderMutationFlushResult> {
  const pendingProviderIds = new Set<string>()
  const mutationKinds = new Set<ProviderMutationFlushResult['mutationKinds'][number]>()
  const deadline = Date.now() + Math.max(1, request.deadlineMs)
  const run = async (providerId: string, kind: ProviderMutationFlushResult['mutationKinds'][number], action: () => Promise<void>) => {
    if (Date.now() >= deadline) return
    pendingProviderIds.add(providerId)
    mutationKinds.add(kind)
    await action()
    pendingProviderIds.delete(providerId)
  }
  try {
    for (const [providerId, pending] of sharedProviderMutationCoordinator.pendingNames) {
      if (pending.committedRevision === null) await run(providerId, 'profile', () => operations.drainProfile(providerId))
    }
    for (const [providerId, pending] of sharedProviderMutationCoordinator.pendingCatalogs) {
      if (pending.committedRevision === null) await run(providerId, 'catalog', () => operations.drainCatalog(providerId, pending.generation))
    }
    for (const [providerId, pending] of sharedProviderMutationCoordinator.pendingCredentials) {
      await run(providerId, 'credential', () => operations.drainCredential(providerId, pending.generation))
    }
    for (const [providerId, pending] of sharedProviderMutationCoordinator.pendingDeletions) {
      if (pending.committedRevision === null) await run(providerId, 'deletion', () => operations.drainDeletion(providerId))
    }
    await enqueueSharedModelMutation(async () => undefined)
    const timedOut = Date.now() >= deadline
    return {
      requestId: request.requestId,
      ok: !timedOut && pendingProviderIds.size === 0,
      pendingProviderIds: [...pendingProviderIds].sort(),
      mutationKinds: [...mutationKinds].sort(),
      ...(timedOut ? { errorCode: 'timeout' as const } : {})
    }
  } catch {
    return {
      requestId: request.requestId,
      ok: false,
      pendingProviderIds: [...pendingProviderIds].sort(),
      mutationKinds: [...mutationKinds].sort(),
      errorCode: 'flush-failed'
    }
  }
}
