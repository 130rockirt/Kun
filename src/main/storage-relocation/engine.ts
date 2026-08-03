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

const TRANSIENT_RELATIVE_PATHS = new Set([
  'control/manager.json',
  'control/.manager-start.lock',
  'control/manager-state.json',
  'control/manager.log',
  'control/runtime.development.json',
  'control/.runtime-discovery.lock',
  'data/runtime.json',
  'data/runtime.development.json',
  'data/.runtime-discovery.lock',
  'data/.kun-runtime-owner.json'
])
export type StorageRelocationEngineOptions = {
  homeDir: string
  userDataPath: string
  installPath: string
  platform?: NodeJS.Platform
  featureEnabled: boolean
  now?: () => Date
  inspectVolume?: (path: string) => Promise<StorageRelocationVolumeInfo>
  listActiveWork?: () => Promise<StorageRelocationActiveWork[]>
  healthCheck?: (journal: StorageRelocationOperationJournal) => Promise<void>
  onProgress?: (progress: StorageRelocationProgress) => void
}

type FingerprintResult = StorageTreeInventory & { fingerprint: string }

export class StorageRelocationEngine {
  readonly store: StorageRelocationStore
  private readonly now: () => Date
  private readonly platform: NodeJS.Platform
  private abortController: AbortController | null = null
  private progress: StorageRelocationProgress | undefined

  constructor(private readonly options: StorageRelocationEngineOptions) {
    this.store = new StorageRelocationStore(join(options.userDataPath, 'storage-relocation'))
    this.now = options.now ?? (() => new Date())
    this.platform = options.platform ?? process.platform
  }

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

  private async createPlan(
    kind: StorageRelocationPreflightPlan['kind'],
    destinationRoot: string
  ): Promise<StorageRelocationPreflightPlan> {
    const location = await this.store.readLocation()
    const sources = await this.inspectRoots(location)
    const canonical = sources.find((root) => root.name === '.kun')
    if (!canonical?.exists) {
      throw relocationError('invalid_destination', 'No existing .kun data root was found to relocate.')
    }
    const unownedJunction = sources.find((root) => root.exists && root.junction && !root.appOwned)
    if (unownedJunction) {
      throw relocationError(
        'unsafe_reparse_point',
        `${unownedJunction.name} is an unrecognized junction. Restore it manually before using managed relocation.`
      )
    }
    const volume = await (this.options.inspectVolume ?? inspectWindowsVolume)(destinationRoot)
    if (volume.driveType !== 'Fixed' || volume.fileSystem.toLocaleUpperCase('en-US') !== 'NTFS') {
      throw relocationError(
        'destination_not_fixed_ntfs',
        'Choose a folder on a local fixed NTFS drive.'
      )
    }
    const uniqueBytes = uniqueSourceBytes(sources)
    const requiredBytes = storageRelocationRequiredBytes(uniqueBytes)
    if (volume.availableBytes < requiredBytes) {
      throw relocationError(
        'insufficient_space',
        `The target requires ${requiredBytes} bytes including reserve, but only ${volume.availableBytes} are available.`
      )
    }
    const activeWork = await this.options.listActiveWork?.() ?? []
    return StorageRelocationPreflightPlanSchema.parse({
      operationId: randomUUID(),
      kind,
      destinationRoot,
      targetRoots: Object.fromEntries(
        STORAGE_RELOCATION_ROOT_NAMES.map((name) => [name, targetRootPath(destinationRoot, name)])
      ),
      sources,
      uniqueBytes,
      requiredBytes,
      availableBytes: volume.availableBytes,
      expectedReleasedBytes: uniqueBytes,
      activeWork,
      warnings: [
        'The original home paths remain as compatibility junctions.',
        'The application install, %APPDATA%\\Kun, and .devin are not moved.'
      ],
      createdAt: this.now().toISOString()
    })
  }

  private async inspectRoots(
    location: StorageRelocationLocationRecord | null
  ): Promise<StorageRelocationRoot[]> {
    return Promise.all(STORAGE_RELOCATION_ROOT_NAMES.map((name) => inspectStorageRoot({
      name,
      homeDir: this.options.homeDir,
      appOwnedPhysicalPath: location?.roots[name]
    })))
  }

