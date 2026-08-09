import { createHash, randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { AppSettingsV1 } from '../../shared/app-settings'
import {
  DATA_MIGRATION_MAX_METADATA_BYTES,
  DataMigrationThreadCatalogEntrySchema,
  DataMigrationWorkspaceCatalogEntrySchema,
  type DataMigrationImportPlan,
  type DataMigrationManifestV1,
  type DataMigrationPackageEntry,
  type DataMigrationProgress,
  type DataMigrationReport,
  type DataMigrationThreadCatalogEntry,
  type DataMigrationWorkspaceCatalogEntry,
  type PackageRelativePath,
  parsePackageRelativePath
} from '../../shared/data-migration'
import { DataMigrationErrorSchema } from '../../shared/data-migration'
import type { JsonSettingsStore } from '../settings-store'
import {
  applyPortableSettingsMigration,
  assertNoImportedTrustOrSecrets,
  importDisabledAutomations,
  importedWorkspaceTrustResets,
  restoreSemanticRendererState,
  type ImportedWorkspaceTrustReset,
  type RestoredRendererState
} from './application-state-migration'
import {
  DEFAULT_KUNPACK_INSPECTION_BUDGET,
  validateKunpackArchiveDirectory,
  validateKunpackLinkMetadata
} from './archive-security'
import { portableSettingsForMigration } from './export-inventory'
import {
  buildDataMigrationImportPlan,
  probeDestinationFileSystem,
  revalidateDataMigrationImportPlan
} from './import-planner'
import {
  DataMigrationImportTransactionCoordinator,
  type ImportApplicationMutationStep,
  type RuntimeMigrationCommitResult,
  type RuntimeMigrationTransactionClient,
  type StagedWorkspaceCommit
} from './import-transaction'
import { verifyKunpackPackage } from './kunpack-container'
import { extractZip64ArchiveEntries, readZip64Directory, readZip64EntryBuffer } from './kunpack-zip'
import type { MigrationJournalStore } from './transaction-journal'
import { stageWorkspaceImport } from './workspace-staging'

export type KunpackCatalogs = {
  workspaces: DataMigrationWorkspaceCatalogEntry[]
  threads: DataMigrationThreadCatalogEntry[]
  portableSettings?: unknown
  rendererState?: unknown
  automations?: unknown
}

export type DataMigrationPackageInspection = {
  inspectionId: string
  packagePath: string
  manifest: DataMigrationManifestV1
  entries: DataMigrationPackageEntry[]
  catalogs: KunpackCatalogs
  encrypted: boolean
  payloadSha256: string
  expandedBytes: number
  compressedBytes: number
  warnings: string[]
}

export interface KunRuntimeMigrationImportClient extends RuntimeMigrationTransactionClient {
  preflight(input: {
    operationId: string
    snapshotPath: string
    workspacePathMap: Record<string, string>
    configuredProviderIds: string[]
    signal?: AbortSignal
  }): Promise<{
    importId: string
    threadIdMap: Record<string, string>
    introducedThreadIds: string[]
    deduplicatedThreadIds: string[]
    recordCount: number
    warnings: string[]
  }>
}

export interface RendererMigrationStateAdapter {
  captureState(): Promise<RestoredRendererState>
  replaceState(state: RestoredRendererState): Promise<void>
  replaceTrustResets(workspaceRoots: string[], resets: ImportedWorkspaceTrustReset[]): Promise<void>
  captureTrustResets(workspaceRoots: string[]): Promise<ImportedWorkspaceTrustReset[]>
  refresh(): Promise<void>
}

export type DataMigrationImportRequest = {
  operationId: string
  inspection: DataMigrationPackageInspection
  plan: DataMigrationImportPlan
  passphrase?: string
  settingsStore: JsonSettingsStore
  runtime?: KunRuntimeMigrationImportClient
  renderer?: RendererMigrationStateAdapter
  signal?: AbortSignal
  onProgress?: (progress: DataMigrationProgress) => void
}

export async function readCatalogs(zipPath: string, entries: readonly DataMigrationPackageEntry[]): Promise<KunpackCatalogs> {
  const has = (path: string) => entries.some((entry) => entry.path === path)
  const read = async (path: string) => JSON.parse((await readZip64EntryBuffer(
    zipPath,
    parsePackageRelativePath(path),
    DATA_MIGRATION_MAX_METADATA_BYTES
  )).toString('utf8'))
  const workspaces = has('catalog/workspaces.json') ? await read('catalog/workspaces.json') : []
  const threads = has('catalog/threads.json') ? await read('catalog/threads.json') : []
  return {
    workspaces: DataMigrationWorkspaceCatalogEntrySchema.array().parse(workspaces),
    threads: DataMigrationThreadCatalogEntrySchema.array().parse(threads),
    ...(has('catalog/portable-settings.json') ? { portableSettings: await read('catalog/portable-settings.json') } : {}),
    ...(has('catalog/renderer-state.json') ? { rendererState: await read('catalog/renderer-state.json') } : {}),
    ...(has('catalog/automations.json') ? { automations: await read('catalog/automations.json') } : {})
  }
}

export function validateInspectionCatalogs(
  manifest: DataMigrationManifestV1,
  entries: readonly DataMigrationPackageEntry[],
  catalogs: KunpackCatalogs
): void {
  for (const [component, version] of Object.entries(manifest.componentVersions)) {
    if (version !== 1) {
      throw new Error(`migration component version is unsupported: ${component}@${version}`)
    }
  }
  const categories = new Set(manifest.selection.categories)
  if (
    (categories.has('attachments') || categories.has('artifacts') || categories.has('memory')) &&
    !categories.has('thread-history')
  ) {
    throw new Error('migration runtime content categories require thread history')
  }
  assertUnique(manifest.selection.categories, 'migration selection category')
  assertUnique(manifest.selection.workspaceIds, 'migration selected workspace')
  assertUnique(manifest.selection.threadIds, 'migration selected thread')
  const workspaceIds = new Set(catalogs.workspaces.map((workspace) => workspace.workspaceId))
  const threadIds = new Set(catalogs.threads.map((thread) => thread.exportThreadId))
  if (workspaceIds.size !== catalogs.workspaces.length || catalogs.workspaces.length !== manifest.counts.workspaces) {
    throw new Error('migration workspace catalog count or identity mismatch')
  }
  if (threadIds.size !== catalogs.threads.length || catalogs.threads.length !== manifest.counts.threads) {
    throw new Error('migration thread catalog count or identity mismatch')
  }
  if (
    workspaceIds.size !== manifest.selection.workspaceIds.length ||
    manifest.selection.workspaceIds.some((workspaceId) => !workspaceIds.has(workspaceId))
  ) {
    throw new Error('migration selected workspace identities do not match the workspace catalog')
  }
  if (!categories.has('thread-history') && catalogs.threads.length > 0) {
    throw new Error('migration package contains unselected thread history')
  }
  const selectedThreadIds = new Set(manifest.selection.threadIds)
  for (const thread of catalogs.threads) {
    if (!selectedThreadIds.has(thread.exportThreadId)) {
      throw new Error(`migration thread was not selected for export: ${thread.exportThreadId}`)
    }
    if (thread.workspaceId && !workspaceIds.has(thread.workspaceId)) {
      throw new Error(`migration thread references an unknown workspace: ${thread.exportThreadId}`)
    }
  }
  for (const workspace of catalogs.workspaces) {
    if (workspace.nestedUnderWorkspaceId && !workspaceIds.has(workspace.nestedUnderWorkspaceId)) {
      throw new Error(`migration workspace references an unknown parent: ${workspace.workspaceId}`)
    }
  }
  for (const workspace of catalogs.workspaces) {
    const owned = entries.filter((entry) =>
      entry.kind === 'workspace-file' && entry.ownerId === workspace.workspaceId
    )
    const logicalBytes = owned.reduce((total, entry) => total + entry.logicalBytes, 0)
    if (owned.length !== workspace.fileCount || logicalBytes !== workspace.logicalBytes) {
      throw new Error(`migration workspace catalog inventory mismatch: ${workspace.workspaceId}`)
    }
  }
  if (entries.some((entry) => entry.kind === 'workspace-file' && !entry.ownerId)) {
    throw new Error('migration workspace payload entry has no owner')
  }
  if (entries.some((entry) => entry.kind === 'workspace-file' && !workspaceIds.has(entry.ownerId!))) {
    throw new Error('migration workspace payload references an unknown owner')
  }
  for (const entry of entries.filter((item) => item.kind === 'workspace-file')) {
    const expectedPrefix = `payload/workspaces/${entry.ownerId}/files/`
    if (!entry.path.startsWith(expectedPrefix)) {
      throw new Error(`migration workspace payload path does not match its owner: ${entry.path}`)
    }
    if (entry.linkTarget) {
      const target = entries.find((candidate) => candidate.path === entry.linkTarget)
      if (
        !target ||
        target.kind !== 'workspace-file' ||
        target.ownerId !== entry.ownerId ||
        !target.path.startsWith(expectedPrefix)
      ) {
        throw new Error(`migration workspace link crosses its declared owner: ${entry.path}`)
      }
    }
  }
  if (!categories.has('workspace-files') && entries.some((entry) => entry.kind === 'workspace-file')) {
    throw new Error('migration package contains unselected workspace files')
  }
  const knownCatalogPaths = new Set([
    'catalog/workspaces.json',
    'catalog/threads.json',
    'catalog/portable-settings.json',
    'catalog/renderer-state.json',
    'catalog/automations.json'
  ])
  for (const entry of entries) {
    if (entry.kind === 'catalog') {
      if (!knownCatalogPaths.has(entry.path)) {
        throw new Error(`migration package contains an unsupported catalog: ${entry.path}`)
      }
      continue
    }
    if (entry.kind === 'workspace-file') continue
    if (entry.kind === 'runtime-record' && entry.path === 'payload/runtime/snapshot.jsonl' && !entry.linkTarget) continue
    throw new Error(`migration package contains an unsupported v1 payload entry: ${entry.path}`)
  }
  const entryAt = (path: string) => entries.find((entry) => entry.path === path)
  const hasCatalog = (path: string) => entryAt(path)?.kind === 'catalog'
  if (!hasCatalog('catalog/workspaces.json') || !hasCatalog('catalog/threads.json')) {
    throw new Error('migration package is missing its required workspace or thread catalog')
  }
  const runtimeEntry = entryAt('payload/runtime/snapshot.jsonl')
  if (runtimeEntry && runtimeEntry.kind !== 'runtime-record') {
    throw new Error('migration runtime snapshot has an invalid entry kind')
  }
  if (!categories.has('thread-history') && runtimeEntry) {
    throw new Error('migration package contains an unselected runtime snapshot')
  }
  if (manifest.counts.threads > 0 && !runtimeEntry) {
    throw new Error('migration package is missing selected runtime history')
  }
  if (manifest.counts.threads === 0 && runtimeEntry) {
    throw new Error('migration package contains runtime history without cataloged threads')
  }
  for (const [category, count] of [
    ['attachments', manifest.counts.attachments],
    ['artifacts', manifest.counts.artifacts],
    ['memory', manifest.counts.memories]
  ] as const) {
    if (!categories.has(category) && count > 0) {
      throw new Error(`migration manifest counts unselected ${category}`)
    }
  }
  const requireExactCatalog = (
    category: 'portable-settings' | 'renderer-state',
    path: string
  ) => {
    if (categories.has(category) !== hasCatalog(path)) {
      throw new Error(categories.has(category)
        ? `migration package is missing selected ${category} catalog`
        : `migration package contains unselected ${category} catalog`)
    }
  }
  requireExactCatalog('portable-settings', 'catalog/portable-settings.json')
  requireExactCatalog('renderer-state', 'catalog/renderer-state.json')
  const automationsSelected = categories.has('workflows') || categories.has('schedules')
  if (automationsSelected !== hasCatalog('catalog/automations.json')) {
    throw new Error(automationsSelected
      ? 'migration package is missing selected automations catalog'
      : 'migration package contains an unselected automations catalog')
  }
  if (catalogs.portableSettings !== undefined && asRecord(catalogs.portableSettings).schemaVersion !== 1) {
    throw new Error('migration portable settings catalog version is unsupported')
  }
  if (catalogs.rendererState !== undefined) {
    const rendererState = asRecord(catalogs.rendererState)
    if (
      rendererState.schemaVersion !== 1 ||
      !Object.prototype.hasOwnProperty.call(rendererState, 'value')
    ) {
      throw new Error('migration renderer state catalog is malformed or unsupported')
    }
  }
  if (catalogs.automations !== undefined) {
    const automations = asRecord(catalogs.automations)
    if (
      automations.schemaVersion !== 1 ||
      !Array.isArray(automations.workflows) ||
      !Array.isArray(automations.schedules)
    ) {
      throw new Error('migration automations catalog is malformed or unsupported')
    }
    if (!categories.has('workflows') && automations.workflows.length > 0) {
      throw new Error('migration automations catalog contains unselected workflows')
    }
    if (!categories.has('schedules') && automations.schedules.length > 0) {
      throw new Error('migration automations catalog contains unselected schedules')
    }
  }
}

export function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${label} is duplicated`)
}

export function conflictResolutions(plan: DataMigrationImportPlan, workspaceId: string) {
  return Object.fromEntries(plan.conflicts.flatMap((conflict) =>
    conflict.workspaceId === workspaceId && conflict.resolution ? [[conflict.path, conflict.resolution]] : []
  ))
}

export function renamedConflictPaths(plan: DataMigrationImportPlan, workspaceId: string) {
  return Object.fromEntries(plan.conflicts.flatMap((conflict) =>
    conflict.workspaceId === workspaceId && conflict.renamedPath ? [[conflict.path, conflict.renamedPath]] : []
  ))
}

export function withPreflightResult(
  client: KunRuntimeMigrationImportClient,
  preflight: Awaited<ReturnType<KunRuntimeMigrationImportClient['preflight']>>
): RuntimeMigrationTransactionClient {
  const enrich = (result: RuntimeMigrationCommitResult): RuntimeMigrationCommitResult => ({
    ...result,
    threadIdMap: preflight.threadIdMap,
    warnings: [...new Set([...preflight.warnings, ...result.warnings])],
    counts: {
      ...result.counts,
      deduplicatedThreads: preflight.deduplicatedThreadIds.length,
      introducedThreads: preflight.introducedThreadIds.length
    }
  })
  return {
    commit: async (importId) => enrich(await client.commit(importId)),
    verify: async (importId) => enrich(await client.verify(importId)),
    rollback: async (importId) => enrich(await client.rollback(importId)),
    ...(client.finalize ? { finalize: (importId: string) => client.finalize!(importId) } : {})
  }
}

export function mergeRendererStates(before: RestoredRendererState, imported: RestoredRendererState): RestoredRendererState {
  return {
    schemaVersion: 1,
    design: mergeSemanticArray(before.design, imported.design),
    write: mergeSemanticArray(before.write, imported.write),
    plans: mergeSemanticArray(before.plans, imported.plans),
    sdd: mergeSemanticArray(before.sdd, imported.sdd),
    forks: mergeSemanticArray(before.forks, imported.forks),
    threads: mergeSemanticArray(before.threads, imported.threads),
    composer: { ...before.composer, ...imported.composer },
    workspaces: mergeSemanticArray(before.workspaces, imported.workspaces),
    unresolvedReferences: [...before.unresolvedReferences, ...imported.unresolvedReferences]
  }
}

export function mergeSemanticArray(before: unknown[], imported: unknown[]): unknown[] {
  const values = new Map<string, unknown>()
  for (const value of [...before, ...imported]) values.set(semanticKey(value), value)
  return [...values.values()]
}

export function semanticKey(value: unknown): string {
  const record = asRecord(value)
  const id = ['id', 'threadId', 'draftId', 'workspaceRoot', 'path'].map((key) => record[key]).find((item) => typeof item === 'string')
  return typeof id === 'string' ? `${id}:${stateIdentity(value)}` : stateIdentity(value)
}

export function stateIdentity(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
}

export function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, canonical(child)]))
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

export function migrationIoErrorCode(error: unknown): 'SPACE_INSUFFICIENT' | 'IO_PERMISSION_DENIED' | 'PACKAGE_INTEGRITY_FAILED' {
  const code = (error as NodeJS.ErrnoException)?.code
  if (code === 'ENOSPC') return 'SPACE_INSUFFICIENT'
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return 'IO_PERMISSION_DENIED'
  return 'PACKAGE_INTEGRITY_FAILED'
}

export function safeMigrationError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, ' ').slice(0, 500) || 'migration staging failed'
}
