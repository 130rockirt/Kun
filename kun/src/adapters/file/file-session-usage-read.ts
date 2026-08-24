import { isSafeThreadId } from '../../contracts/thread-id.js'
import type {
  SessionLatestUsageSnapshot,
  SessionUsageQueryOptions,
  SessionUsageRecord
} from '../../ports/session-store.js'
import type { FileSessionUsageIndex } from './file-session-usage-index.js'

/** Enumerate on-disk thread directories without hydrating any session. */
export async function listThreadDirs(threadsDir: string): Promise<string[]> {
  const { readdir } = await import('node:fs/promises')
  const entries = await readdir(threadsDir, { withFileTypes: true }).catch(() => [])
  return entries
    .filter((entry) => entry.isDirectory() && isSafeThreadId(entry.name))
    .map((entry) => entry.name)
    .sort()
}

/**
 * Indexed usage query served from per-thread usage-index.jsonl deltas. The
 * index self-heals from the events.jsonl tail when it lags, so ranged reads
 * never replay the full event history. Cross-thread reads enumerate thread
 * directories without hydrating sessions; one corrupt entry never fails the
 * whole aggregation because the index rebuilds from the durable event log.
 */
export async function loadUsageRecordsFromIndex(
  usageIndex: FileSessionUsageIndex,
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
    records.push(...await usageIndex.loadUsageRecords(id, options))
  }
  return records
}

export async function loadLatestUsageSnapshotsFromIndex(
  usageIndex: FileSessionUsageIndex,
  listThreadIds: () => Promise<string[]>,
  options: { threadIds?: string[] } = {}
): Promise<SessionLatestUsageSnapshot[]> {
  const threadIds = options.threadIds?.map((id) => id.trim()).filter(Boolean) ?? []
  const targets = threadIds.length > 0 ? threadIds : await listThreadIds()
  const snapshots: SessionLatestUsageSnapshot[] = []
  for (const id of targets) {
    if (!isSafeThreadId(id)) continue
    const snapshot = await usageIndex.loadLatestUsageSnapshot(id)
    if (snapshot) snapshots.push(snapshot)
  }
  return snapshots
}