  private async copyAndFingerprint(
    journal: StorageRelocationOperationJournal
  ): Promise<StorageRelocationOperationJournal> {
    await ensureDestinationForOperation(journal)
    const roots = [...journal.roots]
    let completedBytes = 0
    let completedItems = 0
    const totalItems = roots.reduce((sum, root) => sum + 1, 0)
    for (let index = 0; index < roots.length; index += 1) {
      this.throwIfAborted()
      const root = roots[index]
      const before = await fingerprintTree(root.sourcePhysicalPath)
      await copyTree(root.sourcePhysicalPath, root.stagingPath, {
        signal: this.abortController!.signal,
        onFile: (path, bytes) => {
          completedBytes += bytes
          completedItems += 1
          this.publish({
            operationId: journal.operationId,
            phase: 'copying',
            completedBytes,
            totalBytes: journal.uniqueBytes,
            completedItems,
            totalItems: Math.max(totalItems, completedItems),
            currentItem: relative(root.sourcePhysicalPath, path),
            cancellable: true,
            updatedAt: this.now().toISOString()
          })
        }
      })
      await copyWindowsAcls(root.sourcePhysicalPath, root.stagingPath)
      roots[index] = { ...root, sourceFingerprint: before.fingerprint }
      journal = await this.patchJournal(journal, { roots })
    }
    return this.updatePhase(journal, 'verifying')
  }

  private async verifyAndCutover(
    journal: StorageRelocationOperationJournal
  ): Promise<StorageRelocationOperationJournal> {
    const roots = [...journal.roots]
    for (let index = 0; index < roots.length; index += 1) {
      this.throwIfAborted()
      const root = roots[index]
      const [source, target] = await Promise.all([
        fingerprintTree(root.sourcePhysicalPath),
        fingerprintTree(root.stagingPath)
      ])
      if (source.fingerprint !== root.sourceFingerprint || target.fingerprint !== source.fingerprint) {
        throw relocationError('verification_failed', `Storage changed while copying ${root.name}.`)
      }
      if (root.name === '.kun') validateRuntimeSqlite(join(root.stagingPath, 'data'))
      roots[index] = { ...root, targetFingerprint: target.fingerprint }
      this.publish({
        operationId: journal.operationId,
        phase: 'verifying',
        completedBytes: journal.uniqueBytes,
        totalBytes: journal.uniqueBytes,
        completedItems: index + 1,
        totalItems: roots.length,
        currentItem: root.name,
        cancellable: true,
        updatedAt: this.now().toISOString()
      })
    }
    journal = await this.patchJournal(journal, { roots })
    await this.writeOwnershipMarker(journal)
    return this.updatePhase(journal, 'cutover')
  }

  private async activate(
    journal: StorageRelocationOperationJournal
  ): Promise<StorageRelocationOperationJournal> {
    const roots = [...journal.roots]
    for (let index = 0; index < roots.length; index += 1) {
      const root = roots[index]
      if (root.activated) continue
      if (journal.kind === 'restore-default') {
        await activateRestoreRoot(root, this.platform)
      } else {
        await activateMovedRoot(root, this.platform)
      }
      roots[index] = { ...root, activated: true }
      journal = await this.patchJournal(journal, { roots })
      this.publish({
        operationId: journal.operationId,
        phase: 'cutover',
        completedBytes: journal.uniqueBytes,
        totalBytes: journal.uniqueBytes,
        completedItems: index + 1,
        totalItems: roots.length,
        currentItem: root.logicalPath,
        cancellable: false,
        updatedAt: this.now().toISOString()
      })
    }
    if (journal.kind === 'move') {
      await this.store.writeLocation(locationFromJournal(journal, this.now()))
    } else {
      await this.store.clearLocation()
    }
    return this.updatePhase(journal, 'health-check')
  }

