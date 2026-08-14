import { createHash, randomUUID } from 'node:crypto'
import {
  constants,
  createReadStream
} from 'node:fs'
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  utimes,
  writeFile
} from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  STORAGE_RELOCATION_SCHEMA_VERSION,
  STORAGE_RELOCATION_PROGRESS_MESSAGE_MAX_LENGTH,
  StorageRelocationOperationJournalSchema,
  StorageRelocationPreflightPlanSchema,
  StorageRelocationProgressSchema,
  StorageRelocationStatusSchema,
  isStorageRelocationPhaseTransitionAllowed,
  storageRelocationRequiredBytes,
  type StorageRelocationActiveWork,
  type StorageRelocationError,
  type StorageRelocationOperationJournal,
  type StorageRelocationPhase,
  type StorageRelocationPreflightPlan,
  type StorageRelocationProgress,
  type StorageRelocationReport,
  type StorageRelocationRoot,
  type StorageRelocationRootName,
  type StorageRelocationStatus
} from '../../shared/storage-relocation'
import {
  STORAGE_RELOCATION_OWNERSHIP_MARKER,
  STORAGE_RELOCATION_ROOT_NAMES,
  backupRootPath,
  copyWindowsAcls,
  hardenStorageDestinationAcl,
  inspectStorageRoot,
  inspectWindowsVolume,
  stagingRootPath,
  storageLogicalRoot,
  targetRootPath,
  uniqueSourceBytes,
  validateDestinationPath,
  type StorageRelocationVolumeInfo,
  type StorageTreeInventory
} from './paths'
import {
  StorageRelocationStore,
  type StorageRelocationLocationRecord
} from './store'

import { StorageRelocationEngineCore } from './engine-core'
import {
  assertEmptyOrMissing,
  createDirectoryLink,
  errorMessage,
  normalizeEngineError,
  progressFromJournal,
  relocationError,
  relocationErrorValue
} from './engine-support'
export type { StorageRelocationEngineOptions } from './engine-core'

export class StorageRelocationEngine extends StorageRelocationEngineCore {
  async hasPendingOperation(): Promise<boolean> {
    return Boolean(await this.store.activeOperationId())
  }

  async status(): Promise<StorageRelocationStatus> {
    const supported = this.platform === 'win32'
    const location = await this.store.readLocation()
    const roots = await this.inspectRoots(location)
    const pendingId = await this.store.activeOperationId()
    const recentReport = await this.store.latestReport()
    let invalidMetadata = this.store.metadataIsInvalid()
    let pendingJournal: StorageRelocationOperationJournal | null = null
    if (pendingId) {
      try {
        pendingJournal = await this.store.readJournal(pendingId)
        await this.validateJournal(pendingJournal)
      } catch {
        invalidMetadata = true
      }
    }
    let state: StorageRelocationStatus['state'] = supported ? 'default' : 'unsupported'
    let recoveryRequired = false
    if (invalidMetadata && supported) {
      state = 'broken'
      recoveryRequired = true
    }
    if (location) {
      const broken = roots.some((root) =>
        root.name === '.kun' &&
        (!root.exists || !root.junction || !root.appOwned)
      )
      state = broken ? 'broken' : 'relocated'
      recoveryRequired = broken
      if (invalidMetadata) {
        state = 'broken'
        recoveryRequired = true
      }
    }
    if (pendingId) {
      state = invalidMetadata ? 'broken' : 'pending'
      recoveryRequired = true
      if (!this.progress && pendingJournal) {
        this.progress = progressFromJournal(pendingJournal, this.now())
      }
    }
    return StorageRelocationStatusSchema.parse({
      supported,
      enabled: supported && this.options.featureEnabled,
      platform: this.platform,
      state,
      roots,
      totalUniqueBytes: uniqueSourceBytes(roots),
      ...(location ? { currentDestinationRoot: location.destinationRoot } : {}),
      ...(this.progress ? { pending: this.progress } : {}),
      ...(recentReport ? { recentReport } : {}),
      ...(invalidMetadata
        ? { disabledReason: 'Storage relocation metadata is invalid. Kun will not start normal services until it is repaired.' }
        : !supported
        ? { disabledReason: 'Storage relocation is currently available on Windows only.' }
        : !this.options.featureEnabled
          ? { disabledReason: 'Storage relocation is disabled in this build.' }
          : {}),
      recoveryRequired
    })
  }

