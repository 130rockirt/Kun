import {
  renameSync
} from 'node:fs'
import {
  join
} from 'node:path'
import {
  PRESERVATION_JOURNAL_FILE_NAME,
  type PreservationJournal,
  type RuntimeDataDirMigrationResult
} from './runtime-data-dir-migration-types'
import {
  fsyncRenameParents,
  pathState,
  retryRuntimeMigrationMutation,
  writeDurableJson
} from './runtime-data-dir-migration-journal-v2'
import {
  readPreservationJournal,
  updatePreservationJournal
} from './runtime-data-dir-migration-journal-preservation'
import {
  assertRuntimeTreeMatchesFingerprint,
  assertRuntimeTreeTimestampsPreserved,
  runtimeStoreInventory,
  runtimeTreeFingerprint,
  uniqueSiblingBackup
} from './runtime-data-dir-migration-inventory'
import {
  assertCandidateCopyCapacity,
  backUpSettingsFile,
  copyRuntimeTreePreservingSource,
  rewriteSettingsToCurrent
} from './runtime-data-dir-migration-copy'
import {
  inspectExtensionRegistryForRebase
} from './runtime-data-dir-migration-extensions'
import {
  salvageDestinationBackup
} from './runtime-data-dir-migration-salvage'
import {
  assertPreservationSettingsSelectionStable,
  type PreservationMigrationOptions,
  validateHistoryPreservingCandidate,
  validateHistoryPreservingTarget,
  writePreservationReport
} from './runtime-data-dir-migration-preservation-validation'