  private async healthCheckAndCleanup(
    journal: StorageRelocationOperationJournal
  ): Promise<StorageRelocationOperationJournal> {
    for (const root of journal.roots) {
      const activePath = journal.kind === 'restore-default' ? root.logicalPath : root.targetPath
      const target = await fingerprintTree(activePath)
      if (target.fingerprint !== root.targetFingerprint) {
        throw relocationError('health_check_failed', `${root.name} changed before health verification.`)
      }
    }
    await this.options.healthCheck?.(journal)
    const roots = [...journal.roots]
    let cleanupFailed = false
    for (let index = 0; index < roots.length; index += 1) {
      const root = roots[index]
      if (!root.sourceBackupPath || root.cleaned) continue
      try {
        const source = await fingerprintTree(root.sourceBackupPath)
        if (source.fingerprint !== root.sourceFingerprint) {
          throw new Error('source backup fingerprint changed')
        }
        await rm(root.sourceBackupPath, { recursive: true, force: false })
        roots[index] = { ...root, cleaned: true }
      } catch {
        cleanupFailed = true
      }
    }
    journal = await this.patchJournal(journal, { roots })
    if (cleanupFailed) {
      journal = await this.updatePhase(journal, 'cleanup-pending')
      await this.writeReport(journal, 'cleanup-pending')
      return journal
    }
    journal = await this.updatePhase(journal, 'completed', { completedAt: this.now().toISOString() })
    await this.writeReport(journal, 'success')
    await this.store.clearActiveOperation(journal.operationId)
    return journal
  }

  private async retryCleanup(
    journal: StorageRelocationOperationJournal
  ): Promise<StorageRelocationOperationJournal> {
    return this.healthCheckAndCleanup(await this.updatePhase(journal, 'health-check'))
  }

  private async rollbackJournal(
    journal: StorageRelocationOperationJournal
  ): Promise<StorageRelocationOperationJournal> {
    journal = await this.updatePhase(journal, 'rolling-back')
    const roots = [...journal.roots]
    for (let index = roots.length - 1; index >= 0; index -= 1) {
      const root = roots[index]
      if (!root.activated) continue
      if (journal.kind === 'restore-default') {
        const active = await fingerprintTree(root.logicalPath)
        if (active.fingerprint !== root.targetFingerprint) {
          throw relocationError('rollback_failed', `Cannot replace changed restored root ${root.logicalPath}.`)
        }
        await rm(root.logicalPath, { recursive: true, force: false })
        await createDirectoryLink(root.sourcePhysicalPath, root.logicalPath, this.platform)
      } else {
        await unlink(root.logicalPath)
        if (root.sourceWasJunction) {
          await createDirectoryLink(root.sourcePhysicalPath, root.logicalPath, this.platform)
        } else if (root.sourceBackupPath) {
          await rename(root.sourceBackupPath, root.logicalPath)
        }
      }
      roots[index] = { ...root, activated: false }
      journal = await this.patchJournal(journal, { roots })
    }
    if (journal.kind === 'move') {
      const previousRoots = Object.fromEntries(journal.roots
        .filter((root) => root.sourceWasJunction)
        .map((root) => [root.name, root.sourcePhysicalPath]))
      if (Object.keys(previousRoots).length > 0) {
        const previousDestination = dirname(Object.values(previousRoots)[0]!)
        await this.store.writeLocation({
          schemaVersion: 1,
          destinationRoot: previousDestination,
          roots: previousRoots,
          operationId: journal.operationId,
          activatedAt: this.now().toISOString()
        })
      } else {
        await this.store.clearLocation()
      }
    }
    await this.cleanTarget(journal)
    await this.cleanStaging(journal)
    return this.failJournal(journal, 'failed', relocationErrorValue(
      'health_check_failed', 'Storage relocation was rolled back to the previous location.'
    ))
  }

  private async cleanStaging(journal: StorageRelocationOperationJournal): Promise<void> {
    await Promise.all(journal.roots.map((root) => rm(root.stagingPath, { recursive: true, force: true })))
  }

  private async cleanTarget(journal: StorageRelocationOperationJournal): Promise<void> {
    if (journal.kind === 'move') {
      try {
        const marker = JSON.parse(
          await readFile(join(journal.destinationRoot, STORAGE_RELOCATION_OWNERSHIP_MARKER), 'utf8')
        ) as { operationId?: unknown }
        if (marker.operationId !== journal.operationId) return
      } catch {
        return
      }
    }
    await Promise.all(journal.roots.map(async (root) => {
      try {
        const target = await fingerprintTree(root.targetPath)
        if (target.fingerprint === root.targetFingerprint) {
          await rm(root.targetPath, { recursive: true, force: false })
        }
      } catch {
        // Preserve anything that cannot be proven to be operation-owned.
      }
    }))
  }

