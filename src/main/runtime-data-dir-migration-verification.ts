import {
  join
} from 'node:path'
import {
  validateAcceptedRuntimeDataRecovery
} from './runtime-data-dir-recovery'
import {
  JOURNAL_FILE_NAME,
  PRESERVATION_JOURNAL_FILE_NAME
} from './runtime-data-dir-migration-types'
import {
  readJournal
} from './runtime-data-dir-migration-journal-v2'
import {
  readPreservationJournal,
  updateJournal,
  updatePreservationJournal
} from './runtime-data-dir-migration-journal-preservation'
import {
  threadIds
} from './runtime-data-dir-migration-inventory'
import {
  writeReport
} from './runtime-data-dir-migration-salvage'
import {
  writePreservationReport
} from './runtime-data-dir-migration-preservation-validation'



export type RuntimeMigrationRuntimeVerification =
  | {
      status: 'not-needed'
      expectedThreadCount: number
      visibleThreadCount: number
      missingThreadIds: []
    }
  | {
      status: 'incomplete'
      expectedThreadCount: number
      visibleThreadCount: number
      missingThreadIds: string[]
    }
  | {
      status: 'verified'
      expectedThreadCount: number
      visibleThreadCount: number
      missingThreadIds: []
    }

export function markCanonicalKunRuntimeMigrationRuntimeVerified(
  userDataPath: string,
  visibleRuntimeThreadIds: Iterable<string>,
  nowOrOptions: (() => Date) | {
    now?: () => Date
    homeDir?: string
    platform?: NodeJS.Platform
  } = () => new Date()
): RuntimeMigrationRuntimeVerification {
  const verificationOptions = typeof nowOrOptions === 'function'
    ? { now: nowOrOptions }
    : nowOrOptions
  const now = verificationOptions.now ?? (() => new Date())
  const visibleIds = new Set(visibleRuntimeThreadIds)
  if (verificationOptions.homeDir) {
    const acceptedRecovery = validateAcceptedRuntimeDataRecovery({
      userDataPath,
      homeDir: verificationOptions.homeDir,
      platform: verificationOptions.platform
    })
    if (acceptedRecovery.status === 'valid') {
      // Accepted recovery seals bind the exact pre-recovery v2/v3 journal
      // bytes. Those preserved journals are evidence, not live state; adding
      // runtimeVerifiedAt would invalidate the handoff on the next startup.
      return {
        status: 'not-needed',
        expectedThreadCount: 0,
        visibleThreadCount: visibleIds.size,
        missingThreadIds: []
      }
    }
  }
  const verifyJournal = (sourceThreadIds: string[], targetPath: string) => {
    const expectedThreadIds = [...new Set([
      ...sourceThreadIds,
      ...threadIds(targetPath)
    ])]
    const missingThreadIds = expectedThreadIds.filter((threadId) => !visibleIds.has(threadId))
    if (missingThreadIds.length > 0) {
      return {
        status: 'incomplete' as const,
        expectedThreadCount: expectedThreadIds.length,
        visibleThreadCount: visibleIds.size,
        missingThreadIds
      }
    }
    return {
      status: 'complete' as const,
      expectedThreadCount: expectedThreadIds.length,
      visibleThreadCount: visibleIds.size
    }
  }

  const preservationJournalPath = join(userDataPath, PRESERVATION_JOURNAL_FILE_NAME)
  const preservationJournal = readPreservationJournal(preservationJournalPath)
  if (preservationJournal?.phase === 'completed') {
    const verification = verifyJournal(
      preservationJournal.sourceThreadIds,
      preservationJournal.targetPath
    )
    if (verification.status === 'incomplete') {
      if (preservationJournal.runtimeVerifiedAt) {
        const unverified = updatePreservationJournal(
          preservationJournalPath,
          preservationJournal,
          { runtimeVerifiedAt: undefined },
          now
        )
        writePreservationReport(userDataPath, unverified)
      }
      return verification
    }
    if (preservationJournal.runtimeVerifiedAt) {
      return {
        ...verification,
        status: 'not-needed',
        missingThreadIds: []
      }
    }
    const verified = updatePreservationJournal(
      preservationJournalPath,
      preservationJournal,
      {
        runtimeVerifiedAt: now().toISOString(),
        error: undefined
      },
      now
    )
    writePreservationReport(userDataPath, verified)
    return {
      ...verification,
      status: 'verified',
      missingThreadIds: []
    }
  }
  const journalPath = join(userDataPath, JOURNAL_FILE_NAME)
  const journal = readJournal(journalPath)
  if (!journal || journal.phase !== 'completed') {
    return {
      status: 'not-needed',
      expectedThreadCount: 0,
      visibleThreadCount: visibleIds.size,
      missingThreadIds: []
    }
  }
  const verification = verifyJournal(journal.sourceThreadIds, journal.targetPath)
  if (verification.status === 'incomplete') {
    if (journal.runtimeVerifiedAt) {
      const unverified = updateJournal(
        journalPath,
        journal,
        { runtimeVerifiedAt: undefined },
        now
      )
      writeReport(userDataPath, unverified)
    }
    return verification
  }
  if (journal.runtimeVerifiedAt) {
    return {
      ...verification,
      status: 'not-needed',
      missingThreadIds: []
    }
  }
  const verified = updateJournal(
    journalPath,
    journal,
    {
      runtimeVerifiedAt: now().toISOString(),
      error: undefined
    },
    now
  )
  writeReport(userDataPath, verified)
  return {
    ...verification,
    status: 'verified',
    missingThreadIds: []
  }
}
