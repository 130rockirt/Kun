import { isSafeThreadId } from '../../contracts/thread-id.js'
import type {
  SessionLatestUsageSnapshot,
  SessionUsageQueryOptions,
  SessionUsageRecord
} from '../../ports/session-store.js'

type UsageIndexReader = {
  loadUsageRecords(threadId: string, options?: SessionUsageQueryOptions): Promise<SessionUsageRecord[]>
  loadLatestUsageSnapshot(threadId: string): Promise<SessionLatestUsageSnapshot | null>
}

/** Enumerate on-disk thread directories without hydrating any session. */
export async function listThreadDirs(threadsDir: string): Promise<string[]> {
  const { readdir } = await import('node:fs/promises')
  try {
    const entries = await readdir(threadsDir, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isDirectory() && isSafeThreadId(entry.name))
      .map((entry) => entry.name)
      .sort()
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return []
    throw error
  }
}

/**
 * Indexed usage query served from per-thread usage-index.jsonl deltas. A
 * corrupt index rebuilds from events.jsonl. Cross-thread reads isolate real
 * per-thread I/O failures and retain a diagnostic warning for each skipped
 * thread, while an explicit single-thread query remains fail-fast.
 */
export async function loadUsageRecordsFromIndex(
  usageIndex: UsageIndexReader,
  listThreadIds: () => Promise<string[]>,
  options: SessionUsageQueryOptions = {}
): Promise<SessionUsageRecord[]> {
  const threadId = options.threadId?.trim()
  if (threadId) {
    if (!isSafeThreadId(threadId)) return []
    return usageIndex.loadUsageRecords(threadId, options)
  }
  const threadIds = await listThreadIds()
  const records: SessionUsageRecord[] = []
  for (const id of threadIds) {
    try {
      records.push(...await usageIndex.loadUsageRecords(id, options))
    } catch (error) {
      warnUsageThreadFailure('loadUsageRecords', id, error)
    }
  }
  return records
}

export async function loadLatestUsageSnapshotsFromIndex(
  usageIndex: UsageIndexReader,
  listThreadIds: () => Promise<string[]>,
  options: { threadIds?: string[] } = {}
): Promise<SessionLatestUsageSnapshot[]> {
  const threadIds = options.threadIds?.map((id) => id.trim()).filter(Boolean) ?? []
  const targets = threadIds.length > 0 ? threadIds : await listThreadIds()
  const snapshots: SessionLatestUsageSnapshot[] = []
  for (const id of targets) {
    if (!isSafeThreadId(id)) continue
    try {
      const snapshot = await usageIndex.loadLatestUsageSnapshot(id)
      if (snapshot) snapshots.push(snapshot)
    } catch (error) {
      warnUsageThreadFailure('loadLatestUsageSnapshot', id, error)
    }
  }
  return snapshots
}

function warnUsageThreadFailure(operation: string, threadId: string, error: unknown): void {
  const source = error as NodeJS.ErrnoException
  const code = source?.code ? ` (${source.code})` : ''
  const message = error instanceof Error ? error.message : String(error)
  console.warn(`[kun] ${operation} skipped unreadable thread ${threadId}${code}: ${message}`)
}