  private async writeOwnershipMarker(journal: StorageRelocationOperationJournal): Promise<void> {
    if (journal.kind === 'restore-default') return
    const marker = {
      schemaVersion: 1,
      kind: 'kun-storage-relocation-root',
      operationId: journal.operationId,
      homeDir: journal.sourceHome,
      roots: Object.fromEntries(journal.roots.map((root) => [root.name, root.targetPath])),
      createdAt: this.now().toISOString()
    }
    await writeFile(
      join(journal.destinationRoot, STORAGE_RELOCATION_OWNERSHIP_MARKER),
      `${JSON.stringify(marker, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600, flag: 'wx' }
    ).catch(async (error) => {
      if (String((error as NodeJS.ErrnoException).code) !== 'EEXIST') throw error
      const markerPath = join(journal.destinationRoot, STORAGE_RELOCATION_OWNERSHIP_MARKER)
      const existing = JSON.parse(
        await readFile(markerPath, 'utf8')
      ) as { operationId?: unknown; kind?: unknown; roots?: Record<string, unknown> }
      if (existing.operationId !== journal.operationId) {
        const oldRoots = existing.roots && typeof existing.roots === 'object'
          ? Object.values(existing.roots).filter((value): value is string => typeof value === 'string')
          : []
        const reusable = existing.kind === 'kun-storage-relocation-root' &&
          (await Promise.all(oldRoots.map((path) => lstat(path).then(() => false).catch((cause) =>
            String((cause as NodeJS.ErrnoException).code) === 'ENOENT'
          )))).every(Boolean)
        if (!reusable) {
          throw relocationError('operation_conflict', 'The target ownership marker belongs to another operation.')
        }
        await writeFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`, {
          encoding: 'utf8', mode: 0o600, flag: 'w'
        })
      }
    })
  }

  private async updatePhase(
    journal: StorageRelocationOperationJournal,
    phase: StorageRelocationPhase,
    patch: Partial<StorageRelocationOperationJournal> = {}
  ): Promise<StorageRelocationOperationJournal> {
    if (!isStorageRelocationPhaseTransitionAllowed(journal.phase, phase)) {
      throw relocationError('journal_invalid', `Invalid relocation phase transition: ${journal.phase} -> ${phase}.`)
    }
    return this.patchJournal(journal, { ...patch, phase })
  }

  private async patchJournal(
    journal: StorageRelocationOperationJournal,
    patch: Partial<StorageRelocationOperationJournal>
  ): Promise<StorageRelocationOperationJournal> {
    const next = StorageRelocationOperationJournalSchema.parse({
      ...journal,
      ...patch,
      updatedAt: this.now().toISOString()
    })
    await this.store.writeJournal(next)
    this.publish(progressFromJournal(next, this.now()))
    return next
  }

  private async failJournal(
    journal: StorageRelocationOperationJournal,
    phase: 'failed' | 'cancelled',
    error: StorageRelocationError
  ): Promise<StorageRelocationOperationJournal> {
    if (!isStorageRelocationPhaseTransitionAllowed(journal.phase, phase)) {
      throw relocationError('journal_invalid', `Invalid relocation phase transition: ${journal.phase} -> ${phase}.`)
    }
    return this.patchJournal(journal, { phase, error })
  }

  private async writeReport(
    journal: StorageRelocationOperationJournal,
    outcome: StorageRelocationReport['outcome'],
    error?: unknown
  ): Promise<void> {
    await this.store.writeReport({
      schemaVersion: STORAGE_RELOCATION_SCHEMA_VERSION,
      operationId: journal.operationId,
      kind: journal.kind,
      outcome,
      sourcePaths: journal.roots.map((root) => root.sourcePhysicalPath),
      destinationRoot: journal.destinationRoot,
      movedBytes: journal.uniqueBytes,
      releasedBytes: outcome === 'success' ? journal.uniqueBytes : 0,
      warnings: outcome === 'cleanup-pending'
        ? ['The target is active, but old physical data is still awaiting safe cleanup.']
        : [],
      startedAt: journal.startedAt,
      finishedAt: this.now().toISOString(),
      ...(error ? { error: normalizeEngineError(error) } : journal.error ? { error: journal.error } : {})
    })
  }

  private async validateJournal(journal: StorageRelocationOperationJournal): Promise<void> {
    if (resolve(journal.controlRoot) !== resolve(this.store.controlRoot)) {
      throw relocationError('journal_invalid', 'The relocation journal control path is invalid.')
    }
    if (resolve(journal.sourceHome) !== resolve(this.options.homeDir)) {
      throw relocationError('journal_invalid', 'The relocation journal home path is invalid.')
    }
    const expectedDestination = validateDestinationPath({
      destinationRoot: journal.destinationRoot,
      homeDir: this.options.homeDir,
      userDataPath: this.options.userDataPath,
      installPath: this.options.installPath,
      restoreDefault: journal.kind === 'restore-default'
    })
    if (resolve(expectedDestination) !== resolve(journal.destinationRoot)) {
      throw relocationError('journal_invalid', 'The relocation journal destination path is invalid.')
    }
    const location = await this.store.readLocation()
    for (const root of journal.roots) {
      if (resolve(root.logicalPath) !== resolve(storageLogicalRoot(root.name, this.options.homeDir))) {
        throw relocationError('journal_invalid', 'The relocation journal contains an unexpected logical root.')
      }
      const expectedTarget = targetRootPath(journal.destinationRoot, root.name)
      const expectedStaging = stagingRootPath(journal.destinationRoot, root.name, journal.operationId)
      if (resolve(root.targetPath) !== resolve(expectedTarget) || resolve(root.stagingPath) !== resolve(expectedStaging)) {
        throw relocationError('journal_invalid', 'The relocation journal target escapes its destination root.')
      }
      const expectedSource = root.sourceWasJunction
        ? location?.roots[root.name]
        : root.logicalPath
      const sourceMatchesCurrentLocation = Boolean(
        expectedSource && await samePhysicalPath(root.sourcePhysicalPath, expectedSource)
      )
      const sourceMatchesOwnedPreviousLocation = root.sourceWasJunction && await isOwnedRelocationRoot(
        root.sourcePhysicalPath,
        root.name
      )
      if (!sourceMatchesCurrentLocation && !sourceMatchesOwnedPreviousLocation) {
        throw relocationError('journal_invalid', 'The relocation journal source path is not trusted.')
      }
      if (root.sourceBackupPath && !root.sourceWasJunction) {
        const expected = backupRootPath(root.logicalPath, journal.operationId)
        if (resolve(root.sourceBackupPath) !== resolve(expected)) {
          throw relocationError('journal_invalid', 'The relocation journal source backup path is invalid.')
        }
      }
      if (root.sourceBackupPath && root.sourceWasJunction && resolve(root.sourceBackupPath) !== resolve(root.sourcePhysicalPath)) {
        throw relocationError('journal_invalid', 'The relocation journal junction backup path is invalid.')
      }
    }
  }

  private assertNewOperationAllowed(): void {
    if (this.platform !== 'win32') throw relocationError('unsupported_platform', 'Storage relocation is Windows-only.')
    if (!this.options.featureEnabled) throw relocationError('feature_disabled', 'Storage relocation is disabled in this build.')
  }

  private throwIfAborted(): void {
    if (this.abortController?.signal.aborted) throw this.abortController.signal.reason
  }

  private publish(progress: StorageRelocationProgress): void {
    this.progress = StorageRelocationProgressSchema.parse(progress)
    this.options.onProgress?.(this.progress)
  }
}

