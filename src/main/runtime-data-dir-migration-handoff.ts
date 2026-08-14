import {
  statSync
} from 'node:fs'
import {
  join
} from 'node:path'
import {
  canonicalCurrentKunDataDir,
  canonicalLegacyKunDataDir
} from './kun-data-dir-paths'
import {
  acceptRuntimeDataRecoveryCompletion,
  type RuntimeDataRecoveryAcceptanceCheck,
  type RuntimeDataRecoveryCompletionCheck,
  validateAcceptedRuntimeDataRecovery,
  validateRuntimeDataRecoveryCompletion
} from './runtime-data-dir-recovery'
import {
  JOURNAL_FILE_NAME,
  MIGRATION_SCHEMA_VERSION,
  PRESERVATION_JOURNAL_FILE_NAME,
  type RuntimeDataDirMigrationOptions,
  type RuntimeDataDirMigrationResult,
  type RuntimeMigrationJournal
} from './runtime-data-dir-migration-types'
import {
  defaultSleep,
  pathState,
  readJournal,
  validateJournalForRecovery,
  writeDurableJson
} from './runtime-data-dir-migration-journal-v2'
import {
  updateJournal
} from './runtime-data-dir-migration-journal-preservation'
import {
  readSettingsSelection,
  runtimeStoreInventory,
  threadIds,
  uniqueSiblingBackup
} from './runtime-data-dir-migration-inventory'
import {
  assertSameVolume,
  backUpSettingsFile,
  linkResolvesToTarget,
  rewriteSettingsToCurrent
} from './runtime-data-dir-migration-copy'
import {
  continueMigration,
  maintainCompletedMigration
} from './runtime-data-dir-migration-v2'



export type RuntimeDataRecoveryHandoffInspection = {
  accepted: RuntimeDataRecoveryAcceptanceCheck
  completion: RuntimeDataRecoveryCompletionCheck
  present: boolean
}

export function inspectRuntimeDataRecoveryHandoff(
  input: Pick<RuntimeDataDirMigrationOptions, 'userDataPath' | 'homeDir' | 'platform'>
): RuntimeDataRecoveryHandoffInspection {
  const accepted = validateAcceptedRuntimeDataRecovery(input)
  const completion = accepted.status === 'valid'
    ? { status: 'none' } as const
    : validateRuntimeDataRecoveryCompletion(input)
  return {
    accepted,
    completion,
    present: accepted.status !== 'none' || completion.status !== 'none'
  }
}

/**
 * Completes the recovery -> normal-startup authority handoff without ever
 * rewriting or deleting the blocked v2/v3 journals. The caller's startup
 * preflight holds the shared writer fence whenever this function can mutate
 * settings or create the one-time acceptance seal.
 */
export function finishRuntimeDataRecoveryHandoffIfPresent(
  input: RuntimeDataDirMigrationOptions
): RuntimeDataDirMigrationResult | null {
  const platform = input.platform ?? process.platform
  const sourcePath = canonicalLegacyKunDataDir(input.homeDir, platform)
  const targetPath = canonicalCurrentKunDataDir(input.homeDir, platform)
  const journalPath = join(input.userDataPath, PRESERVATION_JOURNAL_FILE_NAME)
  const handoff = inspectRuntimeDataRecoveryHandoff(input)
  if (!handoff.present) return null

  const selection = readSettingsSelection(
    input.userDataPath,
    input.homeDir,
    platform,
    pathState(sourcePath)
  )
  if (selection.authority === 'custom') {
    return {
      status: 'not-needed',
      authority: 'custom',
      sourcePath,
      targetPath,
      journalPath,
      message: 'A custom Runtime data directory remains authoritative; canonical recovery evidence was preserved.'
    }
  }
  if (selection.authority === 'unknown') {
    return {
      status: 'blocked',
      authority: 'unknown',
      sourcePath,
      targetPath,
      journalPath,
      message: 'Runtime recovery completed, but the active Runtime data authority could not be determined safely.'
    }
  }

  if (handoff.accepted.status !== 'valid' && handoff.completion.status !== 'valid') {
    const reason = handoff.accepted.status === 'invalid'
      ? handoff.accepted.reason
      : handoff.completion.status === 'invalid'
        ? handoff.completion.reason
        : 'recovery evidence is incomplete'
    return {
      status: 'blocked',
      authority: 'unknown',
      sourcePath,
      targetPath,
      journalPath,
      message: `Runtime recovery handoff validation failed (${reason}). Preserved evidence was not changed.`
    }
  }

  const now = input.now ?? (() => new Date())
  if (selection.authority === 'legacy' && selection.writePath) {
    backUpSettingsFile(selection.writePath, now)
    rewriteSettingsToCurrent(selection.writePath)
  }

  let accepted = handoff.accepted
  if (accepted.status !== 'valid') {
    accepted = acceptRuntimeDataRecoveryCompletion({
      userDataPath: input.userDataPath,
      homeDir: input.homeDir,
      platform,
      now
    })
  }
  if (accepted.status !== 'valid') {
    const reason = accepted.status === 'invalid'
      ? accepted.reason
      : 'acceptance record unavailable'
    return {
      status: 'blocked',
      authority: 'unknown',
      sourcePath,
      targetPath,
      journalPath,
      message: `Runtime recovery could not be accepted safely (${reason}). Preserved evidence was not changed.`
    }
  }

  return {
    status: 'completed',
    authority: 'current',
    sourcePath,
    targetPath,
    journalPath,
    message: 'Runtime data recovery was accepted; preserved migration journals remain unchanged.'
  }
}

