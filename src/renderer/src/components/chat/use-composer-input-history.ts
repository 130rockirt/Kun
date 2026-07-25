import { useCallback, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { readBrowserStorageItem, writeBrowserStorageItem } from '../../lib/browser-storage'

export const COMPOSER_INPUT_HISTORY_STORAGE_KEY = 'kun.composerInputHistory.v1'
export const COMPOSER_INPUT_HISTORY_MAX = 50

export function isCaretOnFirstLine(text: string, selectionStart: number): boolean {
  const caret = clampCaret(text, selectionStart)
  return !text.slice(0, caret).includes('\n')
}

export function isCaretOnLastLine(text: string, selectionStart: number): boolean {
  const caret = clampCaret(text, selectionStart)
  return !text.slice(caret).includes('\n')
}

export function pushComposerInputHistoryEntry(
  entries: readonly string[],
  text: string,
  max = COMPOSER_INPUT_HISTORY_MAX
): string[] {
  const trimmed = text.trim()
  if (!trimmed) return entries as string[]
  if (entries.length > 0 && entries[entries.length - 1] === trimmed) {
    return entries as string[]
  }
  const next = [...entries, trimmed]
  if (next.length <= max) return next
  return next.slice(next.length - max)
}

export function parseComposerInputHistory(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(-COMPOSER_INPUT_HISTORY_MAX)
  } catch {
    return []
  }
}

export function loadComposerInputHistory(): string[] {
  return parseComposerInputHistory(readBrowserStorageItem(COMPOSER_INPUT_HISTORY_STORAGE_KEY))
}

export function saveComposerInputHistory(entries: readonly string[]): void {
  writeBrowserStorageItem(COMPOSER_INPUT_HISTORY_STORAGE_KEY, JSON.stringify(entries))
}

type HistoryBrowseState = {
  index: number
  draft: string
}

const IDLE_BROWSE: HistoryBrowseState = { index: -1, draft: '' }

export type ComposerInputHistoryNavigateResult =
  | { handled: false }
  | { handled: true, value: string | null }

/** Pure ↑/↓ navigation against an in-memory history list (for tests and the hook). */
export function navigateComposerInputHistory(options: {
  direction: 'up' | 'down'
  entries: readonly string[]
  browse: HistoryBrowseState
  input: string
  selectionStart: number
}): { result: ComposerInputHistoryNavigateResult, browse: HistoryBrowseState } {
  const { direction, entries, browse, input, selectionStart } = options

  if (direction === 'up') {
    if (!isCaretOnFirstLine(input, selectionStart) || entries.length === 0) {
      return { result: { handled: false }, browse }
    }
    if (browse.index < 0) {
      const index = entries.length - 1
      return {
        result: { handled: true, value: entries[index] ?? '' },
        browse: { index, draft: input }
      }
    }
    if (browse.index > 0) {
      const index = browse.index - 1
      return {
        result: { handled: true, value: entries[index] ?? '' },
        browse: { ...browse, index }
      }
    }
    return { result: { handled: true, value: null }, browse }
  }

  if (browse.index < 0 || !isCaretOnLastLine(input, selectionStart)) {
    return { result: { handled: false }, browse }
  }
  if (browse.index < entries.length - 1) {
    const index = browse.index + 1
    return {
      result: { handled: true, value: entries[index] ?? '' },
      browse: { ...browse, index }
    }
  }
  return {
    result: { handled: true, value: browse.draft },
    browse: IDLE_BROWSE
  }
}

function clampCaret(text: string, selectionStart: number): number {
  if (!Number.isFinite(selectionStart)) return text.length
  return Math.max(0, Math.min(Math.floor(selectionStart), text.length))
}

function placeCaretAtEnd(textarea: HTMLTextAreaElement | null | undefined, value: string): void {
  if (!textarea) return
  const end = value.length
  window.requestAnimationFrame(() => {
    textarea.focus()
    textarea.setSelectionRange(end, end)
  })
}

/** Shared persisted history + per-composer ↑/↓ navigation (shell-style). */
export function useComposerInputHistory(): {
  push: (text: string) => void
  handleKeyDown: (
    event: ReactKeyboardEvent<HTMLTextAreaElement>,
    options: {
      input: string
      setInput: (value: string) => void
      composing: boolean
    }
  ) => boolean
} {
  const entriesRef = useRef<string[] | null>(null)
  const browseRef = useRef<HistoryBrowseState>(IDLE_BROWSE)

  const ensureEntries = useCallback((): string[] => {
    if (entriesRef.current == null) {
      entriesRef.current = loadComposerInputHistory()
    }
    return entriesRef.current
  }, [])

  const push = useCallback((text: string) => {
    const entries = ensureEntries()
    const next = pushComposerInputHistoryEntry(entries, text)
    entriesRef.current = next
    browseRef.current = IDLE_BROWSE
    if (next !== entries) {
      saveComposerInputHistory(next)
    }
  }, [ensureEntries])

  const handleKeyDown = useCallback((
    event: ReactKeyboardEvent<HTMLTextAreaElement>,
    options: {
      input: string
      setInput: (value: string) => void
      composing: boolean
    }
  ): boolean => {
    if (options.composing) return false
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return false
    if (event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return false

    const selectionStart = event.currentTarget.selectionStart ?? options.input.length
    const navigated = navigateComposerInputHistory({
      direction: event.key === 'ArrowUp' ? 'up' : 'down',
      entries: ensureEntries(),
      browse: browseRef.current,
      input: options.input,
      selectionStart
    })
    if (!navigated.result.handled) return false

    browseRef.current = navigated.browse
    event.preventDefault()
    if (navigated.result.value != null) {
      options.setInput(navigated.result.value)
      placeCaretAtEnd(event.currentTarget, navigated.result.value)
    }
    return true
  }, [ensureEntries])

  return { push, handleKeyDown }
}
