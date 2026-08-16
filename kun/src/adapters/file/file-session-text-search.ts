import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { TurnItem } from '../../contracts/items.js'
import type { ItemTextSearchOptions } from '../../ports/session-store.js'

export async function searchItemTextFile(input: {
  path: string
  query: string
  maxBytes: number
  cachedItems?: readonly TurnItem[]
  options?: ItemTextSearchOptions
}): Promise<string | null> {
  const needle = input.query.toLowerCase()
  if (!needle) return null
  const deadlineAtMs = input.options?.deadlineAtMs
  const expired = (): boolean => deadlineAtMs !== undefined && Date.now() >= deadlineAtMs
  if (expired()) return null

  if (input.cachedItems) {
    return firstMatchingItemText(input.cachedItems, needle, deadlineAtMs)
  }

  const info = await stat(input.path).catch(() => null)
  if (!info || info.size === 0 || expired()) return null
  const start = Math.max(0, info.size - input.maxBytes)

  return new Promise<string | null>((resolvePromise) => {
    const stream = createReadStream(input.path, { encoding: 'utf-8', start })
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined
    let remainder = ''
    let skipPartialLine = start > 0
    let settled = false

    const finish = (value: string | null): void => {
      if (settled) return
      settled = true
      if (deadlineTimer) clearTimeout(deadlineTimer)
      stream.destroy()
      resolvePromise(value)
    }

    if (deadlineAtMs !== undefined) {
      deadlineTimer = setTimeout(() => finish(null), Math.max(0, deadlineAtMs - Date.now()))
    }

    const acceptLine = (line: string): string | null => {
      if (skipPartialLine) {
        skipPartialLine = false
        return null
      }
      if (!line || !line.toLowerCase().includes(needle)) return null
      let item: TurnItem
      try {
        item = JSON.parse(line) as TurnItem
      } catch {
        return null
      }
      const text = searchableItemText(item)
      return text && text.toLowerCase().includes(needle) ? text : null
    }

    stream.on('data', (chunk: string | Buffer) => {
      remainder += typeof chunk === 'string' ? chunk : chunk.toString('utf-8')
      let newline = remainder.indexOf('\n')
      while (newline >= 0) {
        const match = acceptLine(remainder.slice(0, newline).trim())
        remainder = remainder.slice(newline + 1)
        if (match !== null) {
          finish(match)
          return
        }
        newline = remainder.indexOf('\n')
      }
    })
    stream.on('error', () => finish(null))
    stream.on('close', () => finish(acceptLine(remainder.trim())))
  })
}

function searchableItemText(item: TurnItem): string | null {
  switch (item.kind) {
    case 'user_message':
    case 'assistant_text':
      return item.text
    default:
      return null
  }
}

function firstMatchingItemText(
  items: readonly TurnItem[],
  lowerCaseNeedle: string,
  deadlineAtMs?: number
): string | null {
  for (const item of items) {
    if (deadlineAtMs !== undefined && Date.now() >= deadlineAtMs) return null
    const text = searchableItemText(item)
    if (text && text.toLowerCase().includes(lowerCaseNeedle)) return text
  }
  return null
}
