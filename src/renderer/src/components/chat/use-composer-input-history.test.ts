import { afterEach, describe, expect, it } from 'vitest'
import {
  COMPOSER_INPUT_HISTORY_MAX,
  COMPOSER_INPUT_HISTORY_STORAGE_KEY,
  isCaretOnFirstLine,
  isCaretOnLastLine,
  loadComposerInputHistory,
  navigateComposerInputHistory,
  parseComposerInputHistory,
  pushComposerInputHistoryEntry,
  saveComposerInputHistory
} from './use-composer-input-history'
import { readBrowserStorageItem } from '../../lib/browser-storage'

class MemoryStorage {
  private values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }
}

const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')

function restoreLocalStorage(): void {
  if (originalLocalStorage) {
    Object.defineProperty(globalThis, 'localStorage', originalLocalStorage)
  } else {
    Reflect.deleteProperty(globalThis, 'localStorage')
  }
}

afterEach(() => {
  restoreLocalStorage()
})

describe('composer input history helpers', () => {
  it('detects caret on the first and last lines', () => {
    const text = 'one\ntwo\nthree'
    expect(isCaretOnFirstLine(text, 0)).toBe(true)
    expect(isCaretOnFirstLine(text, 3)).toBe(true)
    expect(isCaretOnFirstLine(text, 4)).toBe(false)
    expect(isCaretOnLastLine(text, text.length)).toBe(true)
    expect(isCaretOnLastLine(text, 8)).toBe(true)
    expect(isCaretOnLastLine(text, 3)).toBe(false)
  })

  it('treats single-line text as both first and last line', () => {
    expect(isCaretOnFirstLine('hello', 2)).toBe(true)
    expect(isCaretOnLastLine('hello', 2)).toBe(true)
  })

  it('pushes trimmed entries, skips empties and consecutive duplicates, and caps length', () => {
    expect(pushComposerInputHistoryEntry([], '  ')).toEqual([])
    expect(pushComposerInputHistoryEntry(['a'], ' a ')).toEqual(['a'])
    expect(pushComposerInputHistoryEntry(['a'], 'b')).toEqual(['a', 'b'])

    const filled = Array.from({ length: COMPOSER_INPUT_HISTORY_MAX }, (_, i) => `m${i}`)
    const next = pushComposerInputHistoryEntry(filled, 'newest')
    expect(next).toHaveLength(COMPOSER_INPUT_HISTORY_MAX)
    expect(next[0]).toBe('m1')
    expect(next[next.length - 1]).toBe('newest')
  })

  it('parses and persists history through browser storage', () => {
    const storage = new MemoryStorage()
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: storage
    })

    expect(parseComposerInputHistory('not-json')).toEqual([])
    expect(parseComposerInputHistory(JSON.stringify(['a', 1, ' b ']))).toEqual(['a', 'b'])

    saveComposerInputHistory(['one', 'two'])
    expect(readBrowserStorageItem(COMPOSER_INPUT_HISTORY_STORAGE_KEY)).toBe(JSON.stringify(['one', 'two']))
    expect(loadComposerInputHistory()).toEqual(['one', 'two'])
  })

  it('navigates up/down through history and restores the stashed draft', () => {
    const entries = ['older', 'newer']
    const idle = { index: -1, draft: '' }

    const ignored = navigateComposerInputHistory({
      direction: 'up',
      entries,
      browse: idle,
      input: 'line1\nline2',
      selectionStart: 8
    })
    expect(ignored.result).toEqual({ handled: false })

    const firstUp = navigateComposerInputHistory({
      direction: 'up',
      entries,
      browse: idle,
      input: 'draft text',
      selectionStart: 0
    })
    expect(firstUp.result).toEqual({ handled: true, value: 'newer' })
    expect(firstUp.browse).toEqual({ index: 1, draft: 'draft text' })

    const secondUp = navigateComposerInputHistory({
      direction: 'up',
      entries,
      browse: firstUp.browse,
      input: 'newer',
      selectionStart: 0
    })
    expect(secondUp.result).toEqual({ handled: true, value: 'older' })
    expect(secondUp.browse.index).toBe(0)

    const atOldest = navigateComposerInputHistory({
      direction: 'up',
      entries,
      browse: secondUp.browse,
      input: 'older',
      selectionStart: 0
    })
    expect(atOldest.result).toEqual({ handled: true, value: null })

    const downToNewer = navigateComposerInputHistory({
      direction: 'down',
      entries,
      browse: secondUp.browse,
      input: 'older',
      selectionStart: 'older'.length
    })
    expect(downToNewer.result).toEqual({ handled: true, value: 'newer' })

    const downToDraft = navigateComposerInputHistory({
      direction: 'down',
      entries,
      browse: downToNewer.browse,
      input: 'newer',
      selectionStart: 'newer'.length
    })
    expect(downToDraft.result).toEqual({ handled: true, value: 'draft text' })
    expect(downToDraft.browse.index).toBe(-1)
  })
})
