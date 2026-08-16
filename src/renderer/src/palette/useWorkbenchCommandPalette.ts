import { useCallback, useEffect, useMemo, useState } from 'react'
import type { TFunction } from 'i18next'
import type { KeyboardShortcutCommandId } from '@shared/keyboard-shortcuts'
import type { AppRoute, SettingsRouteSection } from '../store/chat-store-types'
import type { SlashCommandId } from '../components/chat/floating-composer-commands'
import { workspaceRootScopeKey } from '../lib/workspace-path'
import {
  DEFAULT_PALETTE_ENTRY_IDS,
  type PaletteEntry,
  type PaletteRecentIdentity,
  type PaletteSourceKind
} from './palette-model'
import { readPaletteRecents, recordPaletteRecent } from './palette-recents'
import { parsePaletteQuery, rankPaletteEntries, type PaletteQueryScope } from './palette-scorer'
import {
  collectPaletteSources,
  composeFallbackEntries,
  excludeDuplicateThreadMatches,
  threadContentMatchEntries,
  type PaletteSourcesInput
} from './palette-sources'
import { useCommandPaletteStore } from './palette-store'
import { getProvider } from '../agent/registry'
import { KunRuntimeProvider, type ThreadContentMatch } from '../agent/kun-runtime'

export type PaletteActivationHandlers = {
  route: (route: AppRoute) => void
  settings: (section: SettingsRouteSection) => void
  thread: (threadId: string) => void
  workspace: (workspaceRoot: string) => void
  'shortcut-command': (commandId: KeyboardShortcutCommandId) => void
  'slash-command': (commandId: SlashCommandId, insertText: string) => void
  'extension-view': (entryId: string, locked: boolean) => boolean
  /** Hand the query to the composer as a prompt draft. */
  compose: (text: string) => void
  /** Switch the composer model. */
  'select-model': (modelId: string, providerId?: string) => void
  /** Apply a reversible action to the active conversation. */
  'thread-action': (action: 'pin' | 'unpin' | 'archive', threadId: string) => void
  /** Surfaced when an activated target no longer resolves. */
  unavailable: () => void
}

export type PaletteResultGroup = {
  key: string
  label: string
  entries: PaletteEntry[]
}

const SOURCE_LABEL_KEYS: Record<PaletteSourceKind, string> = {
  'shortcut-command': 'paletteSourceCommand',
  route: 'paletteSourceRoute',
  settings: 'paletteSourceSettings',
  thread: 'paletteSourceThread',
  workspace: 'paletteSourceWorkspace',
  'slash-command': 'paletteSourceCommand',
  'extension-view': 'paletteSourceExtension',
  compose: 'paletteSourceAction',
  model: 'paletteSourceModel',
  action: 'paletteSourceAction'
}

/**
 * Sections the empty-query state browses through, in the order they appear.
 *
 * Conversations and projects are content rather than capability, so
 * conversations are previewed rather than listed in full — typing reaches the
 * rest, including message content. Everything else is listed exhaustively so
 * the palette doubles as the app's capability map.
 */
const PALETTE_BROWSE_SECTIONS: ReadonlyArray<{
  key: string
  labelKey: string
  sources: readonly PaletteSourceKind[]
  limit?: number
}> = [
  { key: 'actions', labelKey: 'paletteActionsSection', sources: ['action'] },
  { key: 'commands', labelKey: 'paletteSectionCommands', sources: ['shortcut-command', 'slash-command'] },
  { key: 'navigation', labelKey: 'paletteSectionNavigation', sources: ['route'] },
  { key: 'settings', labelKey: 'paletteSectionSettings', sources: ['settings'] },
  { key: 'models', labelKey: 'paletteSectionModels', sources: ['model'] },
  { key: 'conversations', labelKey: 'paletteSectionConversations', sources: ['thread'], limit: 8 },
  { key: 'projects', labelKey: 'paletteSectionProjects', sources: ['workspace'] },
  { key: 'extensions', labelKey: 'paletteSectionExtensions', sources: ['extension-view'] }
]