async function assertEmptyOrMissing(path: string): Promise<void> {
  try {
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink()) {
      throw relocationError('unsafe_reparse_point', 'The selected destination is a reparse point.')
    }
    if (!metadata.isDirectory()) {
      throw relocationError('invalid_destination', 'The selected destination is not a folder.')
    }
    const entries = await readdir(path)
    if (entries.length === 1 && entries[0] === STORAGE_RELOCATION_OWNERSHIP_MARKER) {
      const marker = JSON.parse(await readFile(join(path, STORAGE_RELOCATION_OWNERSHIP_MARKER), 'utf8')) as {
        kind?: unknown
      }
      if (marker.kind === 'kun-storage-relocation-root') return
    }
    if (entries.length > 0) {
      throw relocationError('destination_not_empty', 'Choose an empty folder reserved for Kun data.')
    }
  } catch (error) {
    if (String((error as NodeJS.ErrnoException).code) === 'ENOENT') return
    throw error
  }
}

async function isOwnedRelocationRoot(
  physicalPath: string,
  name: StorageRelocationRootName
): Promise<boolean> {
  try {
    const marker = JSON.parse(
      await readFile(join(dirname(physicalPath), STORAGE_RELOCATION_OWNERSHIP_MARKER), 'utf8')
    ) as { kind?: unknown; roots?: Record<string, unknown> }
    return marker.kind === 'kun-storage-relocation-root' &&
      typeof marker.roots?.[name] === 'string' &&
      await samePhysicalPath(marker.roots[name], physicalPath)
  } catch {
    return false
  }
}

