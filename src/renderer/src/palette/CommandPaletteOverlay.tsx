import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement
} from 'react'
import { useTranslation } from 'react-i18next'
import { Command, Loader2, LockKeyhole, Puzzle, Search } from 'lucide-react'
import { extensionHostIconUrl } from '../extensions/contribution-registry'
import { highlightSegments } from './palette-highlight'
import type { PaletteEntry, PaletteIcon } from './palette-model'
import type { PaletteQueryScope } from './palette-scorer'
import type { PaletteResultGroup } from './useWorkbenchCommandPalette'

const PALETTE_LISTBOX_ID = 'ds-command-palette-listbox'
const PAGE_STEP = 8

type CommandPaletteOverlayProps = {
  query: string
  /** Normalized term to highlight: the query with any scope prefix stripped. */
  matchTerm: string
  scope: PaletteQueryScope
  scopeLabel: string | null
  groups: PaletteResultGroup[] | null
  results: PaletteEntry[]
  /** True while a conversation deep search is debouncing or in flight. */
  contentSearchPending?: boolean
  sourceLabel: (entry: PaletteEntry) => string
  onQueryChange: (query: string) => void
  onActivate: (entry: PaletteEntry) => void
  onClose: () => void
}

function PaletteRowIcon({ icon }: { icon?: PaletteIcon }): ReactElement {
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [icon])

  if (icon?.kind === 'extension' && icon.iconPath && !failed) {
    return (
      <img
        src={extensionHostIconUrl(icon.extensionId, icon.iconPath)}
        alt=""
        aria-hidden="true"
        className="h-4 w-4 shrink-0 rounded-[4px] object-contain"
        onError={() => setFailed(true)}
      />
    )
  }
  if (icon?.kind === 'lucide') {
    const Icon = icon.icon
    return <Icon className="h-4 w-4 shrink-0" strokeWidth={1.75} />
  }
  return <Command className="h-4 w-4 shrink-0" strokeWidth={1.75} />
}

/** Renders `text` with every occurrence of `term` visually emphasized. */
function Highlighted({ text, term }: { text: string; term: string }): ReactElement {
  return (
    <>
      {highlightSegments(text, term).map((segment, index) =>
        segment.match
          ? (
            <mark
              key={index}
              className="rounded-[3px] bg-accent/25 px-0 text-inherit"
            >
              {segment.text}
            </mark>
            )
          : <span key={index}>{segment.text}</span>
      )}
    </>
  )
}

