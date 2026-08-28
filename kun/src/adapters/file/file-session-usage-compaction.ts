import { stat } from 'node:fs/promises'
import { compactUsageEventsJsonlFile } from './file-session-jsonl.js'

export async function compactUsageEventsIfLarge(options: {
  path: string
  maxBytes: number
  nowIso: string
  retentionDays: number
  maxRecordBytes: number
  readRevision: () => number
  bumpRevision: () => void
  withWrite: (operation: () => Promise<boolean>) => Promise<boolean>
  withRead: <T>(operation: () => Promise<T>) => Promise<T>
  withReplacement: <T>(operation: () => Promise<T>) => Promise<T>
  scheduleRetry: () => void
  invalidateCache: () => void
}): Promise<void> {
  const info = await stat(options.path).catch(() => null)
  if (!info || info.size <= options.maxBytes) return
  const revisionBefore = options.readRevision()
  let conflicted = false
  const compacted = await compactUsageEventsJsonlFile(options.path, {
    nowIso: options.nowIso,
    retentionDays: options.retentionDays,
    maxRecordBytes: options.maxRecordBytes,
    withSourceRead: options.withRead,
    commitReplacement: (replace) => options.withReplacement(() => options.withWrite(async () => {
      const currentInfo = await stat(options.path).catch(() => null)
      if (
        options.readRevision() !== revisionBefore ||
        !currentInfo ||
        currentInfo.size !== info.size ||
        currentInfo.mtimeMs !== info.mtimeMs
      ) {
        conflicted = true
        return false
      }
      await replace()
      options.bumpRevision()
      return true
    }))
  })
  if (conflicted) options.scheduleRetry()
  if (compacted) options.invalidateCache()
}

export async function sessionDirectoryExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}
