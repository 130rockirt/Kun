import {
  mkdirSync,
  renameSync
} from 'node:fs'
import {
  dirname,
  join
} from 'node:path'
import {
  type MigrationLogger
} from './legacy-data-migration'
import {
  JOURNAL_FILE_NAME,
  type MigrationPhase,
  ROLLBACK_PHASES,
  type RuntimeDataDirMigrationOptions,
  type RuntimeDataDirMigrationResult,
  type RuntimeMigrationJournal
} from './runtime-data-dir-migration-types'
import {
  pathState,
  readJournal,
  retryRuntimeMigrationMutation,
  sameFilesystemPath
} from './runtime-data-dir-migration-journal-v2'
import {
  updateJournal
} from './runtime-data-dir-migration-journal-preservation'
import {
  readSettingsSelection,
  threadIds
} from './runtime-data-dir-migration-inventory'
import {
  backUpSettingsFile,
  createAndVerifyCompatibilityLink,
  linkResolvesToTarget,
  rewriteSettingsToCurrent
} from './runtime-data-dir-migration-copy'
import {
  commitExtensionRegistryRebase,
  prepareExtensionRegistryRebase,
  repairCompletedExtensionRegistry
} from './runtime-data-dir-migration-extensions'
import {
  assertSettingsSelectionStable,
  finishPromotedDirectoryRollback,
  restoreDestinationBackup,
  rollBackPromotedDirectories,
  salvageDestinationBackup,
  validatePromotedStore,
  writeReport
} from './runtime-data-dir-migration-salvage'