export function runCanonicalKunRuntimeDataMigrationUnsafe(
  input: RuntimeDataDirMigrationOptions
): RuntimeDataDirMigrationResult {
  const platform = input.platform ?? process.platform
  const log = input.log ?? (() => undefined)
  const now = input.now ?? (() => new Date())
  const sleep = input.sleep ?? defaultSleep
  const assertLegacyRuntimeInactive = input.assertLegacyRuntimeInactive ?? (() => undefined)
  const sourcePath = canonicalLegacyKunDataDir(input.homeDir, platform)
  const targetPath = canonicalCurrentKunDataDir(input.homeDir, platform)
  const journalPath = join(input.userDataPath, JOURNAL_FILE_NAME)
  const journalState = pathState(journalPath)
  let existingJournal = readJournal(journalPath)
  const sourceState = pathState(sourcePath)
  const targetState = pathState(targetPath)
  const settingsSelection = readSettingsSelection(
    input.userDataPath,
    input.homeDir,
    platform,
    sourceState
  )
  if (settingsSelection.authority === 'custom') {
    return {
      status: 'not-needed',
      authority: 'custom',
      sourcePath,
      targetPath,
      journalPath
    }
  }
  if (journalState === 'inaccessible' || (journalState === 'other' && !existingJournal)) {
    return {
      status: 'blocked',
      authority: 'unknown',
      sourcePath,
      targetPath,
      journalPath,
      message: 'the Runtime migration journal is inaccessible or invalid'
    }
  }
  if (existingJournal) {
    const journalError = validateJournalForRecovery(existingJournal, {
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
    if (existingJournal.phase !== 'completed') {
      const recoveredSettings = readSettingsSelection(
        input.userDataPath,
        input.homeDir,
        platform,
        pathState(existingJournal.sourcePath)
      )
      const needsSettingsSource =
        !existingJournal.settingsSourcePath &&
        !existingJournal.settingsWritePath &&
        recoveredSettings.sourcePath !== undefined
      const needsSourceState =
        existingJournal.sourceWasMissing === undefined &&
        pathState(existingJournal.sourcePath) === 'symlink' &&
        linkResolvesToTarget(existingJournal.sourcePath, existingJournal.targetPath, platform)
      if (needsSettingsSource || needsSourceState) {
        existingJournal = updateJournal(
          journalPath,
          existingJournal,
          {
            ...(needsSettingsSource
              ? {
                  settingsSourcePath: recoveredSettings.sourcePath,
                  settingsWritePath: recoveredSettings.writePath
                }
              : {}),
            ...(needsSourceState ? { sourceWasMissing: true } : {})
          },
          now
        )
      }
    }
    if (existingJournal.phase === 'completed') {
      return maintainCompletedMigration(existingJournal, {
        userDataPath: input.userDataPath,
        homeDir: input.homeDir,
        platform,
        log,
        now,
        sleep,
        assertLegacyRuntimeInactive
      })
    }
    return continueMigration(existingJournal, {
      userDataPath: input.userDataPath,
      homeDir: input.homeDir,
      platform,
      log,
      now,
      sleep,
      assertLegacyRuntimeInactive,
      afterPhase: input.afterPhase ?? (() => undefined),
      beforeCompatibilityLink: input.beforeCompatibilityLink ?? (() => undefined)
    })
  }

  if (sourceState === 'inaccessible' || targetState === 'inaccessible') {
    return {
      status: 'blocked',
      authority: 'unknown',
      sourcePath,
      targetPath,
      journalPath,
      message: 'a canonical Runtime path is inaccessible'
    }
  }
  let authority = settingsSelection.authority

  if (authority === 'unknown') {
    return {
      status: sourceState === 'missing' ? 'not-needed' : 'blocked',
      authority,
      sourcePath,
      targetPath,
      journalPath,
      ...(sourceState === 'missing' ? {} : { message: 'could not determine Runtime data authority from settings' })
    }
  }

  if (authority === 'current' && targetState === 'missing' && sourceState === 'dir') {
    // A previous settings repair can select the new default before legacy
    // Runtime data has been promoted. The existing legacy store is the only
    // available canonical authority, so recover it instead of blocking every
    // subsequent startup.
    authority = 'legacy'
  }

  if (authority === 'current') {
    if (targetState !== 'dir') {
      const genuinelyFresh = sourceState === 'missing' && targetState === 'missing'
      return {
        status: genuinelyFresh ? 'not-needed' : 'blocked',
        authority,
        sourcePath,
        targetPath,
        journalPath,
        ...(genuinelyFresh ? {} : { message: 'settings select the new Runtime directory but it is unavailable' })
      }
    }
    if (sourceState === 'missing') {
      return { status: 'not-needed', authority, sourcePath, targetPath, journalPath }
    }
    if (sourceState === 'symlink') {
      if (!linkResolvesToTarget(sourcePath, targetPath, platform)) {
        return {
          status: 'blocked',
          authority,
          sourcePath,
          targetPath,
          journalPath,
          message: 'legacy Runtime path is an unexpected symbolic link'
        }
      }
    }
    if (sourceState !== 'dir' && sourceState !== 'symlink') {
      return {
        status: 'blocked',
        authority,
        sourcePath,
        targetPath,
        journalPath,
        message: 'legacy Runtime path is neither a directory nor a compatible link'
      }
    }
    const completedAt = now().toISOString()
    const journal: RuntimeMigrationJournal = {
      schemaVersion: MIGRATION_SCHEMA_VERSION,
      phase: 'completed',
      sourcePath,
      targetPath,
      cutoverConflictBackupPaths: [],
      settingsSourcePath: settingsSelection.sourcePath,
      settingsWritePath: settingsSelection.writePath,
      settingsBackupPaths: [],
      settingsBackedUp: true,
      extensionRegistryBackupPaths: [],
      sourceThreadIds: [],
      salvaged: 0,
      conflicts: [],
      startedAt: completedAt,
      updatedAt: completedAt,
      completedAt
    }
    writeDurableJson(journalPath, journal)
    return maintainCompletedMigration(journal, {
      userDataPath: input.userDataPath,
      homeDir: input.homeDir,
      platform,
      log,
      now,
      sleep,
      assertLegacyRuntimeInactive
    })
  }

  if (sourceState === 'symlink') {
    if (!linkResolvesToTarget(sourcePath, targetPath, platform)) {
      return {
        status: 'blocked',
        authority,
        sourcePath,
        targetPath,
        journalPath,
        message: 'legacy Runtime path is an unexpected symbolic link'
      }
    }
    const startedAt = now().toISOString()
    const journal: RuntimeMigrationJournal = {
      schemaVersion: MIGRATION_SCHEMA_VERSION,
      phase: 'link-created',
      sourcePath,
      targetPath,
      cutoverConflictBackupPaths: [],
      settingsSourcePath: settingsSelection.sourcePath,
      settingsWritePath: settingsSelection.writePath,
      settingsBackupPaths: [],
      settingsBackedUp: false,
      extensionRegistryBackupPaths: [],
      sourceWasMissing: true,
      sourceThreadIds: threadIds(targetPath),
      sourceInventory: runtimeStoreInventory(targetPath),
      salvaged: 0,
      conflicts: [],
      startedAt,
      updatedAt: startedAt
    }
    writeDurableJson(journalPath, journal)
    return continueMigration(journal, {
      userDataPath: input.userDataPath,
      homeDir: input.homeDir,
      platform,
      log,
      now,
      sleep,
      assertLegacyRuntimeInactive,
      afterPhase: input.afterPhase ?? (() => undefined),
      beforeCompatibilityLink: input.beforeCompatibilityLink ?? (() => undefined)
    })
  }

  if (sourceState !== 'dir') {
    if (sourceState === 'missing' && targetState === 'dir') {
      const startedAt = now().toISOString()
      const journal: RuntimeMigrationJournal = {
        schemaVersion: MIGRATION_SCHEMA_VERSION,
        phase: 'source-promoted',
        sourcePath,
        targetPath,
        cutoverConflictBackupPaths: [],
        settingsSourcePath: settingsSelection.sourcePath,
        settingsWritePath: settingsSelection.writePath,
        settingsBackupPaths: [],
        settingsBackedUp: false,
        extensionRegistryBackupPaths: [],
        sourceWasMissing: true,
        sourceThreadIds: threadIds(targetPath),
        sourceInventory: runtimeStoreInventory(targetPath),
        salvaged: 0,
        conflicts: [],
        startedAt,
        updatedAt: startedAt
      }
      writeDurableJson(journalPath, journal)
      return continueMigration(journal, {
        userDataPath: input.userDataPath,
        homeDir: input.homeDir,
        platform,
        log,
        now,
        sleep,
        assertLegacyRuntimeInactive,
        afterPhase: input.afterPhase ?? (() => undefined),
        beforeCompatibilityLink: input.beforeCompatibilityLink ?? (() => undefined)
      })
    }
    if (sourceState === 'missing' && targetState === 'missing') {
      const startedAt = now().toISOString()
      const journal: RuntimeMigrationJournal = {
        schemaVersion: MIGRATION_SCHEMA_VERSION,
        phase: 'prepared',
        sourcePath,
        targetPath,
        cutoverConflictBackupPaths: [],
        settingsSourcePath: settingsSelection.sourcePath,
        settingsWritePath: settingsSelection.writePath,
        settingsBackupPaths: [],
        settingsBackedUp: false,
        extensionRegistryBackupPaths: [],
        sourceWasMissing: true,
        sourceThreadIds: [],
        sourceInventory: {
          files: 0,
          directories: 0,
          symlinks: 0,
          bytes: 0
        },
        salvaged: 0,
        conflicts: [],
        startedAt,
        updatedAt: startedAt
      }
      writeDurableJson(journalPath, journal)
      return continueMigration(journal, {
        userDataPath: input.userDataPath,
        homeDir: input.homeDir,
        platform,
        log,
        now,
        sleep,
        assertLegacyRuntimeInactive,
        afterPhase: input.afterPhase ?? (() => undefined),
        beforeCompatibilityLink: input.beforeCompatibilityLink ?? (() => undefined)
      })
    }
    return {
      status: 'blocked',
      authority,
      sourcePath,
      targetPath,
      journalPath,
      message: 'settings select the legacy Runtime directory but no migratable directory exists'
    }
  }
  if (targetState === 'symlink' || targetState === 'other') {
    return {
      status: 'blocked',
      authority,
      sourcePath,
      targetPath,
      journalPath,
      message: 'canonical Runtime destination is not a regular directory or missing path'
    }
  }

  try {
    assertLegacyRuntimeInactive(sourcePath)
    if (targetState === 'dir') assertLegacyRuntimeInactive(targetPath)
    assertSameVolume(
      sourcePath,
      targetPath,
      platform,
      input.statDevice ?? ((path) => statSync(path).dev)
    )
    const startedAt = now().toISOString()
    const destinationBackupPath = targetState === 'dir'
      ? uniqueSiblingBackup(targetPath, 'pre-deepseekgui-migration', now)
      : undefined
    const journal: RuntimeMigrationJournal = {
      schemaVersion: MIGRATION_SCHEMA_VERSION,
      phase: 'prepared',
      sourcePath,
      targetPath,
      ...(destinationBackupPath ? { destinationBackupPath } : {}),
      cutoverConflictBackupPaths: [],
      settingsSourcePath: settingsSelection.sourcePath,
      settingsWritePath: settingsSelection.writePath,
      settingsBackupPaths: [],
      settingsBackedUp: false,
      extensionRegistryBackupPaths: [],
      sourceThreadIds: threadIds(sourcePath),
      sourceInventory: runtimeStoreInventory(sourcePath),
      ...(targetState === 'dir'
        ? { destinationInventory: runtimeStoreInventory(targetPath) }
        : {}),
      salvaged: 0,
      conflicts: [],
      startedAt,
      updatedAt: startedAt
    }
    writeDurableJson(journalPath, journal)
    return continueMigration(journal, {
      userDataPath: input.userDataPath,
      homeDir: input.homeDir,
      platform,
      log,
      now,
      sleep,
      assertLegacyRuntimeInactive,
      afterPhase: input.afterPhase ?? (() => undefined),
      beforeCompatibilityLink: input.beforeCompatibilityLink ?? (() => undefined)
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log('legacy-migration: failed before canonical Runtime migration mutation', {
      sourcePath,
      targetPath,
      message
    })
    return {
      status: 'blocked',
      authority,
      sourcePath,
      targetPath,
      journalPath,
      message
    }
  }
}
