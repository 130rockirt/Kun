import {
  join
} from 'node:path'
import {
  PRESERVATION_JOURNAL_FILE_NAME,
  type PreservationJournal,
  type RuntimeDataDirMigrationResult
} from './runtime-data-dir-migration-types'
import {
  readPreservationJournal,
  updatePreservationJournal
} from './runtime-data-dir-migration-journal-preservation'
import {
  runtimeStoreInventory,
  runtimeTreeFingerprint,
  threadIds
} from './runtime-data-dir-migration-inventory'
import {
  assertCandidateCopyCapacity,
  backUpSettingsFile,
  validateSqliteIndex
} from './runtime-data-dir-migration-copy'
import {
  salvageDestinationBackup
} from './runtime-data-dir-migration-salvage'
import {
  assertPreservationSettingsSelectionStable,
  maintainCompletedPreservationMigration,
  type PreservationMigrationOptions
} from './runtime-data-dir-migration-preservation-validation'



export function continueCurrentAuthorityMerge(
  initialJournal: PreservationJournal,
  options: PreservationMigrationOptions
): RuntimeDataDirMigrationResult {
  const journalPath = join(options.userDataPath, PRESERVATION_JOURNAL_FILE_NAME)
  let journal = initialJournal
  try {
    if (
      journal.phase === 'prepared' ||
      journal.phase === 'settings-backed-up' ||
      journal.phase === 'destination-salvaged'
    ) {
      assertPreservationSettingsSelectionStable(journal, options)
      options.assertLegacyRuntimeInactive(journal.sourcePath)
      options.assertLegacyRuntimeInactive(journal.targetPath)
      const source = runtimeTreeFingerprint(journal.sourcePath)
      if (source.fingerprint !== journal.sourceFingerprint) {
        const currentThreadIds = new Set(source.threadIds)
        const missing = journal.sourceThreadIds.filter(
          (threadId) => !currentThreadIds.has(threadId)
        )
        if (missing.length > 0) {
          throw new Error(
            `preserved legacy Runtime source is missing ${missing.length} ` +
            'thread directories recorded before incremental merge'
          )
        }
        const previousPhase = journal.phase
        journal = updatePreservationJournal(
          journalPath,
          journal,
          {
            phase: previousPhase === 'destination-salvaged'
              ? 'settings-backed-up'
              : previousPhase,
            sourceThreadIds: source.threadIds,
            sourceInventory: source.inventory,
            sourceFingerprint: source.fingerprint,
            candidateFingerprint: undefined,
            targetInventory: undefined,
            sqliteQuickCheck: undefined,
            completedAt: undefined,
            runtimeVerifiedAt: undefined,
            error: undefined
          },
          options.now
        )
        options.log('legacy-migration: refreshing additive Runtime merge source', {
          sourcePath: journal.sourcePath,
          targetPath: journal.targetPath,
          previousPhase,
          resumedPhase: journal.phase,
          sourceFingerprint: source.fingerprint,
          sourceThreadCount: source.threadIds.length
        })
      }
    }

    if (journal.phase === 'prepared') {
      assertPreservationSettingsSelectionStable(journal, options)
      journal = updatePreservationJournal(
        journalPath,
        journal,
        {
          phase: 'settings-backed-up',
          settingsBackupPaths: backUpSettingsFile(
            journal.settingsWritePath,
            options.now
          ),
          error: undefined
        },
        options.now
      )
      options.afterPhase('settings-backed-up')
    }

    if (journal.phase === 'settings-backed-up') {
      assertPreservationSettingsSelectionStable(journal, options)
      options.assertLegacyRuntimeInactive(journal.sourcePath)
      options.assertLegacyRuntimeInactive(journal.targetPath)
      const sourceBefore = runtimeTreeFingerprint(journal.sourcePath)
      if (sourceBefore.fingerprint !== journal.sourceFingerprint) {
        throw new Error('preserved legacy Runtime source changed before incremental merge')
      }
      assertCandidateCopyCapacity(
        journal.sourceInventory,
        journal.stagingPath,
        options.availableCopyBytes
      )
      const salvage = salvageDestinationBackup(
        journal.sourcePath,
        journal.targetPath,
        {
          platform: options.platform,
          sleep: options.sleep
        }
      )
      const sourceAfter = runtimeTreeFingerprint(journal.sourcePath)
      if (sourceAfter.fingerprint !== journal.sourceFingerprint) {
        throw new Error('preserved legacy Runtime source changed during incremental merge')
      }
      const target = runtimeTreeFingerprint(journal.targetPath)
      journal = updatePreservationJournal(
        journalPath,
        journal,
        {
          phase: 'destination-salvaged',
          salvaged: journal.salvaged + salvage.salvaged,
          conflicts: [...new Set([...journal.conflicts, ...salvage.conflicts])],
          candidateFingerprint: target.fingerprint,
          error: undefined
        },
        options.now
      )
      options.afterPhase('destination-salvaged')
    }

    if (journal.phase === 'destination-salvaged') {
      const source = runtimeTreeFingerprint(journal.sourcePath)
      if (source.fingerprint !== journal.sourceFingerprint) {
        throw new Error('preserved legacy Runtime source changed after incremental merge')
      }
      const visibleThreadDirectories = new Set(threadIds(journal.targetPath))
      const missing = journal.sourceThreadIds.filter(
        (threadId) => !visibleThreadDirectories.has(threadId)
      )
      if (missing.length > 0) {
        throw new Error(
          `incremental Runtime merge is missing ${missing.length} preserved thread directories`
        )
      }
      const completedAt = options.now().toISOString()
      journal = updatePreservationJournal(
        journalPath,
        journal,
        {
          phase: 'completed',
          completedAt,
          targetInventory: runtimeStoreInventory(journal.targetPath),
          sqliteQuickCheck: validateSqliteIndex(journal.targetPath),
          error: undefined
        },
        options.now
      )
      options.afterPhase('completed')
    }

    return maintainCompletedPreservationMigration(journal, options, true)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    try {
      const persisted = readPreservationJournal(journalPath)
      if (persisted) journal = persisted
      journal = updatePreservationJournal(
        journalPath,
        journal,
        { error: message },
        options.now
      )
    } catch {
      // The original failure remains authoritative.
    }
    return {
      status: 'blocked',
      authority: 'current',
      sourcePath: journal.sourcePath,
      targetPath: journal.targetPath,
      journalPath,
      message
    }
  }
}