  async preflightMove(destinationRoot: string): Promise<StorageRelocationPreflightPlan> {
    this.assertNewOperationAllowed()
    const destination = validateDestinationPath({
      destinationRoot,
      homeDir: this.options.homeDir,
      userDataPath: this.options.userDataPath,
      installPath: this.options.installPath
    })
    await assertEmptyOrMissing(destination)
    return this.createPlan('move', destination)
  }

  async preflightRestoreDefault(): Promise<StorageRelocationPreflightPlan> {
    this.assertNewOperationAllowed()
    const location = await this.store.readLocation()
    if (!location) throw relocationError('invalid_destination', 'Kun data is already in the default location.')
    const destination = validateDestinationPath({
      destinationRoot: this.options.homeDir,
      homeDir: this.options.homeDir,
      userDataPath: this.options.userDataPath,
      installPath: this.options.installPath,
      restoreDefault: true
    })
    return this.createPlan('restore-default', destination)
  }

  async schedule(
    rawPlan: StorageRelocationPreflightPlan,
    interruptActiveWork: boolean
  ): Promise<StorageRelocationOperationJournal> {
    this.assertNewOperationAllowed()
    if (await this.store.activeOperationId()) {
      throw relocationError('operation_conflict', 'Another storage relocation is already pending.')
    }
    const requestedPlan = StorageRelocationPreflightPlanSchema.parse(rawPlan)
    const currentPlan = await this.createPlan(requestedPlan.kind, requestedPlan.destinationRoot)
    const plan = StorageRelocationPreflightPlanSchema.parse({
      ...currentPlan,
      operationId: requestedPlan.operationId
    })
    if (plan.activeWork.length > 0 && !interruptActiveWork) {
      throw relocationError(
        'active_work_confirmation_required',
        'Active Kun work must be confirmed for interruption before relocation.'
      )
    }
    const uninterruptible = plan.activeWork.filter((item) => !item.interruptible)
    if (uninterruptible.length > 0) {
      throw relocationError(
        'active_writer',
        `Kun cannot safely stop: ${uninterruptible.map((item) => item.label).join('; ')}`
      )
    }
    const now = this.now().toISOString()
    const roots = plan.sources.filter((root) => root.exists).map((root) => ({
      name: root.name,
      logicalPath: root.logicalPath,
      sourcePhysicalPath: root.physicalPath,
      targetPath: targetRootPath(plan.destinationRoot, root.name),
      stagingPath: stagingRootPath(plan.destinationRoot, root.name, plan.operationId),
      sourceWasJunction: root.junction,
      ...(root.junction ? { sourceLinkTarget: root.physicalPath } : {}),
      ...(root.junction
        ? root.appOwned ? { sourceBackupPath: root.physicalPath } : {}
        : { sourceBackupPath: backupRootPath(root.logicalPath, plan.operationId) }),
      activated: false,
      cleaned: false
    }))
    const journal = StorageRelocationOperationJournalSchema.parse({
      schemaVersion: STORAGE_RELOCATION_SCHEMA_VERSION,
      operationId: plan.operationId,
      kind: plan.kind,
      phase: 'prepared',
      sourceHome: this.options.homeDir,
      destinationRoot: plan.destinationRoot,
      controlRoot: this.store.controlRoot,
      roots,
      uniqueBytes: plan.uniqueBytes,
      requiredBytes: plan.requiredBytes,
      startedAt: now,
      updatedAt: now
    })
    await this.store.writeJournal(journal)
    await this.store.setActiveOperation(journal.operationId)
    this.publish(progressFromJournal(journal, this.now()))
    return journal
  }

  async markDraining(operationId: string): Promise<StorageRelocationOperationJournal> {
    const active = await this.store.activeOperationId()
    if (active !== operationId) {
      throw relocationError('operation_conflict', 'The relocation operation is not active.')
    }
    const journal = await this.store.readJournal(operationId)
    await this.validateJournal(journal)
    if (journal.phase !== 'prepared' && journal.phase !== 'draining') {
      throw relocationError('operation_conflict', `Cannot drain a relocation in phase ${journal.phase}.`)
    }
    return journal.phase === 'draining' ? journal : this.updatePhase(journal, 'draining')
  }