async function samePhysicalPath(left: string, right: string): Promise<boolean> {
  const [leftPath, rightPath] = await Promise.all([
    realpath(left).catch(() => resolve(left)),
    realpath(right).catch(() => resolve(right))
  ])
  return resolve(leftPath) === resolve(rightPath)
}

async function ensureDestinationForOperation(journal: StorageRelocationOperationJournal): Promise<void> {
  await mkdir(journal.destinationRoot, { recursive: true, mode: 0o700 })
  await hardenStorageDestinationAcl(journal.destinationRoot)
  if (journal.kind !== 'move') return
  const allowed = new Set([
    STORAGE_RELOCATION_OWNERSHIP_MARKER,
    ...journal.roots.flatMap((root) => [basename(root.stagingPath), basename(root.targetPath)])
  ])
  const unexpected = (await readdir(journal.destinationRoot)).filter((name) => !allowed.has(name))
  if (unexpected.length > 0) {
    throw relocationError(
      'destination_not_empty',
      `The relocation destination now contains unexpected data: ${unexpected.slice(0, 3).join(', ')}`
    )
  }
}

async function fingerprintTree(rootPath: string): Promise<FingerprintResult> {
  const hash = createHash('sha256')
  const inventory: StorageTreeInventory = { files: 0, directories: 0, links: 0, bytes: 0 }
  const visit = async (path: string): Promise<void> => {
    const metadata = await lstat(path)
    const rel = canonicalRelative(rootPath, path)
    if (rel !== '.' && isTransient(rel)) return
    if (metadata.isSymbolicLink()) {
      inventory.links += 1
      inventory.bytes += metadata.size
      hash.update(`link\0${rel}\0${await readlink(path)}\0`)
      return
    }
    if (metadata.isDirectory()) {
      inventory.directories += 1
      hash.update(`dir\0${rel}\0${metadata.mode & 0o7777}\0`)
      for (const name of (await readdir(path)).sort()) await visit(join(path, name))
      return
    }
    if (!metadata.isFile()) throw new Error(`unsupported storage entry: ${path}`)
    inventory.files += 1
    inventory.bytes += metadata.size
    hash.update(`file\0${rel}\0${metadata.mode & 0o7777}\0${metadata.size}\0`)
    await new Promise<void>((resolveStream, reject) => {
      const stream = createReadStream(path)
      stream.on('data', (chunk) => hash.update(chunk))
      stream.once('error', reject)
      stream.once('end', resolveStream)
    })
    hash.update('\0')
  }
  await visit(rootPath)
  return { ...inventory, fingerprint: hash.digest('hex') }
}

