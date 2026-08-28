import { open, type FileHandle } from 'node:fs/promises'
import type { TurnItem } from '../../contracts/items.js'
import type { ItemHistoryPage, ItemHistoryPageOptions } from '../../ports/session-store.js'
import { buildPublicItemHistoryPage } from '../../services/item-history-page.js'
import { readItemPageFromJsonl } from './file-session-jsonl.js'
import type { JsonlFileAccessCoordinator } from './jsonl-file-access.js'

type PageSource =
  | { kind: 'cached'; items: TurnItem[] }
  | { kind: 'file'; handle: FileHandle; size: number }

/** Capture and scan one bounded item page while fencing atomic replacement. */
export async function loadItemPageFromStore(input: {
  path: string
  options: ItemHistoryPageOptions
  fileAccess: JsonlFileAccessCoordinator
  cachedItems: () => TurnItem[] | undefined
  touchCache: (items: TurnItem[]) => void
  withThreadWrite: <T>(operation: () => Promise<T>) => Promise<T>
  scheduleCompaction: () => void
  compactionMinBytes: number
}): Promise<ItemHistoryPage> {
  const release = await input.fileAccess.acquireRead(input.path)
  try {
    const source = await input.withThreadWrite<PageSource | null>(async () => {
      const cached = input.cachedItems()
      if (cached) {
        input.touchCache(cached)
        return { kind: 'cached', items: [...cached] }
      }
      let handle: FileHandle | undefined
      try {
        handle = await open(input.path, 'r')
        return { kind: 'file', handle, size: (await handle.stat()).size }
      } catch (error) {
        await handle?.close().catch(() => undefined)
        if ((error as { code?: string }).code === 'ENOENT') return null
        throw error
      }
    })
    if (!source) return { items: [], hasMore: false, itemBytes: 0 }
    if (source.kind === 'cached') return buildPublicItemHistoryPage(source.items, input.options)
    if (source.size <= 0) {
      await source.handle.close()
      return { items: [], hasMore: false, itemBytes: 0 }
    }
    const page = await readItemPageFromJsonl(source.handle, source.size, input.options)
    if (source.size >= input.compactionMinBytes) input.scheduleCompaction()
    return page
  } finally {
    release()
  }
}
