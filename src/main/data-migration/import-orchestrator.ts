import { createHash, randomUUID } from 'node:crypto'
import {
  asRecord,
  conflictResolutions,
  mergeRendererStates,
  migrationIoErrorCode,
  readCatalogs,
  renamedConflictPaths,
  safeMigrationError,
  stateIdentity,
  validateInspectionCatalogs,
  withPreflightResult
} from './import-orchestrator-support'

export { validateInspectionCatalogs } from './import-orchestrator-support'
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

export class DataMigrationImportOrchestrator {
  constructor(
    private readonly temporaryRoot: string,
    private readonly journals: MigrationJournalStore,
    private readonly transactions: DataMigrationImportTransactionCoordinator
  ) {}

  async inspect(input: {
    packagePath: string
    passphrase?: string
    signal?: AbortSignal
  }): Promise<DataMigrationPackageInspection> {
    input.signal?.throwIfAborted()
    const inspectionId = `inspect_${randomUUID().replaceAll('-', '')}`
    const root = join(this.temporaryRoot, inspectionId)
    const zipPath = join(root, 'payload.zip')
    await mkdir(root, { recursive: true, mode: 0o700 })
    try {
      const verified = await verifyKunpackPackage({
        packagePath: input.packagePath,
        materializedZipPath: zipPath,
        cleanupMaterialized: false,
        ...(input.passphrase ? { passphrase: input.passphrase } : {})
      })
      const directory = await readZip64Directory(zipPath)
      validateKunpackArchiveDirectory(directory, verified.entries, DEFAULT_KUNPACK_INSPECTION_BUDGET)
      validateKunpackLinkMetadata(verified.entries)
      const catalogs = await readCatalogs(zipPath, verified.entries)
      validateInspectionCatalogs(verified.manifest, verified.entries, catalogs)
      assertNoImportedTrustOrSecrets({
        portableSettings: catalogs.portableSettings,
        rendererState: catalogs.rendererState,
        automations: catalogs.automations
      })
      return {
        inspectionId,
        packagePath: input.packagePath,
        manifest: verified.manifest,
        entries: verified.entries,
        catalogs,
        encrypted: verified.header.encryption.mode === 'passphrase',
        payloadSha256: verified.header.plainPayloadSha256,
        expandedBytes: verified.manifest.expandedBytes,
        compressedBytes: directory.reduce((total, entry) => total + entry.compressedBytes, 0),
        warnings: verified.header.encryption.mode === 'none'
          ? ['This unencrypted package has integrity protection but no sender authenticity.']
          : []
      }
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  async plan(input: {
    operationId: string
    inspection: DataMigrationPackageInspection
    destinationBaseRoot: string
    destinationRoots?: Readonly<Record<string, string | undefined>>
    strategies?: Parameters<typeof buildDataMigrationImportPlan>[0]['strategies']
    skippedWorkspaceIds?: ReadonlySet<string>
  }): Promise<DataMigrationImportPlan> {
    return buildDataMigrationImportPlan({
      operationId: input.operationId,
      packageId: input.inspection.manifest.packageId,
      inspectedAt: new Date().toISOString(),
      sourcePlatform: input.inspection.manifest.sourcePlatform,
      encrypted: input.inspection.encrypted,
      workspaces: input.inspection.catalogs.workspaces,
      entries: input.inspection.entries,
      destinationBaseRoot: input.destinationBaseRoot,
      ...(input.destinationRoots ? { destinationRoots: input.destinationRoots } : {}),
      ...(input.strategies ? { strategies: input.strategies } : {}),
      ...(input.skippedWorkspaceIds ? { skippedWorkspaceIds: input.skippedWorkspaceIds } : {})
    })
  }

  async import(input: DataMigrationImportRequest): Promise<{ report: DataMigrationReport; refreshRequired: boolean }> {
    input.signal?.throwIfAborted()
    if (input.plan.operationId !== input.operationId) throw new Error('migration plan operation id mismatch')
    if (input.plan.packageId !== input.inspection.manifest.packageId) throw new Error('migration plan package id mismatch')
    const plan = await revalidateDataMigrationImportPlan({
      plan: input.plan,
      packageId: input.inspection.manifest.packageId,
      sourcePlatform: input.inspection.manifest.sourcePlatform,
      encrypted: input.inspection.encrypted,
      workspaces: input.inspection.catalogs.workspaces,
      entries: input.inspection.entries
    })
    if (
      plan.fatalIssueCount > 0 ||
      plan.conflicts.some((conflict) => !conflict.resolution) ||
      plan.mappings.some((mapping) => mapping.strategy !== 'skip' && !mapping.compatible)
    ) {
      throw new Error('migration plan contains unresolved fatal or incompatible targets')
    }
    const authoritativeInput: DataMigrationImportRequest = { ...input, plan }
    await this.transactions.begin(plan)
    const operationRoot = this.journals.operationDirectory(input.operationId)
    const zipPath = join(operationRoot, 'payload.zip')
    const stagedWorkspaces: StagedWorkspaceCommit[] = []
    let runtimeImport: { importId: string; client: RuntimeMigrationTransactionClient } | undefined
    let runtimePreflight: Awaited<ReturnType<KunRuntimeMigrationImportClient['preflight']>> | undefined
    try {
      this.progress(input, 'staging', 0, 0, true)
      const verified = await verifyKunpackPackage({
        packagePath: input.inspection.packagePath,
        materializedZipPath: zipPath,
        cleanupMaterialized: false,
        ...(input.passphrase ? { passphrase: input.passphrase } : {})
      })
      if (
        verified.manifest.packageId !== plan.packageId ||
        verified.header.plainPayloadSha256 !== input.inspection.payloadSha256
      ) {
        throw new Error('migration package changed after inspection')
      }
      const workspacePathMap: Record<string, string> = {}
      for (const mapping of plan.mappings) {
        input.signal?.throwIfAborted()
        if (mapping.strategy === 'skip' || !mapping.destinationRoot) continue
        const catalog = input.inspection.catalogs.workspaces.find((workspace) => workspace.workspaceId === mapping.workspaceId)
        if (!catalog) throw new Error(`migration workspace catalog is missing: ${mapping.workspaceId}`)
        const probe = await probeDestinationFileSystem(join(mapping.destinationRoot, '..'))
        const staged = await stageWorkspaceImport({
          operationId: input.operationId,
          workspaceId: mapping.workspaceId,
          archivePath: zipPath,
          entries: input.inspection.entries,
          destinationRoot: mapping.destinationRoot,
          destinationPlatform: probe.platform,
          supportsSymbolicLinks: probe.supportsSymbolicLinks,
          signal: input.signal,
          onProgress: ({ path, bytes, entries }) => this.progress(input, 'staging', entries, bytes, true, path)
        })
        stagedWorkspaces.push({
          workspaceId: mapping.workspaceId,
          staged,
          strategy: mapping.strategy,
          resolutions: conflictResolutions(plan, mapping.workspaceId),
          renamedPaths: renamedConflictPaths(plan, mapping.workspaceId)
        })
        workspacePathMap[catalog.sourcePathDisplay] = mapping.destinationRoot
      }

      const settings = await input.settingsStore.load()
      const runtimeEntry = input.inspection.entries.find((entry) => entry.path === 'payload/runtime/snapshot.jsonl')
      if (runtimeEntry && input.runtime) {
        const runtimeRoot = join(operationRoot, 'runtime')
        const runtimeSnapshotPath = join(runtimeRoot, 'snapshot.jsonl')
        await extractZip64ArchiveEntries({
          archivePath: zipPath,
          destinationRoot: runtimeRoot,
          entries: [runtimeEntry],
          destinationPath: () => runtimeSnapshotPath,
          signal: input.signal
        })
        runtimePreflight = await input.runtime.preflight({
          operationId: input.operationId,
          snapshotPath: runtimeSnapshotPath,
          workspacePathMap,
          configuredProviderIds: settings.provider.providers.map((provider) => provider.id),
          signal: input.signal
        })
        const runtimeClient = withPreflightResult(input.runtime, runtimePreflight)
        runtimeImport = { importId: runtimePreflight.importId, client: runtimeClient }
        await this.journals.writeArtifact(input.operationId, 'runtime-preflight.json', {
          snapshotPath: runtimeSnapshotPath,
          workspacePathMap,
          configuredProviderIds: settings.provider.providers.map((provider) => provider.id),
          preflight: runtimePreflight
        })
      } else if (runtimeEntry) {
        throw new Error('Kun runtime import client is unavailable for this package')
      }

      const applicationSteps = await this.applicationSteps({
        input: authoritativeInput,
        settings,
        workspacePathMap,
        threadIdMap: runtimePreflight?.threadIdMap ?? {}
      })
      await this.journals.writeArtifact(input.operationId, 'workspace-staging.json', {
        workspaces: stagedWorkspaces.map((workspace) => ({
          workspaceId: workspace.workspaceId,
          entries: workspace.staged.files.map((file) => file.entry)
        }))
      })
      await this.transactions.markStaged(input.operationId)
      const result = await this.transactions.commit({
        operationId: input.operationId,
        workspaces: stagedWorkspaces,
        ...(runtimeImport ? { runtime: runtimeImport } : {}),
        applicationSteps,
        initialWarnings: [...input.inspection.warnings, ...(runtimePreflight?.warnings ?? [])],
        onRefresh: input.renderer ? () => input.renderer!.refresh() : undefined
      })
      this.progress(input, result.journal.phase === 'completed' ? 'completed' : 'failed', 1, input.inspection.expandedBytes, false)
      return { report: result.report, refreshRequired: Boolean(input.renderer) }
    } catch (error) {
      await Promise.all(stagedWorkspaces.map((workspace) =>
        rm(workspace.staged.stagingRoot, { recursive: true, force: true }).catch(() => undefined)
      ))
      const journal = await this.journals.read(input.operationId).catch(() => null)
      if (journal?.phase === 'inspected') {
        if (input.signal?.aborted) {
          await this.journals.setPhase(input.operationId, 'cancelled')
        } else {
          await this.journals.setPhase(input.operationId, 'failed', {
            outcome: 'failed',
            error: DataMigrationErrorSchema.parse({
              code: migrationIoErrorCode(error),
              phase: 'staging',
              message: safeMigrationError(error),
              destinationEffect: stagedWorkspaces.length > 0 ? 'staged-only' : 'untouched',
              retryable: true,
              nextActions: ['Review destination permissions and free space, then retry the import.']
            })
          })
        }
      }
      throw error
    } finally {
      await rm(zipPath, { force: true }).catch(() => undefined)
    }
  }

  private async applicationSteps(input: {
    input: DataMigrationImportRequest
    settings: AppSettingsV1
    workspacePathMap: Record<string, string>
    threadIdMap: Record<string, string>
  }): Promise<ImportApplicationMutationStep[]> {
    const steps: ImportApplicationMutationStep[] = []
    const importedPortable = input.input.inspection.catalogs.portableSettings
    const importedAutomations = input.input.inspection.catalogs.automations
    if (importedPortable !== undefined || importedAutomations !== undefined) {
      const importedAt = new Date().toISOString()
      let next = importedPortable === undefined
        ? input.settings
        : applyPortableSettingsMigration(input.settings, importedPortable)
      if (importedAutomations !== undefined) {
        next = importDisabledAutomations({
          current: next,
          automations: importedAutomations,
          workspacePathMap: input.workspacePathMap,
          nowIso: importedAt
        })
      }
      const beforePortable = portableSettingsForMigration(input.settings)
      const afterPortable = portableSettingsForMigration(next)
      const introducedWorkflowIds = next.workflow.workflows
        .filter((workflow) => !input.settings.workflow.workflows.some((current) => current.id === workflow.id))
        .map((workflow) => workflow.id)
      const introducedScheduleIds = next.schedule.tasks
        .filter((task) => !input.settings.schedule.tasks.some((current) => current.id === task.id))
        .map((task) => task.id)
      await this.journals.writeArtifact(input.input.operationId, 'settings-restore.json', {
        beforePortable,
        afterPortable,
        introducedWorkflowIds,
        introducedScheduleIds,
        introducedWorkflows: next.workflow.workflows.filter((workflow) => introducedWorkflowIds.includes(workflow.id)),
        introducedSchedules: next.schedule.tasks.filter((task) => introducedScheduleIds.includes(task.id))
      })
      steps.push({
        mutationId: 'settings:portable-and-automations:operation:0',
        target: 'settings',
        action: 'portable-and-disabled-automations',
        expectedBeforeIdentity: stateIdentity({ beforePortable, workflowIds: input.settings.workflow.workflows.map((item) => item.id), scheduleIds: input.settings.schedule.tasks.map((item) => item.id) }),
        expectedAfterIdentity: stateIdentity({ afterPortable, introducedWorkflowIds, introducedScheduleIds }),
        details: { artifact: 'settings-restore.json' },
        apply: async () => {
          await input.input.settingsStore.update((current) => {
            let committed = importedPortable === undefined
              ? current
              : applyPortableSettingsMigration(current, importedPortable)
            if (importedAutomations !== undefined) {
              committed = importDisabledAutomations({
                current: committed,
                automations: importedAutomations,
                workspacePathMap: input.workspacePathMap,
                nowIso: importedAt
              })
            }
            return committed
          })
        },
        verify: async () => {
          const current = await input.input.settingsStore.load()
          if (stateIdentity(portableSettingsForMigration(current)) !== stateIdentity(afterPortable)) {
            throw new Error('portable settings verification failed after migration import completed')
          }
          if (introducedWorkflowIds.some((id) => current.workflow.workflows.find((item) => item.id === id)?.enabled !== false)) {
            throw new Error('imported workflow unexpectedly became active')
          }
          if (introducedScheduleIds.some((id) => current.schedule.tasks.find((item) => item.id === id)?.enabled !== false)) {
            throw new Error('imported schedule unexpectedly became active')
          }
        },
        rollback: async () => {
          const warnings = new Set<string>()
          await input.input.settingsStore.update((current) => {
            const portableUnchanged = stateIdentity(portableSettingsForMigration(current)) === stateIdentity(afterPortable)
            if (!portableUnchanged) warnings.add('Preserved portable settings modified after import; restore them manually if needed.')
            const workflowIdsToRemove = new Set(introducedWorkflowIds.filter((id) => {
              const workflow = current.workflow.workflows.find((item) => item.id === id)
              if (workflow?.enabled || workflow?.callableByAgent) {
                warnings.add(`Preserved independently activated imported workflow: ${id}`)
                return false
              }
              return Boolean(workflow)
            }))
            const scheduleIdsToRemove = new Set(introducedScheduleIds.filter((id) => {
              const task = current.schedule.tasks.find((item) => item.id === id)
              if (task?.enabled) {
                warnings.add(`Preserved independently activated imported schedule: ${id}`)
                return false
              }
              return Boolean(task)
            }))
            const restoredPortable = portableUnchanged
              ? applyPortableSettingsMigration(current, beforePortable)
              : current
            return {
              ...restoredPortable,
              workflow: {
                ...restoredPortable.workflow,
                workflows: restoredPortable.workflow.workflows.filter((item) => !workflowIdsToRemove.has(item.id))
              },
              schedule: {
                ...restoredPortable.schedule,
                tasks: restoredPortable.schedule.tasks.filter((item) => !scheduleIdsToRemove.has(item.id))
              }
            }
          })
          return [...warnings]
        }
      })
    }

    if (input.input.renderer && input.input.inspection.catalogs.rendererState !== undefined) {
      const catalog = asRecord(input.input.inspection.catalogs.rendererState)
      const imported = restoreSemanticRendererState({
        state: catalog.value,
        workspacePathMap: input.workspacePathMap,
        threadIdMap: input.threadIdMap,
        sourcePlatform: input.input.inspection.manifest.sourcePlatform
      })
      const before = await input.input.renderer.captureState()
      const after = mergeRendererStates(before, imported)
      await this.journals.writeArtifact(input.input.operationId, 'renderer-state-restore.json', { before, after })
      steps.push({
        mutationId: 'renderer-state:semantic-restore:operation:0',
        target: 'renderer-state',
        action: 'semantic-restore',
        expectedBeforeIdentity: stateIdentity(before),
        expectedAfterIdentity: stateIdentity(after),
        details: { artifact: 'renderer-state-restore.json' },
        apply: () => input.input.renderer!.replaceState(after),
        verify: async () => {
          if (stateIdentity(await input.input.renderer!.captureState()) !== stateIdentity(after)) {
            throw new Error('renderer semantic state verification failed after migration import completed')
          }
        },
        rollback: async () => {
          const current = await input.input.renderer!.captureState()
          if (stateIdentity(current) !== stateIdentity(after)) {
            return ['Preserved renderer state modified after import; restore registries manually if needed.']
          }
          await input.input.renderer!.replaceState(before)
          return []
        }
      })
    }

    if (input.input.renderer) {
      const workspaceRoots = Object.values(input.workspacePathMap)
      const beforeTrust = await input.input.renderer.captureTrustResets(workspaceRoots)
      const afterTrust = importedWorkspaceTrustResets(workspaceRoots)
      await this.journals.writeArtifact(input.input.operationId, 'trust-restore.json', { beforeTrust, afterTrust })
      steps.push({
        mutationId: 'trust:reset-imported-workspaces:operation:0',
        target: 'trust',
        action: 'reset-imported-workspaces',
        expectedBeforeIdentity: stateIdentity(beforeTrust),
        expectedAfterIdentity: stateIdentity(afterTrust),
        details: { artifact: 'trust-restore.json' },
        apply: () => input.input.renderer!.replaceTrustResets(workspaceRoots, afterTrust),
        verify: async () => {
          if (stateIdentity(await input.input.renderer!.captureTrustResets(workspaceRoots)) !== stateIdentity(afterTrust)) {
            throw new Error('imported workspace trust reset verification failed')
          }
        },
        rollback: async () => {
          const current = await input.input.renderer!.captureTrustResets(workspaceRoots)
          if (stateIdentity(current) !== stateIdentity(afterTrust)) {
            return ['Preserved workspace trust state modified after import.']
          }
          await input.input.renderer!.replaceTrustResets(workspaceRoots, beforeTrust)
          return []
        }
      })
    }
    return steps
  }

  private progress(
    input: Pick<DataMigrationImportRequest, 'operationId' | 'onProgress'>,
    phase: DataMigrationProgress['phase'],
    completedItems: number,
    completedBytes: number,
    cancellable: boolean,
    currentPath?: PackageRelativePath
  ): void {
    input.onProgress?.({
      operationId: input.operationId,
      kind: 'import',
      phase,
      completedItems,
      completedBytes,
      ...(currentPath ? { currentPath } : {}),
      cancellable,
      ...(cancellable ? { cancellationEffect: phase === 'staging' ? 'cleanup' : 'rollback' } : {}),
      updatedAt: new Date().toISOString()
    })
  }
}