const SCOPE_LABEL_KEYS: Record<PaletteQueryScope, string | null> = {
  all: null,
  commands: 'paletteScopeCommands',
  conversations: 'paletteScopeConversations',
  settings: 'paletteScopeSettings',
  slash: 'paletteScopeSlash'
}

function paletteWorkspaceScope(workspaceRoot: string): string {
  return workspaceRootScopeKey(workspaceRoot) || '__global__'
}

export type PaletteContentSearch = (
  query: string,
  options: { limit: number }
) => Promise<ThreadContentMatch[]>

export type UseWorkbenchCommandPaletteInput = PaletteSourcesInput & {
  handlers: PaletteActivationHandlers
  /** Injectable deep-search backend; defaults to the Kun runtime route. */
  searchThreadContent?: PaletteContentSearch
}

/**
 * Deep search is only available on the Kun runtime provider. Other providers
 * simply contribute no content matches rather than throwing into the palette.
 */
const defaultContentSearch: PaletteContentSearch = (query, options) => {
  const provider = getProvider()
  if (!(provider instanceof KunRuntimeProvider)) return Promise.resolve([])
  return provider.searchThreadContent(query, options)
}

/**
 * Owns palette open state, source aggregation, query scoping, ranking,
 * recents, and activation. Every action here routes through existing store
 * actions and desktop commands via the handler callbacks.
 */
