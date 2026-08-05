import type { ModelProviderModelProfileV1 } from '@shared/app-settings'

export type PendingSharedProviderName = {
  localName: string
  canonicalName: string
  committedRevision: number | null
}

export type PendingSharedProviderCatalog = {
  generation: number
  baseModels: string[]
  baseModelProfiles: Record<string, ModelProviderModelProfileV1>
  localModels: string[]
  localModelProfiles: Record<string, ModelProviderModelProfileV1>
  committedRevision: number | null
}

export type PendingSharedProviderCredential = {
  generation: number
  credential: string
}

export type PendingSharedProviderDeletion = {
  generation: number
  committedRevision: number | null
}

export type SharedProviderMutationTimer = {
  owner: symbol
  timer: ReturnType<typeof setTimeout>
}

export const sharedProviderMutationCoordinator = {
  pendingDeletions: new Map<string, PendingSharedProviderDeletion>(),
  pendingNames: new Map<string, PendingSharedProviderName>(),
  pendingCatalogs: new Map<string, PendingSharedProviderCatalog>(),
  pendingCredentials: new Map<string, PendingSharedProviderCredential>(),
  catalogTimers: new Map<string, SharedProviderMutationTimer>(),
  credentialTimers: new Map<string, SharedProviderMutationTimer>(),
  deletionGeneration: 0,
  catalogGeneration: 0,
  credentialGeneration: 0
}

let mutationTail: Promise<void> = Promise.resolve()
const catalogDrains = new Map<string, { generation: number; promise: Promise<unknown> }>()

export function enqueueSharedModelMutation<T>(operation: () => Promise<T>): Promise<T> {
  const result = mutationTail.then(operation, operation)
  mutationTail = result.then(() => undefined, () => undefined)
  return result
}

export function drainSharedProviderCatalogMutation<T>(
  providerId: string,
  generation: number,
  operation: () => Promise<T>
): Promise<T> {
  const existing = catalogDrains.get(providerId)
  if (existing?.generation === generation) return existing.promise as Promise<T>
  const promise = enqueueSharedModelMutation(operation)
  catalogDrains.set(providerId, { generation, promise })
  void promise.finally(() => {
    if (catalogDrains.get(providerId)?.generation === generation) catalogDrains.delete(providerId)
  }).catch(() => undefined)
  return promise
}

export function stageSharedProviderCredentialMutation(
  providerId: string,
  credential: string
): PendingSharedProviderCredential {
  const pending = {
    generation: sharedProviderMutationCoordinator.credentialGeneration + 1,
    credential
  }
  sharedProviderMutationCoordinator.credentialGeneration = pending.generation
  sharedProviderMutationCoordinator.pendingCredentials.set(providerId, pending)
  return pending
}

export async function drainSharedProviderCredentialMutation<T>(
  providerId: string,
  generation: number,
  operation: (credential: string) => Promise<T>
): Promise<{ value: T; committed: boolean } | null> {
  return enqueueSharedModelMutation(async () => {
    const pending = sharedProviderMutationCoordinator.pendingCredentials.get(providerId)
    if (!pending || pending.generation !== generation) return null
    const value = await operation(pending.credential)
    const current = sharedProviderMutationCoordinator.pendingCredentials.get(providerId)
    const committed = current?.generation === generation
    if (committed) sharedProviderMutationCoordinator.pendingCredentials.delete(providerId)
    return { value, committed }
  })
}

export function replaceMapContents<K, V>(target: Map<K, V>, source: ReadonlyMap<K, V>): void {
  target.clear()
  for (const [key, value] of source) target.set(key, value)
}

/** Test-only reset for module state that intentionally survives React remounts. */
export function resetSharedProviderMutationCoordinatorForTests(): void {
  for (const record of sharedProviderMutationCoordinator.catalogTimers.values()) clearTimeout(record.timer)
  for (const record of sharedProviderMutationCoordinator.credentialTimers.values()) clearTimeout(record.timer)
  sharedProviderMutationCoordinator.pendingDeletions.clear()
  sharedProviderMutationCoordinator.pendingNames.clear()
  sharedProviderMutationCoordinator.pendingCatalogs.clear()
  sharedProviderMutationCoordinator.pendingCredentials.clear()
  sharedProviderMutationCoordinator.catalogTimers.clear()
  sharedProviderMutationCoordinator.credentialTimers.clear()
  sharedProviderMutationCoordinator.deletionGeneration = 0
  sharedProviderMutationCoordinator.catalogGeneration = 0
  sharedProviderMutationCoordinator.credentialGeneration = 0
  catalogDrains.clear()
  mutationTail = Promise.resolve()
}
