import {
  renameSync
} from 'node:fs'
import {
  join
} from 'node:path'
import {
  canonicalLegacyKunDataDir
} from './kun-data-dir-paths'
import {
  PRESERVATION_JOURNAL_FILE_NAME,
  type PreservationJournal,
  type RuntimeDataDirMigrationResult
} from './runtime-data-dir-migration-types'
import {
  fsyncRenameParents,
  pathState,
  retryRuntimeMigrationMutation
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
  threadIds,
  uniqueSiblingBackup
} from './runtime-data-dir-migration-inventory'
import {
  assertCandidateCopyCapacity,
  backUpSettingsFile,
  copyRuntimeTreePreservingSource,
  inventoryContains,
  linkResolvesToTarget,
  validateSqliteIndex
} from './runtime-data-dir-migration-copy'
import {
  assertPreservationSettingsSelectionStable,
  maintainCompletedPreservationMigration,
  type PreservationMigrationOptions
} from './runtime-data-dir-migration-preservation-validation'



export function continueV2ReconstructionMigration(
  initialJournal: PreservationJournal,
  options: PreservationMigrationOptions
): RuntimeDataDirMigrationResult {
  const journalPath = join(options.userDataPath, PRESERVATION_JOURNAL_FILE_NAME)
  const reconstructedPath = canonicalLegacyKunDataDir(
    options.homeDir,
    options.platform
  )
  let journal = initialJournal
  let sourceVerifiedThisRun = false
  try {
    if (
      journal.phase === 'candidate-copied' ||
      journal.phase === 'candidate-verified' ||
      journal.phase === 'legacy-link-backed-up'
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
          // Staging is migration-owned. Preserve the unreadable candidate for
          // recovery evidence and rebuild from the still-authoritative source.
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
            `current Runtime store is missing ${missing.length} ` +
            `threads recorded before the rename migration`
          )
        }
        if (journal.phase === 'legacy-link-backed-up') {
          const stagingState = pathState(journal.stagingPath)
          const reconstructedState = pathState(reconstructedPath)
          if (stagingState === 'missing' && reconstructedState === 'dir') {
            // Preserve a rename that landed before the completed phase update
            // as the old staging evidence, then rebuild from current Runtime.
            assertRuntimeTreeMatchesFingerprint(
              reconstructedPath,
              journal.candidateFingerprint,
              'uncommitted version-2 reconstruction activation'
            )
            retryRuntimeMigrationMutation(
              () => renameSync(reconstructedPath, journal.stagingPath),
              { platform: options.platform, sleep: options.sleep }
            )
            fsyncRenameParents(reconstructedPath, journal.stagingPath)
          } else if (stagingState === 'dir' && reconstructedState === 'missing') {
            assertRuntimeTreeMatchesFingerprint(
              journal.stagingPath,
              journal.candidateFingerprint,
              'version-2 reconstruction candidate'
            )
          } else {
            throw new Error(
              'stale version-2 reconstruction activation state is inconsistent'
            )
          }
        }
        const previousStagingPath = journal.stagingPath
        const replacementStagingPath = uniqueSiblingBackup(
          reconstructedPath,
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
        options.log(
          'legacy-migration: rebuilding stale version-2 history reconstruction candidate',
          {
            sourcePath: journal.sourcePath,
            previousStagingPath,
            replacementStagingPath,
            sourceFingerprint: source.fingerprint
          }
        )
        options.afterPhase('settings-backed-up')
      }
    }

    if (journal.phase === 'prepared') {
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
        assertCandidateCopyCapacity(
          journal.sourceInventory,
          journal.stagingPath,
          options.availableCopyBytes
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
          'version-2 history reconstruction source or candidate fingerprint changed'
        )
      }
      assertRuntimeTreeTimestampsPreserved(journal.sourcePath, journal.stagingPath)
      const currentThreadIds = new Set(source.threadIds)
      const missing = journal.sourceThreadIds.filter(
        (threadId) => !currentThreadIds.has(threadId)
      )
      if (missing.length > 0) {
        throw new Error(
          `current Runtime store is missing ${missing.length} ` +
          `threads recorded before the rename migration`
        )
      }
      sourceVerifiedThisRun = true
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
      assertPreservationSettingsSelectionStable(journal, options)
      options.assertLegacyRuntimeInactive(journal.sourcePath)
      if (!sourceVerifiedThisRun) {
        const source = runtimeTreeFingerprint(journal.sourcePath)
        if (source.fingerprint !== journal.sourceFingerprint) {
          throw new Error('current Runtime store changed before history reconstruction activation')
        }
      }
      assertRuntimeTreeMatchesFingerprint(
        journal.stagingPath,
        journal.candidateFingerprint,
        'verified version-2 reconstruction candidate'
      )
      const legacyState = pathState(reconstructedPath)
      const backupState = journal.compatibilityLinkBackupPath
        ? pathState(journal.compatibilityLinkBackupPath)
        : 'missing'
      if (journal.compatibilityLinkBackupPath) {
        if (legacyState === 'symlink' && backupState === 'missing') {
          if (!linkResolvesToTarget(reconstructedPath, journal.targetPath, options.platform)) {
            throw new Error('version-2 compatibility link no longer resolves to the current store')
          }
          retryRuntimeMigrationMutation(
            () => renameSync(reconstructedPath, journal.compatibilityLinkBackupPath!),
            { platform: options.platform, sleep: options.sleep }
          )
          fsyncRenameParents(reconstructedPath, journal.compatibilityLinkBackupPath)
        } else if (!(legacyState === 'missing' && backupState === 'symlink')) {
          throw new Error('version-2 compatibility-link preservation state is inconsistent')
        }
      } else if (legacyState !== 'missing') {
        throw new Error('version-2 legacy reconstruction destination is no longer empty')
      }
      journal = updatePreservationJournal(
        journalPath,
        journal,
        { phase: 'legacy-link-backed-up', error: undefined },
        options.now
      )
      options.afterPhase('legacy-link-backed-up')
    }

    if (journal.phase === 'legacy-link-backed-up') {
      assertPreservationSettingsSelectionStable(journal, options)
      options.assertLegacyRuntimeInactive(journal.sourcePath)
      const source = runtimeTreeFingerprint(journal.sourcePath)
      if (source.fingerprint !== journal.sourceFingerprint) {
        throw new Error('current Runtime store changed before history reconstruction activation')
      }
      const stagingState = pathState(journal.stagingPath)
      const legacyState = pathState(reconstructedPath)
      if (stagingState === 'dir' && legacyState === 'missing') {
        assertRuntimeTreeMatchesFingerprint(
          journal.stagingPath,
          journal.candidateFingerprint,
          'verified version-2 reconstruction activation'
        )
        retryRuntimeMigrationMutation(
          () => renameSync(journal.stagingPath, reconstructedPath),
          { platform: options.platform, sleep: options.sleep }
        )
        fsyncRenameParents(journal.stagingPath, reconstructedPath)
      } else if (stagingState === 'missing' && legacyState === 'dir') {
        assertRuntimeTreeMatchesFingerprint(
          reconstructedPath,
          journal.candidateFingerprint,
          'uncommitted version-2 reconstruction activation'
        )
      } else {
        throw new Error('reconstructed legacy Runtime activation state is inconsistent')
      }
      const reconstructedThreadIds = new Set(threadIds(reconstructedPath))
      const missing = journal.sourceThreadIds.filter(
        (threadId) => !reconstructedThreadIds.has(threadId)
      )
      if (missing.length > 0) {
        throw new Error('activated reconstructed legacy Runtime history is incomplete')
      }
      if (!inventoryContains(
        runtimeStoreInventory(reconstructedPath),
        journal.sourceInventory
      )) {
        throw new Error('activated reconstructed legacy Runtime inventory is incomplete')
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
      sourcePath: reconstructedPath,
      targetPath: journal.targetPath,
      journalPath,
      message
    }
  }
}