export function useWorkbenchCommandPalette(input: UseWorkbenchCommandPaletteInput): {
  open: boolean
  query: string
  /** Query with any scope prefix stripped; what result highlighting matches. */
  matchTerm: string
  scope: PaletteQueryScope
  scopeLabel: string | null
  results: PaletteEntry[]
  groups: PaletteResultGroup[] | null
  /** True while a conversation deep search is debouncing or in flight. */
  contentSearchPending: boolean
  setQuery: (query: string) => void
  sourceLabelFor: (entry: PaletteEntry) => string
  activate: (entry: PaletteEntry) => void
  close: () => void
} {
  const {
    handlers,
    t,
    tSettings,
    route,
    workspaceRoot,
    threads,
    codeWorkspaceRoots,
    runtimeReady,
    busy,
    activeThreadId,
    activeThreadArchived,
    canOpenGoalPanel,
    canCreateNewThread,
    hasPlanCommand,
    hasBtwCommand,
    hideBtwCommand,
    hasReviewCommand,
    skillCommands,
    disabledSkillIds,
    extensionRightRailItems,
    shortcutBindings,
    hasComposerDraft,
    composerModel,
    composerModelGroups,
    activeThreadPinned
  } = input

  const open = useCommandPaletteStore((state) => state.open)
  const closePalette = useCommandPaletteStore((state) => state.closePalette)
  const [query, setQuery] = useState('')
  const [recents, setRecents] = useState<PaletteRecentIdentity[]>([])
  const [contentMatches, setContentMatches] = useState<PaletteEntry[]>([])
  const [contentSearchPending, setContentSearchPending] = useState(false)
  const contentSearch = input.searchThreadContent ?? defaultContentSearch

  const scope = useMemo(() => paletteWorkspaceScope(workspaceRoot), [workspaceRoot])

  useEffect(() => {
    if (!open) return
    setQuery('')
    setRecents(readPaletteRecents(scope))
    setContentMatches([])
    setContentSearchPending(false)
  }, [open, scope])

  const entries = useMemo(
    () => collectPaletteSources({
      t,
      tSettings,
      route,
      workspaceRoot,
      threads,
      codeWorkspaceRoots,
      runtimeReady,
      busy,
      activeThreadId,
      activeThreadArchived,
      canOpenGoalPanel,
      canCreateNewThread,
      hasPlanCommand,
      hasBtwCommand,
      hideBtwCommand,
      hasReviewCommand,
      skillCommands,
      disabledSkillIds,
      extensionRightRailItems,
      shortcutBindings,
      hasComposerDraft,
      composerModel,
      composerModelGroups,
      activeThreadPinned
    }),
    [
      t,
      tSettings,
      route,
      workspaceRoot,
      threads,
      codeWorkspaceRoots,
      runtimeReady,
      busy,
      activeThreadId,
      activeThreadArchived,
      canOpenGoalPanel,
      canCreateNewThread,
      hasPlanCommand,
      hasBtwCommand,
      hideBtwCommand,
      hasReviewCommand,
      skillCommands,
      disabledSkillIds,
      extensionRightRailItems,
      shortcutBindings,
      hasComposerDraft,
      composerModel,
      composerModelGroups,
      activeThreadPinned
    ]
  )

  const entriesById = useMemo(() => {
    const map = new Map<string, PaletteEntry>()
    for (const entry of entries) map.set(entry.id, entry)
    return map
  }, [entries])

  const parsed = useMemo(() => parsePaletteQuery(query), [query])

  const scopeLabel = useMemo(() => {
    const labelKey = SCOPE_LABEL_KEYS[parsed.scope]
    return labelKey ? t(labelKey) : null
  }, [parsed.scope, t])

  /**
   * With no query and no scope the palette shows curated groups (recents,
   * then defaults) instead of the catalog. The overlay renders `results`
   * followed by `groups`, so this state must yield no flat results or every
   * curated entry would also appear in a full catalog listing above it.
   */
  const showsCuratedGroups = parsed.query === '' && parsed.scope === 'all'

  const ranked = useMemo(
    () => rankPaletteEntries(entries, parsed, recents),
    [entries, parsed, recents]
  )
  const results = useMemo(
    () => (showsCuratedGroups ? [] : ranked),
    [ranked, showsCuratedGroups]
  )

  const contentSearchScopeAllowed = parsed.scope === 'all' || parsed.scope === 'conversations'

  useEffect(() => {
    const normalized = parsed.query.trim()
    if (!open || !contentSearchScopeAllowed || normalized.length < 2) {
      setContentMatches([])
      setContentSearchPending(false)
      return
    }
    let cancelled = false
    // Pending starts at the keystroke, not at the request, so the debounce
    // window is covered too. Otherwise the palette renders its "no results"
    // state for the whole debounce plus round-trip and a search that is
    // simply still running looks like a search that found nothing.
    setContentSearchPending(true)
    const timer = window.setTimeout(() => {
      // Intentionally unscoped: content search spans every project, because
      // recalling a discussion rarely comes with recalling which project it
      // was in. Each row shows the project it came from.
      void contentSearch(normalized, { limit: 8 })
        .then((matches) => {
          if (cancelled) return
          setContentMatches(threadContentMatchEntries(matches))
        })
        .catch(() => {
          if (!cancelled) setContentMatches([])
        })
        .finally(() => {
          if (!cancelled) setContentSearchPending(false)
        })
    }, 250)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [contentSearch, contentSearchScopeAllowed, open, parsed.query])

  const visibleContentMatches = useMemo(
    () => excludeDuplicateThreadMatches(contentMatches, results),
    [contentMatches, results]
  )

  const groups = useMemo<PaletteResultGroup[] | null>(() => {
    if (showsCuratedGroups) {
      const recentEntries = recents
        .map((recent) => entriesById.get(recent.id))
        .filter((entry): entry is PaletteEntry => Boolean(entry))
      const seen = new Set(recentEntries.map((entry) => entry.id))
      const defaultEntries = DEFAULT_PALETTE_ENTRY_IDS
        .map((id) => entriesById.get(id))
        .filter((entry): entry is PaletteEntry => Boolean(entry))
        .filter((entry) => !seen.has(entry.id))
      const nextGroups: PaletteResultGroup[] = []
      if (recentEntries.length > 0) {
        nextGroups.push({ key: 'recent', label: t('paletteSectionRecent'), entries: recentEntries })
      }
      if (defaultEntries.length > 0) {
        nextGroups.push({ key: 'default', label: t('paletteSectionDefault'), entries: defaultEntries })
      }
      for (const entry of defaultEntries) seen.add(entry.id)

      // Everything else follows, grouped by section, so opening the palette
      // shows the whole capability surface rather than only a curated few.
      // `seen` is what keeps the original duplication bug from returning:
      // an entry promoted into Recent or Quick actions must not repeat here.
      for (const section of PALETTE_BROWSE_SECTIONS) {
        const sectionEntries = entries.filter((entry) =>
          section.sources.includes(entry.source) && !seen.has(entry.id))
        if (sectionEntries.length === 0) continue
        const bounded = section.limit ? sectionEntries.slice(0, section.limit) : sectionEntries
        for (const entry of bounded) seen.add(entry.id)
        nextGroups.push({
          key: 'browse:' + section.key,
          label: t(section.labelKey),
          entries: bounded
        })
      }
      return nextGroups
    }
    const nextGroups: PaletteResultGroup[] = []
    if (visibleContentMatches.length > 0) {
      nextGroups.push({
        key: 'content',
        label: t('paletteContentSearchSection'),
        entries: visibleContentMatches
      })
    }
    // Offered only once everything else has come up empty, so it never
    // competes with a real destination the user was aiming for.
    if (results.length === 0 && visibleContentMatches.length === 0 && !contentSearchPending) {
      const fallback = composeFallbackEntries({
        t,
        rawQuery: query,
        canCreateNewThread,
        hasComposerDraft
      })
      if (fallback.length > 0) {
        nextGroups.push({ key: 'compose', label: t('paletteActionsSection'), entries: fallback })
      }
    }
    return nextGroups.length > 0 ? nextGroups : null
  }, [
    canCreateNewThread,
    contentSearchPending,
    entries,
    entriesById,
    hasComposerDraft,
    query,
    recents,
    results,
    showsCuratedGroups,
    t,
    visibleContentMatches
  ])

  const sourceLabelFor = useCallback((entry: PaletteEntry): string => {
    if (entry.source === 'slash-command' && entry.activation.kind === 'slash-command') {
      if (entry.activation.commandId.startsWith('skill:')) return t('paletteSourceSkill')
      return t('paletteSourceCommand')
    }
    return t(SOURCE_LABEL_KEYS[entry.source])
  }, [t])

  const activate = useCallback((entry: PaletteEntry): void => {
    if (entry.disabled) return
    const activation = entry.activation
    let resolved = true
    switch (activation.kind) {
      case 'route':
        handlers.route(activation.route)
        break
      case 'settings':
        handlers.settings(activation.section)
        break
      case 'thread': {
        resolved = threads.some((thread) => thread.id === activation.threadId) ||
          contentMatches.some((match) =>
            match.activation.kind === 'thread' && match.activation.threadId === activation.threadId
          )
        if (resolved) handlers.thread(activation.threadId)
        break
      }
      case 'workspace': {
        resolved = codeWorkspaceRoots.includes(activation.workspaceRoot)
        if (resolved) handlers.workspace(activation.workspaceRoot)
        break
      }
      case 'shortcut-command':
        handlers['shortcut-command'](activation.commandId)
        break
      case 'slash-command': {
        resolved = entriesById.has('slash:' + activation.commandId)
        if (resolved) handlers['slash-command'](activation.commandId, activation.insertText)
        break
      }
      case 'extension-view':
        resolved = handlers['extension-view'](activation.entryId, activation.locked)
        break
      case 'compose':
        handlers.compose(activation.text)
        break
      case 'select-model':
        handlers['select-model'](activation.modelId, activation.providerId)
        break
      case 'thread-action': {
        // The active thread can change between rendering the row and
        // activating it, so re-check before acting on a stale id.
        resolved = threads.some((thread) => thread.id === activation.threadId)
        if (resolved) handlers['thread-action'](activation.action, activation.threadId)
        break
      }
    }
    closePalette()
    if (!resolved) {
      handlers.unavailable()
      return
    }
    setRecents(recordPaletteRecent(scope, { source: entry.source, id: entry.id }))
  }, [
    closePalette,
    codeWorkspaceRoots,
    contentMatches,
    entriesById,
    handlers,
    scope,
    threads
  ])

  return {
    open,
    query,
    matchTerm: parsed.query,
    scope: parsed.scope,
    scopeLabel,
    results,
    groups,
    contentSearchPending,
    setQuery,
    sourceLabelFor,
    activate,
    close: closePalette
  }
}
