import { createReadStream, createWriteStream } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { rm, stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { dirname, join } from 'node:path'
import { dialog, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'
import type { AppSettingsV1 } from '../../shared/app-settings'
import {
  DataMigrationImportPlanSchema,
  DataMigrationEstimateSchema,
  DataMigrationInspectionSummarySchema,
  DataMigrationOperationStatusSchema,
  DataMigrationPackageEntrySchema,
  DataMigrationProgressSchema,
  DataMigrationReportSchema,
  DataMigrationSelectionSchema,
  DataMigrationWorkspaceConflictStrategySchema,
  type DataMigrationExportOptions,
  type DataMigrationInspectionSummary,
  type DataMigrationOperationStatus,
  type DataMigrationProgress,
  type DataMigrationRendererRequest,
  type DataMigrationRendererResponse,
  type DataMigrationReport
} from '../../shared/data-migration'
import type { JsonSettingsStore } from '../settings-store'
import type { RuntimeThreadForMigration, KunMigrationSnapshotClient } from './export-orchestrator'
import { DataMigrationExportOrchestrator } from './export-orchestrator'
import {
  DataMigrationImportOrchestrator,
  type DataMigrationPackageInspection,
  type KunRuntimeMigrationImportClient,
  type RendererMigrationStateAdapter
} from './import-orchestrator'
import { DataMigrationImportTransactionCoordinator, type RuntimeMigrationCommitResult } from './import-transaction'
import type { ImportApplicationMutationStep } from './import-transaction'
import { MigrationReportStore } from './migration-reports'
import { MigrationJournalStore, type MigrationJournalMutation } from './transaction-journal'
import {
  applyPortableSettingsMigration,
  type ImportedWorkspaceTrustReset,
  type RestoredRendererState
} from './application-state-migration'
import { portableSettingsForMigration } from './export-inventory'
import { reconstructStagedWorkspace } from './workspace-staging'
import { sha256File } from './kunpack-zip'
import {
  RendererMigrationRpc,
  assertTrustedDataMigrationSender,
  inspectionSummary,
  listRuntimeThreadsForMigration,
  publicMigrationError,
  recoveryApplicationStep,
  recoveryMutation,
  rendererStateAdapter,
  runtimeImportClient,
  runtimeSnapshotClient
} from './data-migration-controller-support'

export {
  assertTrustedDataMigrationSender,
  listRuntimeThreadsForMigration,
  publicMigrationError
} from './data-migration-controller-support'

const operationIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/)
const localPathSchema = z.string().min(1).max(32_767).refine((value) => !value.includes('\0'), 'path contains NUL')
const optionalPassphraseSchema = z.string().min(8).max(1_024).optional()

const exportOptionsSchema = z.object({
  operationId: operationIdSchema,
  outputPath: localPathSchema,
  selectedWorkspaceIds: z.array(operationIdSchema).max(10_000),
  selectedThreadIds: z.array(operationIdSchema).max(10_000),
  categories: DataMigrationSelectionSchema.shape.categories,
  preset: DataMigrationSelectionSchema.shape.preset,
  sensitiveContentAcknowledged: z.boolean(),
  unencryptedPackageAcknowledged: z.boolean(),
  passphrase: optionalPassphraseSchema,
  runningThreadPolicy: z.enum(['wait', 'interrupt', 'omit'])
}).strict()

const rendererResponseSchema = z.object({
  requestId: operationIdSchema,
  ok: z.boolean(),
  value: z.unknown().optional(),
  error: z.string().max(2_000).optional()
}).strict()

export type DataMigrationControllerOptions = {
  userDataPath: string
  store: JsonSettingsStore
  getMainWindow: () => BrowserWindow | null
  runtimeFetch: (path: string, init?: RequestInit & { duplex?: 'half' }) => Promise<Response>
  sourceInstallationId: string
  sourceAppVersion: string
  sourceRuntimeVersion: string
  featureEnabled: boolean
}

export class DataMigrationController {
  private readonly journals: MigrationJournalStore
  private readonly reports: MigrationReportStore
  private readonly transactions: DataMigrationImportTransactionCoordinator
  private readonly importer: DataMigrationImportOrchestrator
  private readonly exporter: DataMigrationExportOrchestrator
  private readonly rendererRpc: RendererMigrationRpc
  private readonly inspections = new Map<string, { inspection: DataMigrationPackageInspection; expiresAt: number }>()
  private active: { operationId: string; kind: 'export' | 'import'; abort: AbortController } | null = null
  private progress: DataMigrationProgress | undefined

  constructor(private readonly options: DataMigrationControllerOptions) {
    const migrationRoot = join(options.userDataPath, 'data-migration')
    this.journals = new MigrationJournalStore(join(migrationRoot, 'operations'))
    this.reports = new MigrationReportStore(join(migrationRoot, 'reports'))
    this.transactions = new DataMigrationImportTransactionCoordinator(this.journals, this.reports)
    this.importer = new DataMigrationImportOrchestrator(
      join(migrationRoot, 'temporary'),
      this.journals,
      this.transactions
    )
    this.exporter = new DataMigrationExportOrchestrator(runtimeSnapshotClient(options.runtimeFetch))
    this.rendererRpc = new RendererMigrationRpc(options.getMainWindow)
  }

  registerIpc(): void {
    const handle = <T>(channel: string, handler: (...args: unknown[]) => Promise<T>) => {
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, async (event, ...args) => {
        try {
          assertTrustedDataMigrationSender(event, this.options.getMainWindow)
          return await handler(...args)
        } catch (error) {
          throw new Error(publicMigrationError(error, this.progress?.phase))
        }
      })
    }
    handle('data-migration:pick-export', async (raw) => {
      const value = z.object({ defaultPath: z.string().optional() }).strict().parse(raw)
      const result = await dialog.showSaveDialog(this.windowOptions(), {
        title: 'Create migration package',
        defaultPath: value.defaultPath,
        filters: [{ name: 'Kun migration package', extensions: ['kunpack'] }]
      })
      return { canceled: result.canceled, path: result.filePath || null }
    })
    handle('data-migration:pick-import', async (raw) => {
      const value = z.object({ defaultPath: z.string().optional() }).strict().parse(raw)
      const result = await dialog.showOpenDialog(this.windowOptions(), {
        title: 'Select migration package',
        defaultPath: value.defaultPath,
        properties: ['openFile'],
        filters: [{ name: 'Kun migration package', extensions: ['kunpack'] }]
      })
      return { canceled: result.canceled, path: result.filePaths[0] ?? null }
    })
    handle('data-migration:pick-destination', async (raw) => {
      const value = z.object({ defaultPath: z.string().optional() }).strict().parse(raw)
      const result = await dialog.showOpenDialog(this.windowOptions(), {
        title: 'Choose imported workspace location',
        defaultPath: value.defaultPath,
        properties: ['openDirectory', 'createDirectory']
      })
      return { canceled: result.canceled, path: result.filePaths[0] ?? null }
    })
    handle('data-migration:estimate-export', async (raw) => this.estimateExport(raw))
    handle('data-migration:inspect', async (raw) => this.inspect(raw))
    handle('data-migration:plan-import', async (raw) => this.planImport(raw))
    handle('data-migration:start-export', async (raw) => this.startExport(raw))
    handle('data-migration:start-import', async (raw) => this.startImport(raw))
    handle('data-migration:cancel', async (raw) => {
      const { operationId } = z.object({ operationId: operationIdSchema }).strict().parse(raw)
      await this.cancel(operationId)
      return this.status()
    })
    handle('data-migration:recover', async (raw) => {
      const value = z.object({ operationId: operationIdSchema, action: z.enum(['resume', 'rollback']) }).strict().parse(raw)
      await this.recover(value.operationId, value.action)
      return this.status()
    })
    handle('data-migration:status', async () => this.status())
    handle('data-migration:reports:list', async () => this.reports.list())
    handle('data-migration:reports:get', async (raw) => {
      const { operationId } = z.object({ operationId: operationIdSchema }).strict().parse(raw)
      return this.reports.read(operationId)
    })
    handle('data-migration:reports:delete', async (raw) => {
      const { operationId } = z.object({ operationId: operationIdSchema }).strict().parse(raw)
      await this.reports.delete(operationId)
    })
    handle('data-migration:renderer-response', async (raw) => {
      this.rendererRpc.respond(rendererResponseSchema.parse(raw))
    })
  }

  async status(): Promise<DataMigrationOperationStatus> {
    this.expireInspections()
    const recoverable = await this.journals.listIncomplete()
    return DataMigrationOperationStatusSchema.parse({
      featureEnabled: this.options.featureEnabled,
      ...(this.active ? { activeOperationId: this.active.operationId, activeKind: this.active.kind } : {}),
      ...(this.progress ? { progress: this.progress } : {}),
      recoverable: recoverable.map((journal) => ({
        operationId: journal.operationId,
        packageId: journal.packageId,
        phase: journal.phase,
        updatedAt: journal.updatedAt,
        destinationEffect: journal.mutations.length > 0 ? 'partially-committed' : journal.phase === 'staged' ? 'staged-only' : 'untouched',
        ...(journal.error ? { error: journal.error } : {}),
        warnings: journal.warnings,
        manualRecoverySteps: journal.manualRecoverySteps,
        ...(journal.reportPath ? { reportPath: journal.reportPath } : {})
      })),
      recentReports: (await this.reports.list()).slice(0, 20)
    })
  }

  private async estimateExport(raw: unknown) {
    this.assertFeatureEnabled('export')
    const input = z.object({
      operationId: operationIdSchema,
      selectedWorkspaceIds: z.array(operationIdSchema),
      categories: DataMigrationSelectionSchema.shape.categories.default(['workspace-files']),
      preset: DataMigrationSelectionSchema.shape.preset,
      sensitiveContentAcknowledged: z.boolean()
    }).strict().parse(raw)
    const [settings, runtimeThreads] = await Promise.all([this.options.store.load(), this.listRuntimeThreads()])
    const inventory = await this.exporter.estimate({
      ...input,
      settings,
      runtimeThreads,
      onProgress: (progress) => this.publishProgress(progress)
    })
    return DataMigrationEstimateSchema.parse(inventory.estimate)
  }

  private async inspect(raw: unknown): Promise<DataMigrationInspectionSummary> {
    this.assertFeatureEnabled('import')
    const input = z.object({ packagePath: localPathSchema, passphrase: optionalPassphraseSchema }).strict().parse(raw)
    const inspection = await this.importer.inspect(input)
    this.inspections.set(inspection.inspectionId, { inspection, expiresAt: Date.now() + 30 * 60_000 })
    while (this.inspections.size > 5) this.inspections.delete(this.inspections.keys().next().value!)
    return inspectionSummary(inspection)
  }

  private async planImport(raw: unknown) {
    this.assertFeatureEnabled('import')
    const input = z.object({
      operationId: operationIdSchema,
      inspectionId: operationIdSchema,
      destinationBaseRoot: localPathSchema,
      destinationRoots: z.record(operationIdSchema, localPathSchema).optional(),
      strategies: z.record(operationIdSchema, DataMigrationWorkspaceConflictStrategySchema).optional(),
      skippedWorkspaceIds: z.array(operationIdSchema).optional()
    }).strict().parse(raw)
    const inspection = this.mustInspection(input.inspectionId)
    return this.importer.plan({
      operationId: input.operationId,
      inspection,
      destinationBaseRoot: input.destinationBaseRoot,
      ...(input.destinationRoots ? { destinationRoots: input.destinationRoots } : {}),
      ...(input.strategies ? { strategies: input.strategies } : {}),
      ...(input.skippedWorkspaceIds ? { skippedWorkspaceIds: new Set(input.skippedWorkspaceIds) } : {})
    })
  }

  private async startExport(raw: unknown): Promise<{ packagePath: string; report: DataMigrationReport }> {
    this.assertFeatureEnabled('export')
    const input = exportOptionsSchema.parse(raw) as DataMigrationExportOptions
    return this.runOperation(input.operationId, 'export', async (signal) => {
      const [settings, runtimeThreads, rendererState] = await Promise.all([
        this.options.store.load(),
        this.listRuntimeThreads(),
        input.categories.includes('renderer-state') ? this.rendererRpc.request('capture-state') : undefined
      ])
      const result = await this.exporter.export({
        ...input,
        settings,
        runtimeThreads,
        rendererState,
        sourceInstallationId: this.options.sourceInstallationId,
        sourceAppVersion: this.options.sourceAppVersion,
        sourceRuntimeVersion: this.options.sourceRuntimeVersion,
        signal,
        onProgress: (progress) => this.publishProgress(progress)
      })
      await this.reports.writeImmutable(result.report)
      return { packagePath: result.packagePath, report: DataMigrationReportSchema.parse(result.report) }
    })
  }

  private async startImport(raw: unknown): Promise<{ report: DataMigrationReport; refreshRequired: boolean }> {
    this.assertFeatureEnabled('import')
    const input = z.object({
      operationId: operationIdSchema,
      inspectionId: operationIdSchema,
      packagePath: localPathSchema,
      passphrase: optionalPassphraseSchema,
      plan: DataMigrationImportPlanSchema
    }).strict().parse(raw)
    const inspection = this.mustInspection(input.inspectionId)
    if (inspection.packagePath !== input.packagePath) throw new Error('migration package path differs from the inspected file')
    return this.runOperation(input.operationId, 'import', async (signal) => this.importer.import({
      operationId: input.operationId,
      inspection,
      plan: input.plan,
      ...(input.passphrase ? { passphrase: input.passphrase } : {}),
      settingsStore: this.options.store,
      runtime: runtimeImportClient(this.options.runtimeFetch),
      renderer: rendererStateAdapter(this.rendererRpc),
      signal,
      onProgress: (progress) => this.publishProgress(progress)
    }))
  }

  private async cancel(operationId: string): Promise<void> {
    if (this.active?.operationId === operationId) {
      if (this.active.kind === 'import') await this.transactions.requestCancellation(operationId).catch(() => undefined)
      this.active.abort.abort(new Error('migration cancellation requested'))
      return
    }
    const journal = await this.journals.read(operationId)
    if (journal.phase === 'inspected') await this.transactions.requestCancellation(operationId)
  }

  private async recover(operationId: string, action: 'resume' | 'rollback'): Promise<void> {
    const journal = await this.journals.read(operationId)
    if (action === 'resume') {
      if (journal.phase === 'inspected') {
        throw new Error('This import stopped before staging was complete. Roll it back, then select the original package again; encrypted passphrases are never stored.')
      }
      if (journal.phase !== 'staged' && journal.phase !== 'committing' && journal.phase !== 'verifying') {
        throw new Error(`migration import cannot resume during ${journal.phase}; roll it back instead`)
      }
      await this.runOperation(operationId, 'import', async () => {
        const workspaces = await this.recoverStagedWorkspaces(operationId)
        const runtimeArtifact = await this.journals.readArtifact<{
          preflight?: { importId?: string }
        }>(operationId, 'runtime-preflight.json').catch(() => null)
        const runtimeImportId = runtimeArtifact?.preflight?.importId
        const applicationSteps = await this.recoverApplicationSteps(operationId)
        await this.transactions.commit({
          operationId,
          workspaces,
          ...(runtimeImportId ? { runtime: { importId: runtimeImportId, client: runtimeImportClient(this.options.runtimeFetch) } } : {}),
          applicationSteps,
          initialWarnings: journal.warnings,
          onRefresh: () => this.rendererRpc.request('refresh').then(() => undefined)
        })
      })
      return
    }
    if (journal.phase === 'inspected') {
      for (const mapping of journal.plan.mappings) {
        if (!mapping.destinationRoot) continue
        const stagingRoot = join(dirname(mapping.destinationRoot), `.kun-migration-staging-${operationId}-${mapping.workspaceId}`)
        await rm(stagingRoot, { recursive: true, force: true })
      }
      await this.transactions.requestCancellation(operationId)
      return
    }
    await this.transactions.rollback({
      operationId,
      runtime: { client: runtimeImportClient(this.options.runtimeFetch) },
      resolveApplicationStep: async (mutation) => recoveryApplicationStep(mutation, this.options.store, this.rendererRpc, this.journals, operationId)
    })
  }

  private async recoverStagedWorkspaces(operationId: string) {
    const journal = await this.journals.read(operationId)
    const artifact = await this.journals.readArtifact<{
      workspaces?: Array<{ workspaceId?: string; entries?: unknown[] }>
    }>(operationId, 'workspace-staging.json')
    const byId = new Map((artifact.workspaces ?? []).flatMap((workspace) =>
      typeof workspace.workspaceId === 'string' && Array.isArray(workspace.entries)
        ? [[workspace.workspaceId, workspace.entries.map((entry) => DataMigrationPackageEntrySchema.parse(entry))] as const]
        : []
    ))
    return journal.plan.mappings.flatMap((mapping) => {
      if (mapping.strategy === 'skip' || !mapping.destinationRoot) return []
      const entries = byId.get(mapping.workspaceId)
      if (!entries) throw new Error(`staged workspace recovery metadata is missing: ${mapping.workspaceId}`)
      return [{
        workspaceId: mapping.workspaceId,
        staged: reconstructStagedWorkspace({ operationId, workspaceId: mapping.workspaceId, entries, destinationRoot: mapping.destinationRoot }),
        strategy: mapping.strategy,
        resolutions: Object.fromEntries(journal.plan.conflicts.flatMap((conflict) =>
          conflict.workspaceId === mapping.workspaceId && conflict.resolution ? [[conflict.path, conflict.resolution]] : []
        )),
        renamedPaths: Object.fromEntries(journal.plan.conflicts.flatMap((conflict) =>
          conflict.workspaceId === mapping.workspaceId && conflict.renamedPath ? [[conflict.path, conflict.renamedPath]] : []
        ))
      }]
    })
  }

  private async recoverApplicationSteps(operationId: string): Promise<ImportApplicationMutationStep[]> {
    const journal = await this.journals.read(operationId)
    const candidates: MigrationJournalMutation[] = [
      recoveryMutation('settings:portable-and-automations:operation:0', 'settings', 'portable-and-disabled-automations', 'settings-restore.json'),
      recoveryMutation('renderer-state:semantic-restore:operation:0', 'renderer-state', 'semantic-restore', 'renderer-state-restore.json'),
      recoveryMutation('trust:reset-imported-workspaces:operation:0', 'trust', 'reset-imported-workspaces', 'trust-restore.json')
    ]
    const steps: ImportApplicationMutationStep[] = []
    for (const candidate of candidates) {
      const mutation = journal.mutations.find((item) => item.mutationId === candidate.mutationId) ?? candidate
      const step = await recoveryApplicationStep(mutation, this.options.store, this.rendererRpc, this.journals, operationId).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null
        throw error
      })
      if (step) steps.push(step)
    }
    return steps
  }

  private async listRuntimeThreads(): Promise<RuntimeThreadForMigration[]> {
    return listRuntimeThreadsForMigration(this.options.runtimeFetch)
  }

  private async runOperation<T>(operationId: string, kind: 'export' | 'import', task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.active) throw new Error(`another migration operation is active: ${this.active.operationId}`)
    const recoverable = await this.journals.listIncomplete()
    const blocking = recoverable.find((journal) => journal.operationId !== operationId)
    if (blocking) throw new Error(`migration recovery is required before starting another operation: ${blocking.operationId}`)
    const abort = new AbortController()
    this.progress = undefined
    this.active = { operationId, kind, abort }
    try {
      return await task(abort.signal)
    } finally {
      this.active = null
    }
  }

  private publishProgress(progress: DataMigrationProgress): void {
    this.progress = DataMigrationProgressSchema.parse(progress)
    const window = this.options.getMainWindow()
    if (window && !window.isDestroyed()) window.webContents.send('data-migration:progress', this.progress)
  }

  private mustInspection(inspectionId: string): DataMigrationPackageInspection {
    this.expireInspections()
    const item = this.inspections.get(inspectionId)
    if (!item) throw new Error('migration inspection expired; inspect the package again')
    return item.inspection
  }

  private expireInspections(): void {
    for (const [id, value] of this.inspections) if (value.expiresAt <= Date.now()) this.inspections.delete(id)
  }

  private assertFeatureEnabled(kind: 'export' | 'import'): void {
    if (!this.options.featureEnabled) throw new Error(`data migration ${kind} is disabled by the current release policy`)
  }

  private windowOptions(): BrowserWindow {
    const window = this.options.getMainWindow()
    if (!window || window.isDestroyed()) throw new Error('main window is unavailable')
    return window
  }
}