async function copyTree(
  sourceRoot: string,
  targetRoot: string,
  options: {
    signal: AbortSignal
    onFile: (sourcePath: string, bytes: number) => void
  }
): Promise<void> {
  const visit = async (sourcePath: string, targetPath: string): Promise<void> => {
    if (options.signal.aborted) throw options.signal.reason
    const metadata = await lstat(sourcePath)
    const rel = canonicalRelative(sourceRoot, sourcePath)
    if (rel !== '.' && isTransient(rel)) return
    if (metadata.isSymbolicLink()) {
      const linkTarget = await readlink(sourcePath)
      try {
        const targetMetadata = await lstat(targetPath)
        if (!targetMetadata.isSymbolicLink() || await readlink(targetPath) !== linkTarget) {
          throw new Error(`staging contains a different link: ${targetPath}`)
        }
      } catch (error) {
        if (String((error as NodeJS.ErrnoException).code) !== 'ENOENT') throw error
        const targetIsDirectory = await stat(sourcePath).then((value) => value.isDirectory()).catch(() => false)
        await symlink(linkTarget, targetPath, targetIsDirectory && process.platform === 'win32' ? 'junction' : targetIsDirectory ? 'dir' : 'file')
      }
      options.onFile(sourcePath, metadata.size)
      return
    }
    if (metadata.isDirectory()) {
      await mkdir(targetPath, { recursive: true, mode: (metadata.mode & 0o7777) | 0o700 })
      for (const name of (await readdir(sourcePath)).sort()) {
        await visit(join(sourcePath, name), join(targetPath, name))
      }
      await chmod(targetPath, metadata.mode & 0o7777).catch(ignoreWindowsMetadataError)
      await utimes(targetPath, metadata.atime, metadata.mtime).catch(ignoreWindowsMetadataError)
      return
    }
    if (!metadata.isFile()) throw new Error(`unsupported storage entry: ${sourcePath}`)
    await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 })
    const partialPath = join(dirname(targetPath), `.${basename(targetPath)}.kun-relocation-partial`)
    await rm(partialPath, { force: true })
    await copyFile(sourcePath, partialPath, constants.COPYFILE_FICLONE)
    await chmod(partialPath, metadata.mode & 0o7777).catch(ignoreWindowsMetadataError)
    await utimes(partialPath, metadata.atime, metadata.mtime).catch(ignoreWindowsMetadataError)
    await rename(partialPath, targetPath).catch(async (error) => {
      if (String((error as NodeJS.ErrnoException).code) !== 'EEXIST') throw error
      await rm(targetPath, { force: true })
      await rename(partialPath, targetPath)
    })
    options.onFile(sourcePath, metadata.size)
  }
  await visit(sourceRoot, targetRoot)
}

async function activateMovedRoot(
  root: StorageRelocationOperationJournal['roots'][number],
  platform: NodeJS.Platform
): Promise<void> {
  await rename(root.stagingPath, root.targetPath)
  const current = await lstat(root.logicalPath)
  if (root.sourceWasJunction) {
    if (!current.isSymbolicLink() || resolve(await realpath(root.logicalPath)) !== resolve(root.sourcePhysicalPath)) {
      throw relocationError('cutover_failed', `The source junction changed: ${root.logicalPath}`)
    }
    await unlink(root.logicalPath)
  } else {
    if (!current.isDirectory() || !root.sourceBackupPath) {
      throw relocationError('cutover_failed', `The source root changed: ${root.logicalPath}`)
    }
    await rename(root.logicalPath, root.sourceBackupPath)
  }
  try {
    await createDirectoryLink(root.targetPath, root.logicalPath, platform)
  } catch (error) {
    if (root.sourceWasJunction) {
      await createDirectoryLink(root.sourcePhysicalPath, root.logicalPath, platform).catch(() => undefined)
    } else if (root.sourceBackupPath) {
      await rename(root.sourceBackupPath, root.logicalPath).catch(() => undefined)
    }
    throw error
  }
}

async function activateRestoreRoot(
  root: StorageRelocationOperationJournal['roots'][number],
  platform: NodeJS.Platform
): Promise<void> {
  const current = await lstat(root.logicalPath)
  if (!root.sourceWasJunction || !current.isSymbolicLink()) {
    throw relocationError('cutover_failed', `Restore requires an app-owned junction: ${root.logicalPath}`)
  }
  if (resolve(await realpath(root.logicalPath)) !== resolve(root.sourcePhysicalPath)) {
    throw relocationError('cutover_failed', `The source junction changed: ${root.logicalPath}`)
  }
  await unlink(root.logicalPath)
  try {
    await rename(root.stagingPath, root.logicalPath)
  } catch (error) {
    await createDirectoryLink(root.sourcePhysicalPath, root.logicalPath, platform).catch(() => undefined)
    throw error
  }
}

