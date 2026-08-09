import {
  mkdirSync
} from 'node:fs'
import {
  createHash
} from 'node:crypto'
import {
  join
} from 'node:path'
import {
  canonicalCurrentKunDataDir,
  canonicalLegacyKunDataDir
} from './kun-data-dir-paths'
import {
  JOURNAL_FILE_NAME,
  PRESERVATION_JOURNAL_FILE_NAME,
  PRESERVATION_SCHEMA_VERSION,
  type PreservationJournal,
  type RuntimeDataDirMigrationOptions,
  type RuntimeDataDirMigrationResult
} from './runtime-data-dir-migration-types'
import {
  defaultSleep,
  pathState,
  readJournal,
  writeDurableJson
} from './runtime-data-dir-migration-journal-v2'
import {
  readPreservationJournal,
  validatePreservationJournalForRecovery
} from './runtime-data-dir-migration-journal-preservation'
import {
  readSettingsSelection,
  runtimeTreeFingerprint,
  threadIds,
  uniqueSiblingBackup
} from './runtime-data-dir-migration-inventory'
import {
  availableFilesystemBytes,
  backUpSettingsFile,
  linkResolvesToTarget,
  rewriteSettingsToCurrent,
  validateSqliteIndex
} from './runtime-data-dir-migration-copy'
import {
  maintainCompletedPreservationMigration,
  type PreservationMigrationOptions
} from './runtime-data-dir-migration-preservation-validation'
import {
  continuePreservationMigration
} from './runtime-data-dir-migration-preservation-copy'
import {
  continueCurrentAuthorityMerge
} from './runtime-data-dir-migration-preservation-current'
import {
  continueV2ReconstructionMigration
} from './runtime-data-dir-migration-preservation-reconstruction'