  async runPending(): Promise<StorageRelocationOperationJournal | null> {
    const operationId = await this.store.activeOperationId()
    if (!operationId) return null
    let journal = await this.store.readJournal(operationId)
    await this.validateJournal(journal)
    if (journal.phase === 'completed' || journal.phase === 'cancelled') {
      await this.store.clearActiveOperation(journal.operationId)
      return journal
    }
    if (journal.phase === 'cleanup-pending') return this.retryCleanup(journal)
    if (journal.phase === 'rolling-back') {
      const rolledBack = await this.rollbackJournal(journal)
      await this.writeReport(rolledBack, 'rolled-back')
      await this.store.clearActiveOperation(journal.operationId)
      return rolledBack
    }
    this.abortController = new AbortController()
    try {
      if (journal.phase === 'prepared' || journal.phase === 'draining' || journal.phase === 'failed') {
        journal = await this.updatePhase(journal, 'copying')
      }
      if (journal.phase === 'copying') journal = await this.copyAndFingerprint(journal)
      if (journal.phase === 'verifying') journal = await this.verifyAndCutover(journal)
      if (journal.phase === 'cutover') journal = await this.activate(journal)
      if (journal.phase === 'health-check') journal = await this.healthCheckAndCleanup(journal)
      return journal
    } catch (error) {
      if (this.abortController.signal.aborted && !journal.roots.some((root) => root.activated)) {
        await this.cleanStaging(journal)
        journal = await this.failJournal(journal, 'cancelled', relocationErrorValue(
          'cancelled', 'Storage relocation was cancelled before cutover.'
        ))
        await this.writeReport(journal, 'cancelled')
        await this.store.clearActiveOperation(journal.operationId)
        return journal
      }
      if (journal.roots.some((root) => root.activated)) {
        try {
          journal = await this.rollbackJournal(journal)
          await this.writeReport(journal, 'rolled-back', error)
          await this.store.clearActiveOperation(journal.operationId)
          return journal
        } catch (rollbackError) {
          journal = await this.failJournal(journal, 'failed', relocationErrorValue(
            'rollback_failed',
            `Storage relocation failed and automatic rollback could not finish: ${errorMessage(rollbackError)}`
          ))
          throw new Error(journal.error?.message)
        }
      }
      await this.cleanStaging(journal).catch(() => undefined)
      journal = await this.failJournal(journal, 'failed', normalizeEngineError(error))
      throw error
    } finally {
      this.abortController = null
    }
  }

  async cancel(operationId: string): Promise<void> {
    const active = await this.store.activeOperationId()
    if (active !== operationId) throw relocationError('operation_conflict', 'The relocation operation is not active.')
    this.abortController?.abort(new Error('storage relocation cancelled'))
    if (!this.abortController) {
      const journal = await this.store.readJournal(operationId)
      if (journal.roots.some((root) => root.activated)) {
        await this.rollback(operationId)
      } else {
        await this.cleanStaging(journal)
        const cancelled = await this.failJournal(journal, 'cancelled', relocationErrorValue(
          'cancelled', 'Storage relocation was cancelled.'
        ))
        await this.writeReport(cancelled, 'cancelled')
        await this.store.clearActiveOperation(operationId)
      }
    }
  }

  async rollback(operationId: string): Promise<StorageRelocationOperationJournal> {
    const journal = await this.store.readJournal(operationId)
    const rolledBack = await this.rollbackJournal(journal)
    await this.writeReport(rolledBack, 'rolled-back')
    await this.store.clearActiveOperation(operationId)
    return rolledBack
  }

  async repairLocation(): Promise<StorageRelocationStatus> {
    const location = await this.store.readLocation()
    if (!location) throw relocationError('operation_conflict', 'No relocated storage location is recorded.')
    for (const name of STORAGE_RELOCATION_ROOT_NAMES) {
      const target = location.roots[name]
      if (!target) continue
      const targetMetadata = await lstat(target).catch((error) => {
        throw relocationError(
          'destination_unavailable',
          `The target for ${name} is unavailable: ${errorMessage(error)}`
        )
      })
      if (!targetMetadata.isDirectory()) {
        throw relocationError('destination_unavailable', `The target for ${name} is not a directory.`)
      }
      const logical = storageLogicalRoot(name, this.options.homeDir)
      try {
        const current = await lstat(logical)
        if (current.isSymbolicLink() && resolve(await realpath(logical)) === resolve(target)) continue
        throw relocationError('cutover_failed', `Refusing to replace conflicting data at ${logical}.`)
      } catch (error) {
        if (String((error as NodeJS.ErrnoException).code) !== 'ENOENT') throw error
        await createDirectoryLink(target, logical, this.platform)
      }
    }
    return this.status()
  }

}