async function createDirectoryLink(
  target: string,
  path: string,
  platform: NodeJS.Platform
): Promise<void> {
  await symlink(target, path, platform === 'win32' ? 'junction' : 'dir')
}

function validateRuntimeSqlite(dataDir: string): void {
  const path = join(dataDir, 'index.sqlite3')
  try {
    const db = new DatabaseSync(path, { readOnly: true })
    try {
      const result = db.prepare('PRAGMA quick_check').get() as { quick_check?: unknown } | undefined
      if (result?.quick_check !== 'ok') throw new Error('SQLite quick_check failed')
    } finally {
      db.close()
    }
  } catch (error) {
    if (String((error as NodeJS.ErrnoException).code) === 'ENOENT') return
    if (/unable to open database file/iu.test(errorMessage(error))) return
    throw error
  }
}

function progressFromJournal(
  journal: StorageRelocationOperationJournal,
  now: Date
): StorageRelocationProgress {
  return StorageRelocationProgressSchema.parse({
    operationId: journal.operationId,
    phase: journal.phase,
    completedBytes: journal.phase === 'prepared' || journal.phase === 'draining' ? 0 : journal.uniqueBytes,
    totalBytes: journal.uniqueBytes,
    completedItems: journal.roots.filter((root) => root.activated || root.targetFingerprint).length,
    totalItems: journal.roots.length,
    cancellable: journal.phase === 'prepared' || journal.phase === 'copying' || journal.phase === 'verifying',
    ...(journal.error ? { message: progressMessage(journal.error.message) } : {}),
    updatedAt: now.toISOString()
  })
}

function progressMessage(message: string): string {
  if (message.length <= STORAGE_RELOCATION_PROGRESS_MESSAGE_MAX_LENGTH) return message
  return `${message.slice(0, STORAGE_RELOCATION_PROGRESS_MESSAGE_MAX_LENGTH - 3)}...`
}

function locationFromJournal(
  journal: StorageRelocationOperationJournal,
  now: Date
): StorageRelocationLocationRecord {
  return {
    schemaVersion: 1,
    destinationRoot: journal.destinationRoot,
    roots: Object.fromEntries(journal.roots.map((root) => [root.name, root.targetPath])),
    operationId: journal.operationId,
    activatedAt: now.toISOString()
  }
}

function canonicalRelative(root: string, path: string): string {
  const value = relative(root, path)
  return value === '' ? '.' : value.split(sep).join('/')
}

function isTransient(relativePath: string): boolean {
  return TRANSIENT_RELATIVE_PATHS.has(relativePath)
}

function relocationError(code: StorageRelocationError['code'], message: string): Error {
  return new Error(`${code}: ${message}`)
}

function relocationErrorValue(
  code: StorageRelocationError['code'],
  message: string
): StorageRelocationError {
  return { code, message, nextActions: [] }
}

function normalizeEngineError(error: unknown): StorageRelocationError {
  const message = errorMessage(error)
  const match = /^([a-z_]+):\s*(.*)$/u.exec(message)
  const code = match?.[1]
  const allowed = [
    'unsupported_platform', 'feature_disabled', 'custom_data_dir', 'invalid_destination',
    'destination_not_empty', 'destination_not_fixed_ntfs', 'destination_unavailable',
    'insufficient_space', 'unsafe_reparse_point', 'active_work_confirmation_required',
    'active_writer', 'copy_failed', 'verification_failed', 'cutover_failed',
    'health_check_failed', 'rollback_failed', 'cleanup_failed', 'journal_invalid',
    'operation_conflict', 'cancelled'
  ] as const
  return relocationErrorValue(
    allowed.includes(code as typeof allowed[number])
      ? code as typeof allowed[number]
      : 'copy_failed',
    match?.[2] || message
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function ignoreWindowsMetadataError(error: unknown): void {
  if (process.platform === 'win32') return
  throw error
}
