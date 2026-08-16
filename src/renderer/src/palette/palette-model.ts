import type { LucideIcon } from 'lucide-react'
import type { KeyboardShortcutCommandId } from '@shared/keyboard-shortcuts'
import type { SlashCommandId } from '../components/chat/floating-composer-commands'
import type { AppRoute, SettingsRouteSection } from '../store/chat-store-types'

/**
 * Pure command palette entry model. Entries are produced by source
 * aggregators from existing renderer registries and consumed by the
 * overlay; nothing here reads stores, timers, or randomness.
 */
export type PaletteSourceKind =
  | 'shortcut-command'
  | 'route'
  | 'settings'
  | 'thread'
  | 'workspace'
  | 'slash-command'
  | 'extension-view'
  | 'compose'
  | 'model'
  | 'action'

export const PALETTE_SOURCE_KINDS = [
  'shortcut-command',
  'route',
  'settings',
  'thread',
  'workspace',
  'slash-command',
  'extension-view',
  'compose',
  'model',
  'action'
] as const satisfies readonly PaletteSourceKind[]

export type PaletteActivation =
  /** Hand the raw query text to the composer as a prompt draft. */
  | { kind: 'compose'; text: string }
  /** Switch the composer's model, optionally pinning its provider. */
  | { kind: 'select-model'; modelId: string; providerId?: string }
  /** Reversible action on the active conversation. */
  | { kind: 'thread-action'; action: 'pin' | 'unpin' | 'archive'; threadId: string }
  | { kind: 'route'; route: AppRoute }
  | { kind: 'settings'; section: SettingsRouteSection }
  | { kind: 'thread'; threadId: string }
  | { kind: 'workspace'; workspaceRoot: string }
  | { kind: 'shortcut-command'; commandId: KeyboardShortcutCommandId }
  | { kind: 'slash-command'; commandId: SlashCommandId; insertText: string }
  | { kind: 'extension-view'; entryId: string; locked: boolean }

export type PaletteIcon =
  | { kind: 'lucide'; icon: LucideIcon }
  | { kind: 'extension'; extensionId: string; iconPath?: string }

export type PaletteEntry = {
  /** Stable identity, unique across all sources for one snapshot. */
  id: string
  source: PaletteSourceKind
  title: string
  subtitle?: string
  keywords: string[]
  /** Short right-aligned hint such as a key binding or the command text. */
  badge?: string
  icon?: PaletteIcon
  disabled?: boolean
  disabledReason?: string
  activation: PaletteActivation
}

/**
 * Tie-break priority when two entries match a query in the same tier.
 * Lower sorts first.
 */
export const PALETTE_SOURCE_PRIORITY: Record<PaletteSourceKind, number> = {
  'shortcut-command': 0,
  'slash-command': 1,
  // Acting on the current conversation is the narrowest, most deliberate
  // intent, so it outranks navigation when both match equally well.
  action: 2,
  route: 3,
  settings: 4,
  thread: 5,
  model: 6,
  workspace: 7,
  'extension-view': 8,
  // A fallback offer only ever renders when nothing else matched.
  compose: 9
}

export type PaletteRecentIdentity = {
  source: PaletteSourceKind
  /** The entry id the recent references. */
  id: string
}

/** Entry ids the empty-query state falls back to when no recents exist. */
export const DEFAULT_PALETTE_ENTRY_IDS = [
  'cmd:new-chat',
  'cmd:choose-workspace',
  'slash:new',
  'slash:plan',
  'slash:research',
  'route:write',
  'route:design',
  'settings:providers'
] as const
