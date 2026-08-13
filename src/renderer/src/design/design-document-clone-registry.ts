import type { BrowserStorageLike } from '../lib/browser-storage'
import { browserStorage } from '../lib/browser-storage'
import type { DesignDocumentTarget } from '../agent/design-task-profile'

const REGISTRY_KEY = 'kun.designDocumentCloneOperations.v1'

export type PendingDesignDocumentClone = {
  operationId: string
  kind: 'fork' | 'resume' | 'bind'
  sourceId: string
  relation: 'fork' | 'side' | 'resume' | 'bind'
  workspaceRoot: string
  sourceTarget: DesignDocumentTarget
  clonedTarget: DesignDocumentTarget
  createdAt: string
  phase: 'prepared' | 'runtime-requested'
}

type CloneOperationRegistry = {
  version: 1
  operations: Record<string, PendingDesignDocumentClone>
}

function storageOrDefault(storage?: BrowserStorageLike | null): BrowserStorageLike | null {
  return storage === undefined ? browserStorage() : storage
}

function readRegistry(storage?: BrowserStorageLike | null): CloneOperationRegistry {
  const target = storageOrDefault(storage)
  if (!target) return { version: 1, operations: {} }
  try {
    const parsed = JSON.parse(target.getItem(REGISTRY_KEY) ?? 'null') as Partial<CloneOperationRegistry> | null
    if (!parsed?.operations || typeof parsed.operations !== 'object') {
      return { version: 1, operations: {} }
    }
    const operations = Object.fromEntries(Object.entries(parsed.operations).filter(([, value]) => {
      if (!value || typeof value !== 'object') return false
      const record = value as PendingDesignDocumentClone
      return Boolean(
        record.operationId?.trim() && record.workspaceRoot?.trim() &&
        (record.kind === 'fork' || record.kind === 'resume' || record.kind === 'bind') &&
        (record.relation === 'fork' || record.relation === 'side' ||
          record.relation === 'resume' || record.relation === 'bind') &&
        record.sourceId?.trim() &&
        record.sourceTarget?.documentId?.trim() && record.sourceTarget?.boardArtifactId?.trim() &&
        record.clonedTarget?.documentId?.trim() && record.clonedTarget?.boardArtifactId?.trim() &&
        (record.phase === 'prepared' || record.phase === 'runtime-requested')
      )
    }))
    return { version: 1, operations }
  } catch {
    return { version: 1, operations: {} }
  }
}

function writeRegistry(
  registry: CloneOperationRegistry,
  storage?: BrowserStorageLike | null
): void {
  const target = storageOrDefault(storage)
  if (!target) return
  target.setItem(REGISTRY_KEY, JSON.stringify(registry))
}

export function pendingDesignDocumentClones(
  storage?: BrowserStorageLike | null
): PendingDesignDocumentClone[] {
  return Object.values(readRegistry(storage).operations)
}

export function rememberPendingDesignDocumentClone(
  operation: PendingDesignDocumentClone,
  storage?: BrowserStorageLike | null
): void {
  const registry = readRegistry(storage)
  writeRegistry({
    version: 1,
    operations: { ...registry.operations, [operation.operationId]: operation }
  }, storage)
}

export function forgetPendingDesignDocumentClone(
  operationId: string,
  storage?: BrowserStorageLike | null
): void {
  const registry = readRegistry(storage)
  if (!registry.operations[operationId]) return
  const operations = { ...registry.operations }
  delete operations[operationId]
  writeRegistry({ version: 1, operations }, storage)
}

export function markDesignDocumentCloneRuntimeRequested(
  operationId: string,
  storage?: BrowserStorageLike | null
): void {
  const registry = readRegistry(storage)
  const current = registry.operations[operationId]
  if (!current || current.phase === 'runtime-requested') return
  writeRegistry({
    version: 1,
    operations: {
      ...registry.operations,
      [operationId]: { ...current, phase: 'runtime-requested' }
    }
  }, storage)
}