export function continueMigration(
  initialJournal: RuntimeMigrationJournal,
  options: Required<Pick<RuntimeDataDirMigrationOptions, 'userDataPath' | 'homeDir'>> & {
    platform: NodeJS.Platform
    log: MigrationLogger
    now: () => Date
    sleep: (milliseconds: number) => void
    assertLegacyRuntimeInactive: (sourcePath: string) => void
    afterPhase: (phase: MigrationPhase) => void
    beforeCompatibilityLink: () => void
  }
): RuntimeDataDirMigrationResult {
  const journalPath = join(options.userDataPath, JOURNAL_FILE_NAME)
  let journal = initialJournal
  try {
    if (ROLLBACK_PHASES.has(journal.phase)) {
      const rollbackError = journal.error ?? 'Runtime directory cutover was rolled back'
      journal = finishPromotedDirectoryRollback(journalPath, journal, options)
      throw new Error(`${rollbackError}; rollback completed and migration can retry safely`)
    }

    if (journal.phase === 'prepared') {
      assertSettingsSelectionStable(journal, options)
      const settingsBackupPaths = backUpSettingsFile(
        journal.settingsWritePath,
        options.now
      )
      journal = updateJournal(
        journalPath,
        journal,
        {
          phase: 'settings-backed-up',
          settingsBackupPaths,
          settingsBackedUp: true,
          error: undefined
        },
        options.now
      )
      options.afterPhase('settings-backed-up')
    }

    if (journal.phase === 'settings-backed-up') {
      if (journal.sourceWasMissing !== true) {
        options.assertLegacyRuntimeInactive(journal.sourcePath)
      }
      if (journal.destinationBackupPath && pathState(journal.targetPath) === 'dir') {
        options.assertLegacyRuntimeInactive(journal.targetPath)
      }
      mkdirSync(dirname(journal.targetPath), { recursive: true, mode: 0o700 })
      if (journal.destinationBackupPath) {
        const targetState = pathState(journal.targetPath)
        const backupState = pathState(journal.destinationBackupPath)
        if (targetState === 'dir' && backupState === 'missing') {
          retryRuntimeMigrationMutation(
            () => renameSync(journal.targetPath, journal.destinationBackupPath!),
            { platform: options.platform, sleep: options.sleep }
          )
        } else if (!(targetState === 'missing' && backupState === 'dir')) {
          throw new Error('destination backup state is inconsistent with the migration journal')
        }
      } else if (pathState(journal.targetPath) !== 'missing') {
        throw new Error('unexpected Runtime destination appeared after migration planning')
      }
      journal = updateJournal(
        journalPath,
        journal,
        { phase: 'destination-backed-up', error: undefined },
        options.now
      )
      options.afterPhase('destination-backed-up')
    }

    if (journal.phase === 'destination-backed-up') {
      try {
        if (journal.sourceWasMissing !== true) {
          options.assertLegacyRuntimeInactive(journal.sourcePath)
        }
        if (pathState(journal.sourcePath) === 'dir' && pathState(journal.targetPath) === 'missing') {
          retryRuntimeMigrationMutation(
            () => renameSync(journal.sourcePath, journal.targetPath),
            { platform: options.platform, sleep: options.sleep }
          )
        } else if (
          journal.sourceWasMissing === true &&
          pathState(journal.sourcePath) === 'missing' &&
          pathState(journal.targetPath) === 'missing'
        ) {
          mkdirSync(journal.targetPath, { recursive: true, mode: 0o700 })
        } else if (
          pathState(journal.targetPath) !== 'dir' ||
          !['missing', 'symlink'].includes(pathState(journal.sourcePath))
        ) {
          throw new Error('source promotion state is inconsistent with the migration journal')
        }
      } catch (error) {
        if (
          pathState(journal.sourcePath) === 'dir' &&
          pathState(journal.targetPath) === 'missing'
        ) {
          restoreDestinationBackup(journal, options.platform, options.sleep)
          journal = updateJournal(
            journalPath,
            journal,
            {
              phase: 'settings-backed-up',
              error: error instanceof Error ? error.message : String(error)
            },
            options.now
          )
        }
        throw error
      }
      journal = updateJournal(
        journalPath,
        journal,
        { phase: 'source-promoted', error: undefined },
        options.now
      )
      options.afterPhase('source-promoted')
    }

    if (journal.phase === 'source-promoted') {
      try {
        if (journal.sourceWasMissing !== true) {
          options.assertLegacyRuntimeInactive(journal.sourcePath)
        }
        options.beforeCompatibilityLink()
        createAndVerifyCompatibilityLink(
          journal.sourcePath,
          journal.targetPath,
          options.platform,
          options.sleep
        )
      } catch (error) {
        if (pathState(journal.targetPath) === 'dir') {
          journal = rollBackPromotedDirectories(
            journalPath,
            journal,
            options,
            error
          )
        }
        throw error
      }
      journal = updateJournal(
        journalPath,
        journal,
        { phase: 'link-created', error: undefined },
        options.now
      )
      options.afterPhase('link-created')
    }

    if (journal.phase === 'link-created') {
      if (journal.settingsBackedUp !== true) {
        assertSettingsSelectionStable(journal, options)
        journal = updateJournal(
          journalPath,
          journal,
          {
            settingsBackupPaths: backUpSettingsFile(
              journal.settingsWritePath,
              options.now
            ),
            settingsBackedUp: true,
            error: undefined
          },
          options.now
        )
      }
      const salvage = salvageDestinationBackup(
        journal.destinationBackupPath,
        journal.targetPath,
        {
          platform: options.platform,
          sleep: options.sleep
        }
      )
      journal = updateJournal(
        journalPath,
        journal,
        {
          phase: 'salvaged',
          salvaged: salvage.salvaged,
          conflicts: salvage.conflicts,
          error: undefined
        },
        options.now
      )
      options.afterPhase('salvaged')
    }

    if (journal.phase === 'salvaged') {
      journal = prepareExtensionRegistryRebase(journalPath, journal, options)
    }

    if (journal.phase === 'extension-registry-backed-up') {
      journal = commitExtensionRegistryRebase(journalPath, journal, options)
    }

    if (journal.phase === 'extension-registry-rebased') {
      assertSettingsSelectionStable(journal, options)
      rewriteSettingsToCurrent(journal.settingsWritePath)
      journal = updateJournal(
        journalPath,
        journal,
        { phase: 'settings-rewritten', error: undefined },
        options.now
      )
      options.afterPhase('settings-rewritten')
    }

    if (journal.phase === 'settings-rewritten') {
      const validation = validatePromotedStore(journal, options.platform)
      const completedAt = options.now().toISOString()
      journal = updateJournal(
        journalPath,
        journal,
        {
          phase: 'completed',
          completedAt,
          targetInventory: validation.targetInventory,
          sqliteQuickCheck: validation.sqliteQuickCheck,
          error: undefined
        },
        options.now
      )
      options.afterPhase('completed')
      options.log('legacy-migration: committed canonical Kun Runtime data migration', {
        sourcePath: journal.sourcePath,
        targetPath: journal.targetPath,
        destinationBackupPath: journal.destinationBackupPath,
        sourceThreadCount: journal.sourceThreadIds.length,
        salvaged: journal.salvaged,
        conflicts: journal.conflicts.length,
        extensionRegistryRebasedRecords: journal.extensionRegistryRebasedRecords ?? 0
      })
    }

    const reportPath = writeReport(options.userDataPath, journal)
    return {
      status: 'completed',
      authority: 'current',
      sourcePath: journal.sourcePath,
      targetPath: journal.targetPath,
      ...(journal.destinationBackupPath
        ? { destinationBackupPath: journal.destinationBackupPath }
        : {}),
      journalPath,
      reportPath
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    try {
      const persistedJournal = readJournal(journalPath)
      if (
        persistedJournal &&
        sameFilesystemPath(persistedJournal.sourcePath, journal.sourcePath, options.platform) &&
        sameFilesystemPath(persistedJournal.targetPath, journal.targetPath, options.platform)
      ) {
        journal = persistedJournal
      }
      journal = updateJournal(journalPath, journal, { error: message }, options.now)
    } catch {
      // The original error remains authoritative.
    }
    options.log('legacy-migration: canonical Runtime data migration is blocked', {
      phase: journal.phase,
      message,
      sourcePath: journal.sourcePath,
      targetPath: journal.targetPath,
      destinationBackupPath: journal.destinationBackupPath
    })
    return {
      status: 'blocked',
      authority: 'legacy',
      sourcePath: journal.sourcePath,
      targetPath: journal.targetPath,
      ...(journal.destinationBackupPath
        ? { destinationBackupPath: journal.destinationBackupPath }
        : {}),
      journalPath,
      message
    }
  }
}

export function maintainCompletedMigration(
  initialJournal: RuntimeMigrationJournal,
  options: {
    userDataPath: string
    homeDir: string
    platform: NodeJS.Platform
    log: MigrationLogger
    now: () => Date
    sleep: (milliseconds: number) => void
    assertLegacyRuntimeInactive: (sourcePath: string) => void
  }
): RuntimeDataDirMigrationResult {
  const journalPath = join(options.userDataPath, JOURNAL_FILE_NAME)
  let journal = initialJournal
  try {
    const selection = readSettingsSelection(
      options.userDataPath,
      options.homeDir,
      options.platform,
      pathState(journal.sourcePath)
    )
    if (selection.authority === 'custom') {
      return {
        status: 'not-needed',
        authority: 'custom',
        sourcePath: journal.sourcePath,
        targetPath: journal.targetPath,
        ...(journal.destinationBackupPath
          ? { destinationBackupPath: journal.destinationBackupPath }
          : {}),
        journalPath
      }
    }
    if (selection.authority === 'unknown') {
      throw new Error('could not determine Runtime data authority from the active settings source')
    }
    if (pathState(journal.targetPath) !== 'dir') {
      throw new Error('committed Kun Runtime target is missing')
    }
    const sourceState = pathState(journal.sourcePath)
    if (sourceState === 'dir') {
      options.log('legacy-migration: retained real legacy Runtime history without mutation', {
        legacyPath: journal.sourcePath
      })
    } else if (
      sourceState === 'symlink' &&
      !linkResolvesToTarget(journal.sourcePath, journal.targetPath, options.platform)
    ) {
      throw new Error('legacy Runtime compatibility link no longer resolves to the current store')
    } else if (
      sourceState !== 'symlink' &&
      sourceState !== 'missing'
    ) {
      throw new Error('legacy Runtime history path has an unexpected filesystem type')
    }
    const currentThreadIds = new Set(threadIds(journal.targetPath))
    const missingSourceThreads = journal.sourceThreadIds.filter(
      (threadId) => !currentThreadIds.has(threadId)
    )
    if (missingSourceThreads.length > 0) {
      throw new Error(
        `current Runtime store is missing ${missingSourceThreads.length} ` +
        `threads recorded before the rename migration`
      )
    }
    journal = repairCompletedExtensionRegistry(journalPath, journal, options)
    if (selection.authority === 'legacy') {
      const settingsBackupPaths = backUpSettingsFile(selection.writePath, options.now)
      journal = updateJournal(
        journalPath,
        journal,
        {
          settingsSourcePath: selection.sourcePath,
          settingsWritePath: selection.writePath,
          settingsBackupPaths: [
            ...journal.settingsBackupPaths,
            ...settingsBackupPaths
          ],
          settingsBackedUp: true
        },
        options.now
      )
      rewriteSettingsToCurrent(selection.writePath)
    }
    const reportPath = writeReport(options.userDataPath, journal)
    return {
      status: 'completed',
      authority: 'current',
      sourcePath: journal.sourcePath,
      targetPath: journal.targetPath,
      ...(journal.destinationBackupPath
        ? { destinationBackupPath: journal.destinationBackupPath }
        : {}),
      journalPath,
      reportPath,
      ...(sourceState === 'symlink'
        ? {
            message:
              'history is present but the completed version-2 migration did not preserve ' +
              'an independent legacy source'
          }
        : {})
    }
  } catch (error) {
    return {
      status: 'blocked',
      authority: 'current',
      sourcePath: journal.sourcePath,
      targetPath: journal.targetPath,
      ...(journal.destinationBackupPath
        ? { destinationBackupPath: journal.destinationBackupPath }
        : {}),
      journalPath,
      message: error instanceof Error ? error.message : String(error)
    }
  }
}
