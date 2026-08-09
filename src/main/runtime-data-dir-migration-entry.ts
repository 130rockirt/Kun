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
  type RuntimeDataDirMigrationOptions,
  type RuntimeDataDirMigrationResult
} from './runtime-data-dir-migration-types'
import {
  pathState,
  readJournal
} from './runtime-data-dir-migration-journal-v2'
import {
  readPreservationJournal,
  validatePreservationJournalForRecovery
} from './runtime-data-dir-migration-journal-preservation'
import {
  readSettingsSelection
} from './runtime-data-dir-migration-inventory'
import {
  runPreservationMigrationIfNeeded
} from './runtime-data-dir-migration-preservation'
import {
  finishRuntimeDataRecoveryHandoffIfPresent,
  inspectRuntimeDataRecoveryHandoff,
  runCanonicalKunRuntimeDataMigrationUnsafe
} from './runtime-data-dir-migration-handoff'



/**
 * Returns whether startup must drain Manager/Runtime writers and hold the
 * canonical migration fence before calling the synchronous migration. Invalid
 * or unsafe evidence returns false because the migration will fail closed
 * without mutating it and the dedicated recovery flow owns the next action.
 */
export function canonicalKunRuntimeMigrationRequiresExclusiveAccess(
  input: Pick<RuntimeDataDirMigrationOptions, 'userDataPath' | 'homeDir' | 'platform'>
): boolean {
  const platform = input.platform ?? process.platform
  const sourcePath = canonicalLegacyKunDataDir(input.homeDir, platform)
  const targetPath = canonicalCurrentKunDataDir(input.homeDir, platform)
  const sourceState = pathState(sourcePath)
  const targetState = pathState(targetPath)
  const recoveryHandoff = inspectRuntimeDataRecoveryHandoff(input)
  if (recoveryHandoff.present) {
    const selection = readSettingsSelection(
      input.userDataPath,
      input.homeDir,
      platform,
      sourceState
    )
    if (selection.authority === 'custom' || selection.authority === 'unknown') return false
    if (recoveryHandoff.accepted.status === 'valid') {
      return selection.authority === 'legacy' && Boolean(selection.writePath)
    }
    // A valid completion still needs the one-time full verification and
    // immutable acceptance seal. Invalid evidence fails closed without a
    // mutation and is handed to the dedicated recovery maintenance mode.
    return recoveryHandoff.completion.status === 'valid'
  }
  const journalPath = join(input.userDataPath, PRESERVATION_JOURNAL_FILE_NAME)
  const journalState = pathState(journalPath)
  const journal = readPreservationJournal(journalPath)

  if (journalState === 'inaccessible' || (journalState === 'other' && !journal)) {
    return false
  }
  if (journal) {
    if (validatePreservationJournalForRecovery(journal, {
      userDataPath: input.userDataPath,
      homeDir: input.homeDir,
      platform
    })) return false
    const selection = readSettingsSelection(
      input.userDataPath,
      input.homeDir,
      platform,
      sourceState
    )
    // A valid interrupted journal can outlive a user decision to move Runtime
    // authority to a custom store. The resume path will fail closed on that
    // settings change and must not stop the unrelated custom Manager first.
    if (
      journal.phase !== 'completed' &&
      (selection.authority === 'custom' || selection.authority === 'unknown')
    ) return false
    if (journal.phase !== 'completed') return true
    if (targetState !== 'dir') return false
    if (selection.authority === 'legacy') return true
    if (journal.provenance !== 'reconstructed-from-current') return false
    const v2 = readJournal(join(input.userDataPath, JOURNAL_FILE_NAME))
    return Boolean(
      v2?.phase === 'completed' &&
      (
        v2.extensionRegistryRebasedRecords === undefined ||
        v2.extensionRegistryRebasedAt === undefined
      )
    )
  }

  const v2Path = join(input.userDataPath, JOURNAL_FILE_NAME)
  if (pathState(v2Path) !== 'missing' && !readJournal(v2Path)) return false
  const selection = readSettingsSelection(
    input.userDataPath,
    input.homeDir,
    platform,
    sourceState
  )
  if (selection.authority === 'custom' || selection.authority === 'unknown') return false
  // Canonical first-run initialization, recovery, reconstruction and cutover
  // all create or mutate Runtime data and therefore require the writer fence.
  return true
}

export function runCanonicalKunRuntimeDataMigration(
  input: RuntimeDataDirMigrationOptions
): RuntimeDataDirMigrationResult {
  try {
    if (!input.skipHistoryPreservationForTests) {
      const recoveryHandoff = finishRuntimeDataRecoveryHandoffIfPresent(input)
      if (recoveryHandoff) return recoveryHandoff
      const preservation = runPreservationMigrationIfNeeded(input)
      if (preservation) return preservation
      const platform = input.platform ?? process.platform
      const sourcePath = canonicalLegacyKunDataDir(input.homeDir, platform)
      const targetPath = canonicalCurrentKunDataDir(input.homeDir, platform)
      const selection = readSettingsSelection(
        input.userDataPath,
        input.homeDir,
        platform,
        pathState(sourcePath)
      )
      return {
        status: selection.authority === 'unknown' ? 'blocked' : 'not-needed',
        authority: selection.authority,
        sourcePath,
        targetPath,
        journalPath: join(input.userDataPath, PRESERVATION_JOURNAL_FILE_NAME),
        ...(selection.authority === 'unknown'
          ? { message: 'could not determine Runtime data authority safely' }
          : {})
      }
    }
    return runCanonicalKunRuntimeDataMigrationUnsafe(input)
  } catch (error) {
    const platform = input.platform ?? process.platform
    const sourcePath = canonicalLegacyKunDataDir(input.homeDir, platform)
    const targetPath = canonicalCurrentKunDataDir(input.homeDir, platform)
    return {
      status: 'blocked',
      authority: 'unknown',
      sourcePath,
      targetPath,
      journalPath: join(input.userDataPath, JOURNAL_FILE_NAME),
      message: error instanceof Error ? error.message : String(error)
    }
  }
}