export function continuePreservationMigration(
  initialJournal: PreservationJournal,
  options: PreservationMigrationOptions
): RuntimeDataDirMigrationResult {
  const journalPath = join(options.userDataPath, PRESERVATION_JOURNAL_FILE_NAME)
  let journal = initialJournal
  try {
    if (
      journal.phase === 'candidate-copied' ||
      journal.phase === 'candidate-verified' ||
      journal.phase === 'candidate-rebased' ||
      journal.phase === 'destination-backed-up' ||
      journal.phase === 'destination-salvaged'
    ) {
      assertPreservationSettingsSelectionStable(journal, options)
      options.assertLegacyRuntimeInactive(journal.sourcePath)
      const source = runtimeTreeFingerprint(journal.sourcePath)
      let candidateMatchesSource = true
      if (journal.phase === 'candidate-copied') {
        try {
          candidateMatchesSource =
            runtimeTreeFingerprint(journal.stagingPath).fingerprint === source.fingerprint
        } catch {
          candidateMatchesSource = false
          // Keep the old migration-owned candidate as recovery evidence. A fresh
          // sibling is the only safe retry because an additive copy would retain
          // entries that the trusted source deleted after the first attempt.
        }
      }
      if (
        source.fingerprint !== journal.sourceFingerprint ||
        !candidateMatchesSource
      ) {
        const currentThreadIds = new Set(source.threadIds)
        const missing = journal.sourceThreadIds.filter(
          (threadId) => !currentThreadIds.has(threadId)
        )
        if (missing.length > 0) {
          throw new Error(
            `legacy Runtime source is missing ${missing.length} ` +
            'thread directories recorded before migration'
          )
        }
        if (journal.phase === 'destination-salvaged') {
          const stagingState = pathState(journal.stagingPath)
          const targetState = pathState(journal.targetPath)
          if (stagingState === 'missing' && targetState === 'dir') {
            // Activation may have landed before its journal phase update. Move
            // that uncommitted snapshot back to its original staging path so
            // it remains evidence and the refreshed candidate gets a clean
            // atomic-activation destination.
            assertRuntimeTreeMatchesFingerprint(
              journal.targetPath,
              journal.activationFingerprint,
              'uncommitted Runtime activation'
            )
            retryRuntimeMigrationMutation(
              () => renameSync(journal.targetPath, journal.stagingPath),
              { platform: options.platform, sleep: options.sleep }
            )
            fsyncRenameParents(journal.targetPath, journal.stagingPath)
          } else if (!(stagingState === 'dir' && targetState === 'missing')) {
            throw new Error(
              'stale Runtime candidate activation state is inconsistent with the preservation journal'
            )
          }
        }
        const previousStagingPath = journal.stagingPath
        const replacementStagingPath = uniqueSiblingBackup(
          journal.targetPath,
          'history-preserving-staging',
          options.now
        )
        journal = updatePreservationJournal(
          journalPath,
          journal,
          {
            phase: 'settings-backed-up',
            stagingPath: replacementStagingPath,
            sourceThreadIds: source.threadIds,
            sourceInventory: source.inventory,
            sourceFingerprint: source.fingerprint,
            candidateFingerprint: undefined,
            activationFingerprint: undefined,
            extensionRegistryRebasedRecords: undefined,
            salvaged: 0,
            conflicts: [],
            targetInventory: undefined,
            sqliteQuickCheck: undefined,
            completedAt: undefined,
            runtimeVerifiedAt: undefined,
            error: undefined
          },
          options.now
        )
        options.log('legacy-migration: rebuilding stale Runtime migration candidate', {
          sourcePath: journal.sourcePath,
          previousStagingPath,
          replacementStagingPath,
          sourceFingerprint: source.fingerprint
        })
        options.afterPhase('settings-backed-up')
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
      if (pathState(journal.stagingPath) === 'missing') {
        const displacedHistoryBytes =
          journal.destinationBackupPath && pathState(journal.targetPath) === 'dir'
            ? runtimeStoreInventory(journal.targetPath).bytes
            : 0
        assertCandidateCopyCapacity(
          journal.sourceInventory,
          journal.stagingPath,
          options.availableCopyBytes,
          displacedHistoryBytes
        )
      }
      copyRuntimeTreePreservingSource(journal.sourcePath, journal.stagingPath)
      journal = updatePreservationJournal(
        journalPath,
        journal,
        { phase: 'candidate-copied', error: undefined },
        options.now
      )
      options.afterPhase('candidate-copied')
    }

    if (journal.phase === 'candidate-copied') {
      options.assertLegacyRuntimeInactive(journal.sourcePath)
      const source = runtimeTreeFingerprint(journal.sourcePath)
      const candidate = runtimeTreeFingerprint(journal.stagingPath)
      if (
        source.fingerprint !== journal.sourceFingerprint ||
        candidate.fingerprint !== source.fingerprint
      ) {
        throw new Error(
          'history-preserving Runtime candidate or source fingerprint changed during copy'
        )
      }
      assertRuntimeTreeTimestampsPreserved(journal.sourcePath, journal.stagingPath)
      journal = updatePreservationJournal(
        journalPath,
        journal,
        {
          phase: 'candidate-verified',
          candidateFingerprint: candidate.fingerprint,
          error: undefined
        },
        options.now
      )
      options.afterPhase('candidate-verified')
    }

    if (journal.phase === 'candidate-verified') {
      const inspection = inspectExtensionRegistryForRebase(
        journal.sourcePath,
        journal.targetPath,
        options.platform,
        journal.stagingPath
      )
      if (inspection.kind === 'registry' && inspection.rebasedRecords > 0) {
        writeDurableJson(inspection.path, inspection.document)
      }
      const activation = runtimeTreeFingerprint(journal.stagingPath)
      journal = updatePreservationJournal(
        journalPath,
        journal,
        {
          phase: 'candidate-rebased',
          activationFingerprint: activation.fingerprint,
          extensionRegistryRebasedRecords:
            inspection.kind === 'registry' ? inspection.rebasedRecords : 0,
          error: undefined
        },
        options.now
      )
      options.afterPhase('candidate-rebased')
    }

    if (journal.phase === 'candidate-rebased') {
      assertPreservationSettingsSelectionStable(journal, options)
      const targetState = pathState(journal.targetPath)
      if (journal.destinationBackupPath) {
        const backupState = pathState(journal.destinationBackupPath)
        if (targetState === 'dir' && backupState === 'missing') {
          retryRuntimeMigrationMutation(
            () => renameSync(journal.targetPath, journal.destinationBackupPath!),
            { platform: options.platform, sleep: options.sleep }
          )
          fsyncRenameParents(journal.targetPath, journal.destinationBackupPath)
        } else if (!(targetState === 'missing' && backupState === 'dir')) {
          throw new Error(
            'destination preservation state is inconsistent with the copy migration journal'
          )
        }
      } else if (targetState !== 'missing') {
        throw new Error('unexpected Runtime destination appeared before candidate activation')
      }
      journal = updatePreservationJournal(
        journalPath,
        journal,
        { phase: 'destination-backed-up', error: undefined },
        options.now
      )
      options.afterPhase('destination-backed-up')
    }

    if (journal.phase === 'destination-backed-up') {
      const salvage = salvageDestinationBackup(
        journal.destinationBackupPath,
        journal.stagingPath,
        {
          platform: options.platform,
          sleep: options.sleep
        }
      )
      const activation = runtimeTreeFingerprint(journal.stagingPath)
      journal = updatePreservationJournal(
        journalPath,
        journal,
        {
          phase: 'destination-salvaged',
          activationFingerprint: activation.fingerprint,
          salvaged: salvage.salvaged,
          conflicts: salvage.conflicts,
          error: undefined
        },
        options.now
      )
      options.afterPhase('destination-salvaged')
    }

    if (journal.phase === 'destination-salvaged') {
      assertPreservationSettingsSelectionStable(journal, options)
      options.assertLegacyRuntimeInactive(journal.sourcePath)
      const source = runtimeTreeFingerprint(journal.sourcePath)
      if (source.fingerprint !== journal.sourceFingerprint) {
        throw new Error('legacy Runtime source changed before candidate activation')
      }
      const stagingState = pathState(journal.stagingPath)
      const targetState = pathState(journal.targetPath)
      if (stagingState === 'dir' && targetState === 'missing') {
        validateHistoryPreservingCandidate(journal, options.platform)
        if (!journal.activationFingerprint) {
          const activation = runtimeTreeFingerprint(journal.stagingPath)
          journal = updatePreservationJournal(
            journalPath,
            journal,
            { activationFingerprint: activation.fingerprint, error: undefined },
            options.now
          )
        } else {
          assertRuntimeTreeMatchesFingerprint(
            journal.stagingPath,
            journal.activationFingerprint,
            'verified Runtime candidate activation'
          )
        }
        retryRuntimeMigrationMutation(
          () => renameSync(journal.stagingPath, journal.targetPath),
          { platform: options.platform, sleep: options.sleep }
        )
        fsyncRenameParents(journal.stagingPath, journal.targetPath)
      } else if (stagingState === 'missing' && targetState === 'dir') {
        assertRuntimeTreeMatchesFingerprint(
          journal.targetPath,
          journal.activationFingerprint,
          'uncommitted Runtime activation'
        )
      } else {
        throw new Error('verified Runtime candidate activation state is inconsistent')
      }
      journal = updatePreservationJournal(
        journalPath,
        journal,
        { phase: 'target-activated', error: undefined },
        options.now
      )
      options.afterPhase('target-activated')
    }

    if (journal.phase === 'target-activated') {
      assertPreservationSettingsSelectionStable(journal, options)
      rewriteSettingsToCurrent(journal.settingsWritePath)
      journal = updatePreservationJournal(
        journalPath,
        journal,
        { phase: 'settings-rewritten', error: undefined },
        options.now
      )
      options.afterPhase('settings-rewritten')
    }

    if (journal.phase === 'settings-rewritten') {
      const validation = validateHistoryPreservingTarget(journal)
      const completedAt = options.now().toISOString()
      journal = updatePreservationJournal(
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
      options.log('legacy-migration: committed history-preserving Runtime data migration', {
        sourcePath: journal.sourcePath,
        targetPath: journal.targetPath,
        sourceThreadCount: journal.sourceThreadIds.length,
        sourceFingerprint: journal.sourceFingerprint,
        destinationBackupPath: journal.destinationBackupPath,
        salvaged: journal.salvaged,
        conflicts: journal.conflicts.length
      })
    }

    const reportPath = writePreservationReport(options.userDataPath, journal)
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
      const persisted = readPreservationJournal(journalPath)
      if (persisted) journal = persisted
      journal = updatePreservationJournal(
        journalPath,
        journal,
        { error: message },
        options.now
      )
    } catch {
      // The original error remains authoritative.
    }
    options.log('legacy-migration: history-preserving Runtime migration is blocked', {
      phase: journal.phase,
      message,
      sourcePath: journal.sourcePath,
      targetPath: journal.targetPath,
      stagingPath: journal.stagingPath
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
