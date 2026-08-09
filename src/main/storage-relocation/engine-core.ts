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

import {
  activateMovedRoot,
  activateRestoreRoot,
  copyTree,
  createDirectoryLink,
  ensureDestinationForOperation,
  fingerprintTree,
  isOwnedRelocationRoot,
  locationFromJournal,
  normalizeEngineError,
  progressFromJournal,
  relocationError,
  relocationErrorValue,
  samePhysicalPath,
  validateRuntimeSqlite
} from './engine-support'

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

export class StorageRelocationEngineCore {
  readonly store: StorageRelocationStore
  protected readonly now: () => Date
  protected readonly platform: NodeJS.Platform
  protected abortController: AbortController | null = null
  protected progress: StorageRelocationProgress | undefined

  constructor(protected readonly options: StorageRelocationEngineOptions) {
    this.store = new StorageRelocationStore(join(options.userDataPath, 'storage-relocation'))
    this.now = options.now ?? (() => new Date())
    this.platform = options.platform ?? process.platform
  }

  protected async createPlan(
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

  protected async inspectRoots(
    location: StorageRelocationLocationRecord | null
  ): Promise<StorageRelocationRoot[]> {
    return Promise.all(STORAGE_RELOCATION_ROOT_NAMES.map((name) => inspectStorageRoot({
      name,
      homeDir: this.options.homeDir,
      appOwnedPhysicalPath: location?.roots[name]
    })))
  }

  protected async copyAndFingerprint(
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

  protected async verifyAndCutover(
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

  protected async activate(
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

  protected async healthCheckAndCleanup(
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

  protected async retryCleanup(
    journal: StorageRelocationOperationJournal
  ): Promise<StorageRelocationOperationJournal> {
    return this.healthCheckAndCleanup(await this.updatePhase(journal, 'health-check'))
  }

  protected async rollbackJournal(
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

  protected async cleanStaging(journal: StorageRelocationOperationJournal): Promise<void> {
    await Promise.all(journal.roots.map((root) => rm(root.stagingPath, { recursive: true, force: true })))
  }

  protected async cleanTarget(journal: StorageRelocationOperationJournal): Promise<void> {
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

  protected async writeOwnershipMarker(journal: StorageRelocationOperationJournal): Promise<void> {
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

  protected async updatePhase(
    journal: StorageRelocationOperationJournal,
    phase: StorageRelocationPhase,
    patch: Partial<StorageRelocationOperationJournal> = {}
  ): Promise<StorageRelocationOperationJournal> {
    if (!isStorageRelocationPhaseTransitionAllowed(journal.phase, phase)) {
      throw relocationError('journal_invalid', `Invalid relocation phase transition: ${journal.phase} -> ${phase}.`)
    }
    return this.patchJournal(journal, { ...patch, phase })
  }

  protected async patchJournal(
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

  protected async failJournal(
    journal: StorageRelocationOperationJournal,
    phase: 'failed' | 'cancelled',
    error: StorageRelocationError
  ): Promise<StorageRelocationOperationJournal> {
    if (!isStorageRelocationPhaseTransitionAllowed(journal.phase, phase)) {
      throw relocationError('journal_invalid', `Invalid relocation phase transition: ${journal.phase} -> ${phase}.`)
    }
    return this.patchJournal(journal, { phase, error })
  }

  protected async writeReport(
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

  protected async validateJournal(journal: StorageRelocationOperationJournal): Promise<void> {
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

  protected assertNewOperationAllowed(): void {
    if (this.platform !== 'win32') throw relocationError('unsupported_platform', 'Storage relocation is Windows-only.')
    if (!this.options.featureEnabled) throw relocationError('feature_disabled', 'Storage relocation is disabled in this build.')
  }

  protected throwIfAborted(): void {
    if (this.abortController?.signal.aborted) throw this.abortController.signal.reason
  }

  protected publish(progress: StorageRelocationProgress): void {
    this.progress = StorageRelocationProgressSchema.parse(progress)
    this.options.onProgress?.(this.progress)
  }
}