export function CommandPaletteOverlay({
  query,
  matchTerm,
  scope,
  scopeLabel,
  groups,
  results,
  contentSearchPending = false,
  sourceLabel,
  onQueryChange,
  onActivate,
  onClose
}: CommandPaletteOverlayProps): ReactElement {
  const { t } = useTranslation('common')
  const inputRef = useRef<HTMLInputElement | null>(null)
  const optionRefs = useRef<Array<HTMLLIElement | null>>([])
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)

  const flatResults = useMemo(() => results, [results])
  const groupEntries = useMemo(
    () => (groups ? groups.flatMap((group) => group.entries) : []),
    [groups]
  )
  const allRows = useMemo(() => [...flatResults, ...groupEntries], [flatResults, groupEntries])
  const activeEntry = allRows.length > 0 ? allRows[activeIndex] : undefined

  useEffect(() => {
    if (typeof document === 'undefined') return
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    inputRef.current?.focus?.()
    return () => {
      previousFocusRef.current?.focus?.()
    }
  }, [])

  useEffect(() => {
    setActiveIndex(0)
  }, [allRows])

  useEffect(() => {
    optionRefs.current[activeIndex]?.scrollIntoView?.({ block: 'nearest' })
  }, [activeIndex])

  const moveActive = (next: number): void => {
    if (allRows.length === 0) return
    setActiveIndex(Math.min(Math.max(next, 0), allRows.length - 1))
  }

  /**
   * Keyboard navigation scrolls the list, which slides rows under a
   * stationary cursor and makes the browser emit pointermove. Taking the
   * selection on those synthetic moves would fight the arrow keys, so only a
   * pointer that actually changed position may claim the active row.
   */
  const pointerPositionRef = useRef<{ x: number; y: number } | null>(null)
  const onRowPointerMove = (index: number, x: number, y: number): void => {
    const previous = pointerPositionRef.current
    if (previous && previous.x === x && previous.y === y) return
    pointerPositionRef.current = { x, y }
    if (previous) setActiveIndex(index)
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.nativeEvent.isComposing) return
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        moveActive(activeIndex + 1)
        return
      case 'ArrowUp':
        event.preventDefault()
        moveActive(activeIndex - 1)
        return
      case 'Home':
        event.preventDefault()
        moveActive(0)
        return
      case 'End':
        event.preventDefault()
        moveActive(allRows.length - 1)
        return
      case 'PageDown':
        event.preventDefault()
        moveActive(activeIndex + PAGE_STEP)
        return
      case 'PageUp':
        event.preventDefault()
        moveActive(activeIndex - PAGE_STEP)
        return
      case 'Enter': {
        event.preventDefault()
        if (activeEntry && !activeEntry.disabled) onActivate(activeEntry)
        return
      }
      case 'Escape':
        event.preventDefault()
        onClose()
        return
      case 'Tab': {
        // Trap focus between the input and the active option.
        event.preventDefault()
        const input = inputRef.current
        if (
          typeof document !== 'undefined' &&
          document.activeElement === input &&
          allRows.length > 0
        ) {
          optionRefs.current[activeIndex]?.focus?.()
        } else {
          input?.focus?.()
        }
        return
      }
    }
  }

  const renderRow = (entry: PaletteEntry, index: number): ReactElement => {
    const locked = entry.activation.kind === 'extension-view' && entry.activation.locked
    return (
      <li
        key={entry.id}
        ref={(node) => {
          optionRefs.current[index] = node
        }}
        id={'ds-command-palette-option-' + index}
        role="option"
        aria-selected={index === activeIndex}
        aria-disabled={entry.disabled === true}
        tabIndex={-1}
        data-palette-entry-id={entry.id}
        onPointerMove={(event) => onRowPointerMove(index, event.clientX, event.clientY)}
        onPointerDown={(event) => {
          event.preventDefault()
          if (!entry.disabled) onActivate(entry)
        }}
        className={
          'mx-1.5 flex cursor-default select-none items-center gap-2.5 rounded-[var(--ds-radius-control)] px-2.5 py-2 text-[13.5px] transition first:mt-1.5 last:mb-1.5 ' +
          (index === activeIndex ? 'bg-ds-hover text-ds-ink' : 'text-ds-muted') +
          (entry.disabled ? ' cursor-not-allowed opacity-45' : '')
        }
      >
        <PaletteRowIcon icon={entry.icon} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-ds-ink">
            <Highlighted text={entry.title} term={matchTerm} />
          </span>
          {entry.subtitle || (entry.disabled && entry.disabledReason) ? (
            <span className="block truncate text-[12px] text-ds-faint">
              {entry.disabled && entry.disabledReason
                ? entry.disabledReason
                : <Highlighted text={entry.subtitle ?? ''} term={matchTerm} />}
            </span>
          ) : null}
        </span>
        {locked ? (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10.5px] font-semibold text-amber-700 dark:text-amber-200">
            <LockKeyhole className="h-3 w-3" strokeWidth={2.2} />
            {entry.badge ?? t('paletteLockedBadge')}
          </span>
        ) : null}
        {entry.badge && !locked ? (
          <span className="shrink-0 rounded-md bg-ds-hover px-1.5 py-0.5 text-[10.5px] font-medium text-ds-faint">
            {entry.badge}
          </span>
        ) : null}
        <span className="w-20 shrink-0 truncate text-right text-[11px] text-ds-faint">
          {sourceLabel(entry)}
        </span>
      </li>
    )
  }

  const emptyLabel = scopeLabel
    ? t('paletteEmptyScoped', { scope: scopeLabel })
    : t('paletteEmpty')

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('paletteDialogLabel')}
      data-palette-scope={scope}
      className="fixed inset-0 z-[200] flex items-start justify-center bg-black/35 px-4 pt-[12vh] backdrop-blur-[2px]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        className="ds-card-strong w-full max-w-xl overflow-hidden rounded-[var(--ds-radius-card)] border border-ds-border-strong shadow-[var(--ds-shadow-overlay)]"
        onKeyDown={onKeyDown}
      >
        <div className="flex items-center gap-2.5 border-b border-ds-border-muted px-3.5 py-3">
          <Search className="h-4 w-4 shrink-0 text-ds-faint" strokeWidth={1.75} />
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={PALETTE_LISTBOX_ID}
            aria-activedescendant={
              activeEntry && allRows.length > 0
                ? 'ds-command-palette-option-' + activeIndex
                : undefined
            }
            aria-autocomplete="list"
            aria-label={t('paletteInputLabel')}
            placeholder={t('palettePlaceholder')}
            value={query}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => onQueryChange(event.target.value)}
            className="min-w-0 flex-1 bg-transparent text-[15px] text-ds-ink placeholder:text-ds-faint focus:outline-none"
          />
          {scopeLabel ? (
            <span className="shrink-0 rounded-md bg-accent/10 px-2 py-0.5 text-[11px] font-semibold text-accent">
              {scopeLabel}
            </span>
          ) : null}
          <span className="shrink-0 rounded-md border border-ds-border-muted px-1.5 py-0.5 text-[10.5px] font-medium text-ds-faint">
            Esc
          </span>
        </div>

        <div
          id={PALETTE_LISTBOX_ID}
          role="listbox"
          aria-label={t('paletteResultsLabel')}
          tabIndex={-1}
          // Sized for browsing: the empty-query view is the whole capability
          // catalog, not a short curated list.
          className="max-h-[60vh] overflow-y-auto py-1.5"
        >
          {allRows.length === 0 && contentSearchPending ? (
            <div
              className="flex items-center gap-2 px-4 py-8 text-center text-[13px] text-ds-faint"
              data-palette-searching="true"
            >
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" strokeWidth={2} />
              <span>{t('paletteSearchingConversations')}</span>
            </div>
          ) : null}
          {allRows.length > 0 ? (
            <>
              {flatResults.length > 0 ? (
                <ul role="none" className="m-0 list-none p-0">
                  {flatResults.map((entry, index) => renderRow(entry, index))}
                </ul>
              ) : null}
              {groups
                ? groups.map((group) => {
                    const offset = flatResults.length +
                      groups
                        .slice(0, groups.indexOf(group))
                        .reduce((sum, current) => sum + current.entries.length, 0)
                    return (
                      <div key={group.key} role="presentation">
                        <div
                          role="presentation"
                          className="px-4 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-ds-faint"
                        >
                          {group.label}
                        </div>
                        <ul role="none" className="m-0 list-none p-0">
                          {group.entries.map((entry, index) => renderRow(entry, offset + index))}
                        </ul>
                      </div>
                    )
                  })
                : null}
            </>
          ) : null}
          {/* Only claim there is nothing once nothing is still arriving. */}
          {allRows.length === 0 && !contentSearchPending ? (
            <div className="px-4 py-8 text-center text-[13px] text-ds-faint">
              {emptyLabel}
            </div>
          ) : null}
        </div>

        <div className="flex items-center justify-between border-t border-ds-border-muted px-3.5 py-2 text-[11px] text-ds-faint">
          {allRows.length > 0 && contentSearchPending ? (
            <span className="flex items-center gap-1.5" data-palette-searching="true">
              <Loader2 className="h-3 w-3 shrink-0 animate-spin" strokeWidth={2} />
              {t('paletteSearchingConversations')}
            </span>
          ) : (
            <span>{t('paletteNavigationHint')}</span>
          )}
          <span>{t('paletteEscapeHint')}</span>
        </div>
      </div>
      <div className="sr-only" aria-live="polite">
        {contentSearchPending
          ? t('paletteSearchingConversations')
          : t('paletteResultCount', { count: allRows.length })}
      </div>
    </div>
  )
}