export function runPreservationMigrationIfNeeded(
  input: RuntimeDataDirMigrationOptions
): RuntimeDataDirMigrationResult | null {
  const platform = input.platform ?? process.platform
  const log = input.log ?? (() => undefined)
  const now = input.now ?? (() => new Date())
  const sleep = input.sleep ?? defaultSleep
  const assertLegacyRuntimeInactive = input.assertLegacyRuntimeInactive ?? (() => undefined)
  const sourcePath = canonicalLegacyKunDataDir(input.homeDir, platform)
  const targetPath = canonicalCurrentKunDataDir(input.homeDir, platform)
  const sourceState = pathState(sourcePath)
  const targetState = pathState(targetPath)
  const journalPath = join(input.userDataPath, PRESERVATION_JOURNAL_FILE_NAME)
  const initialSelection = readSettingsSelection(
    input.userDataPath,
    input.homeDir,
    platform,
    sourceState
  )
  // Interrupted canonical migrations are irrelevant after the user explicitly
  // selects a custom Runtime store. Preserve every canonical journal and tree,
  // but do not validate, resume, drain, or recover them on the custom path's
  // startup. Unknown authority still follows the fail-closed path below.
  if (initialSelection.authority === 'custom') {
    const v2JournalPath = join(input.userDataPath, JOURNAL_FILE_NAME)
    return {
      status: 'not-needed',
      authority: 'custom',
      sourcePath,
      targetPath,
      journalPath: pathState(journalPath) === 'missing' ? v2JournalPath : journalPath
    }
  }
  const journalState = pathState(journalPath)
  const existingJournal = readPreservationJournal(journalPath)
  const options: PreservationMigrationOptions = {
    userDataPath: input.userDataPath,
    homeDir: input.homeDir,
    platform,
    log,
    now,
    sleep,
    assertLegacyRuntimeInactive,
    afterPhase: input.afterPreservationPhase ?? (() => undefined),
    availableCopyBytes: input.availableCopyBytes ?? availableFilesystemBytes
  }

  if (journalState === 'inaccessible' || (journalState === 'other' && !existingJournal)) {
    return {
      status: 'blocked',
      authority: 'unknown',
      sourcePath,
      targetPath,
      journalPath,
      message: 'the Runtime preservation journal is inaccessible or invalid'
    }
  }
  if (existingJournal) {
    const journalError = validatePreservationJournalForRecovery(existingJournal, {
      userDataPath: input.userDataPath,
      homeDir: input.homeDir,
      platform
    })
    if (journalError) {
      return {
        status: 'blocked',
        authority: 'unknown',
        sourcePath,
        targetPath,
        journalPath,
        message: journalError
      }
    }
    return existingJournal.phase === 'completed'
      ? maintainCompletedPreservationMigration(existingJournal, options)
      : existingJournal.provenance === 'reconstructed-from-current'
        ? continueV2ReconstructionMigration(existingJournal, options)
        : existingJournal.mergeIntoCurrent
          ? continueCurrentAuthorityMerge(existingJournal, options)
          : continuePreservationMigration(existingJournal, options)
  }

  // A version-2 journal represents a migration that started under the old
  // rename/link state machine. Never resume that state machine in production:
  // copy a real source through v3, or reconstruct an independent source from
  // the already-promoted current store.
  const v2JournalPath = join(input.userDataPath, JOURNAL_FILE_NAME)
  if (pathState(v2JournalPath) !== 'missing') {
    const v2Journal = readJournal(v2JournalPath)
    if (!v2Journal) {
      return {
        status: 'blocked',
        authority: 'unknown',
        sourcePath,
        targetPath,
        journalPath: v2JournalPath,
        message: 'the version-2 Runtime migration journal is invalid'
      }
    }
    const compatibilityLinkIsValid =
      sourceState === 'symlink' &&
      targetState === 'dir' &&
      linkResolvesToTarget(sourcePath, targetPath, platform)
    if (sourceState === 'symlink' && !compatibilityLinkIsValid) {
      return {
        status: 'blocked',
        authority: 'unknown',
        sourcePath,
        targetPath,
        journalPath: v2JournalPath,
        message: 'the version-2 Runtime compatibility link is not canonical'
      }
    }
    if (
      targetState === 'dir' &&
      (sourceState === 'missing' || compatibilityLinkIsValid)
    ) {
      const selection = readSettingsSelection(
        input.userDataPath,
        input.homeDir,
        platform,
        sourceState
      )
      if (selection.authority === 'custom') {
        return {
          status: 'not-needed',
          authority: 'custom',
          sourcePath,
          targetPath,
          journalPath: v2JournalPath
        }
      }
      if (selection.authority === 'unknown') {
        return {
          status: 'blocked',
          authority: 'unknown',
          sourcePath,
          targetPath,
          journalPath: v2JournalPath,
          message: 'could not determine Runtime data authority before history reconstruction'
        }
      }
      const currentThreadIds = new Set(threadIds(targetPath))
      const missing = v2Journal.sourceThreadIds.filter(
        (threadId) => !currentThreadIds.has(threadId)
      )
      if (missing.length > 0) {
        return {
          status: 'blocked',
          authority: 'current',
          sourcePath,
          targetPath,
          journalPath: v2JournalPath,
          message:
            `current Runtime store is missing ${missing.length} ` +
            `threads recorded before the rename migration`
        }
      }
      try {
        assertLegacyRuntimeInactive(targetPath)
        const source = runtimeTreeFingerprint(targetPath)
        const startedAt = now().toISOString()
        const reconstruction: PreservationJournal = {
          schemaVersion: PRESERVATION_SCHEMA_VERSION,
          phase: 'prepared',
          provenance: 'reconstructed-from-current',
          sourcePath: targetPath,
          targetPath,
          stagingPath: uniqueSiblingBackup(
            sourcePath,
            'history-preserving-staging',
            now
          ),
          ...(compatibilityLinkIsValid
            ? {
                compatibilityLinkBackupPath: uniqueSiblingBackup(
                  sourcePath,
                  'pre-preservation-compatibility-link',
                  now
                )
              }
            : {}),
          settingsSourcePath: selection.sourcePath,
          settingsWritePath: selection.writePath,
          settingsBackupPaths: [],
          sourceThreadIds: v2Journal.sourceThreadIds,
          sourceInventory: source.inventory,
          sourceFingerprint: source.fingerprint,
          salvaged: 0,
          conflicts: [],
          startedAt,
          updatedAt: startedAt
        }
        writeDurableJson(journalPath, reconstruction)
        options.afterPhase('prepared')
        return continueV2ReconstructionMigration(reconstruction, options)
      } catch (error) {
        return {
          status: 'blocked',
          authority: 'current',
          sourcePath,
          targetPath,
          journalPath,
          message: error instanceof Error ? error.message : String(error)
        }
      }
    }
    if (sourceState !== 'dir') {
      return {
        status: 'blocked',
        authority: 'unknown',
        sourcePath,
        targetPath,
        journalPath: v2JournalPath,
        message:
          'the version-2 Runtime migration state has no independently readable history source'
      }
    }
  }

  const selection = readSettingsSelection(
    input.userDataPath,
    input.homeDir,
    platform,
    sourceState
  )
  if (selection.authority === 'custom' || selection.authority === 'unknown') return null
  if (
    selection.authority === 'current' &&
    targetState !== 'dir' &&
    targetState !== 'missing'
  ) {
    return {
      status: 'blocked',
      authority: 'current',
      sourcePath,
      targetPath,
      journalPath,
      message: 'settings select the canonical Runtime directory but that path is not a directory'
    }
  }
  if (
    selection.authority === 'current' &&
    targetState === 'missing' &&
    sourceState !== 'dir' &&
    sourceState !== 'missing'
  ) {
    return {
      status: 'blocked',
      authority: 'current',
      sourcePath,
      targetPath,
      journalPath,
      message: 'settings select a missing Runtime directory and the preserved history path is not recoverable'
    }
  }
  if (sourceState === 'symlink') {
    if (
      targetState !== 'dir' ||
      !linkResolvesToTarget(sourcePath, targetPath, platform)
    ) {
      return {
        status: 'blocked',
        authority: selection.authority,
        sourcePath,
        targetPath,
        journalPath,
        message: 'the legacy Runtime path is an unexpected symbolic link'
      }
    }
    try {
      assertLegacyRuntimeInactive(targetPath)
      const source = runtimeTreeFingerprint(targetPath)
      const startedAt = now().toISOString()
      const reconstruction: PreservationJournal = {
        schemaVersion: PRESERVATION_SCHEMA_VERSION,
        phase: 'prepared',
        provenance: 'reconstructed-from-current',
        sourcePath: targetPath,
        targetPath,
        stagingPath: uniqueSiblingBackup(
          sourcePath,
          'history-preserving-staging',
          now
        ),
        compatibilityLinkBackupPath: uniqueSiblingBackup(
          sourcePath,
          'pre-preservation-compatibility-link',
          now
        ),
        settingsSourcePath: selection.sourcePath,
        settingsWritePath: selection.writePath,
        settingsBackupPaths: [],
        sourceThreadIds: source.threadIds,
        sourceInventory: source.inventory,
        sourceFingerprint: source.fingerprint,
        salvaged: 0,
        conflicts: [],
        startedAt,
        updatedAt: startedAt
      }
      writeDurableJson(journalPath, reconstruction)
      options.afterPhase('prepared')
      return continueV2ReconstructionMigration(reconstruction, options)
    } catch (error) {
      return {
        status: 'blocked',
        authority: selection.authority,
        sourcePath,
        targetPath,
        journalPath,
        message: error instanceof Error ? error.message : String(error)
      }
    }
  }
  if (sourceState === 'other' || sourceState === 'inaccessible') {
    return {
      status: 'blocked',
      authority: selection.authority,
      sourcePath,
      targetPath,
      journalPath,
      message: 'the legacy Runtime history path is not a readable directory'
    }
  }
  if (
    selection.authority === 'legacy' &&
    sourceState === 'missing' &&
    targetState !== 'missing' &&
    targetState !== 'dir'
  ) {
    return {
      status: 'blocked',
      authority: 'legacy',
      sourcePath,
      targetPath,
      journalPath,
      message: 'the canonical Runtime destination is not a readable directory'
    }
  }

  if (
    selection.authority === 'legacy' &&
    sourceState === 'missing' &&
    (targetState === 'missing' || targetState === 'dir')
  ) {
    try {
      if (targetState === 'missing') {
        mkdirSync(targetPath, { recursive: true, mode: 0o700 })
      }
      const target = runtimeTreeFingerprint(targetPath)
      const settingsBackupPaths = backUpSettingsFile(selection.writePath, now)
      rewriteSettingsToCurrent(selection.writePath)
      const completedAt = now().toISOString()
      const noSourceFingerprint = createHash('sha256')
        .update('no-legacy-source')
        .digest('hex')
      const journal: PreservationJournal = {
        schemaVersion: PRESERVATION_SCHEMA_VERSION,
        phase: 'completed',
        provenance: 'no-legacy-source',
        sourcePath,
        targetPath,
        stagingPath: uniqueSiblingBackup(
          targetPath,
          'history-preserving-staging',
          now
        ),
        settingsSourcePath: selection.sourcePath,
        settingsWritePath: selection.writePath,
        settingsBackupPaths,
        sourceThreadIds: [],
        sourceInventory: {
          files: 0,
          directories: 0,
          symlinks: 0,
          bytes: 0
        },
        sourceFingerprint: noSourceFingerprint,
        candidateFingerprint: target.fingerprint,
        salvaged: 0,
        conflicts: [],
        targetInventory: target.inventory,
        sqliteQuickCheck: validateSqliteIndex(targetPath),
        startedAt: completedAt,
        updatedAt: completedAt,
        completedAt
      }
      writeDurableJson(journalPath, journal)
      return maintainCompletedPreservationMigration(journal, options)
    } catch (error) {
      return {
        status: 'blocked',
        authority: 'legacy',
        sourcePath,
        targetPath,
        journalPath,
        message: error instanceof Error ? error.message : String(error)
      }
    }
  }

  if (
    selection.authority === 'current' &&
    sourceState === 'dir' &&
    targetState === 'dir'
  ) {
    const source = runtimeTreeFingerprint(sourcePath)
    const target = runtimeTreeFingerprint(targetPath)
    const targetThreadIds = new Set(threadIds(targetPath))
    const missing = source.threadIds.filter((threadId) => !targetThreadIds.has(threadId))
    if (missing.length > 0) {
      log('legacy-migration: current Runtime store does not include all preserved history', {
        sourcePath,
        targetPath,
        missingThreadCount: missing.length
      })
      const startedAt = now().toISOString()
      const journal: PreservationJournal = {
        schemaVersion: PRESERVATION_SCHEMA_VERSION,
        phase: 'prepared',
        provenance: 'original-legacy-source',
        sourcePath,
        targetPath,
        stagingPath: uniqueSiblingBackup(
          targetPath,
          'history-preserving-staging',
          now
        ),
        settingsSourcePath: selection.sourcePath,
        settingsWritePath: selection.writePath,
        settingsBackupPaths: [],
        mergeIntoCurrent: true,
        sourceThreadIds: source.threadIds,
        sourceInventory: source.inventory,
        sourceFingerprint: source.fingerprint,
        salvaged: 0,
        conflicts: [],
        startedAt,
        updatedAt: startedAt
      }
      writeDurableJson(journalPath, journal)
      options.afterPhase('prepared')
      return continueCurrentAuthorityMerge(journal, options)
    }
    const completedAt = now().toISOString()
    const journal: PreservationJournal = {
      schemaVersion: PRESERVATION_SCHEMA_VERSION,
      phase: 'completed',
      provenance: 'original-legacy-source',
      sourcePath,
      targetPath,
      stagingPath: uniqueSiblingBackup(
        targetPath,
        'history-preserving-staging',
        now
      ),
      settingsSourcePath: selection.sourcePath,
      settingsWritePath: selection.writePath,
      settingsBackupPaths: [],
      sourceThreadIds: source.threadIds,
      sourceInventory: source.inventory,
      sourceFingerprint: source.fingerprint,
      candidateFingerprint: target.fingerprint,
      salvaged: 0,
      conflicts: [],
      targetInventory: target.inventory,
      sqliteQuickCheck: validateSqliteIndex(targetPath),
      startedAt: completedAt,
      updatedAt: completedAt,
      completedAt
    }
    writeDurableJson(journalPath, journal)
    return maintainCompletedPreservationMigration(journal, options)
  }

  const recoverMissingCurrentFromLegacy =
    selection.authority === 'current' &&
    targetState === 'missing' &&
    sourceState === 'dir'
  if (
    (selection.authority !== 'legacy' && !recoverMissingCurrentFromLegacy) ||
    sourceState !== 'dir'
  ) return null
  if (targetState !== 'missing' && targetState !== 'dir') {
    return {
      status: 'blocked',
      authority: 'legacy',
      sourcePath,
      targetPath,
      journalPath,
      message: 'canonical Runtime destination is not a regular directory or missing path'
    }
  }

  try {
    assertLegacyRuntimeInactive(sourcePath)
    if (targetState === 'dir') assertLegacyRuntimeInactive(targetPath)
    const source = runtimeTreeFingerprint(sourcePath)
    const startedAt = now().toISOString()
    const journal: PreservationJournal = {
      schemaVersion: PRESERVATION_SCHEMA_VERSION,
      phase: 'prepared',
      provenance: 'original-legacy-source',
      sourcePath,
      targetPath,
      stagingPath: uniqueSiblingBackup(
        targetPath,
        'history-preserving-staging',
        now
      ),
      ...(targetState === 'dir'
        ? {
            destinationBackupPath: uniqueSiblingBackup(
              targetPath,
              'pre-history-preserving-migration',
              now
            )
          }
        : {}),
      settingsSourcePath: selection.sourcePath,
      settingsWritePath: selection.writePath,
      settingsBackupPaths: [],
      sourceThreadIds: source.threadIds,
      sourceInventory: source.inventory,
      sourceFingerprint: source.fingerprint,
      salvaged: 0,
      conflicts: [],
      startedAt,
      updatedAt: startedAt
    }
    writeDurableJson(journalPath, journal)
    options.afterPhase('prepared')
    return continuePreservationMigration(journal, options)
  } catch (error) {
    return {
      status: 'blocked',
      authority: 'legacy',
      sourcePath,
      targetPath,
      journalPath,
      message: error instanceof Error ? error.message : String(error)
    }
  }
}
