import { readBrowserStorageItem, writeBrowserStorageItem } from '../lib/browser-storage'
import {
  MAX_TURN_MODEL_LABELS,
  normalizeThreadComposerModeMap,
  normalizeThreadComposerSelectionMap,
  type ComposerPlanMode,
  type ThreadComposerSelection
} from './chat-store-helpers'

const TURN_MODEL_STORAGE_KEY = 'kun.turnModelLabel'
const THREAD_COMPOSER_SELECTION_STORAGE_KEY = 'kun.threadComposerSelection.v1'
const THREAD_COMPOSER_MODE_STORAGE_KEY = 'kun.threadComposerMode.v1'

export function loadTurnModelMap(): Record<string, string> {
  try {
    const raw = readBrowserStorageItem(TURN_MODEL_STORAGE_KEY)
    if (!raw) return {}
    return normalizeTurnModelMap(JSON.parse(raw))
  } catch {
    return {}
  }
}

export function normalizeTurnModelMap(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const entries: Array<[string, string]> = []
  for (const [rawKey, rawValue] of Object.entries(raw as Record<string, unknown>)) {
    const key = rawKey.trim()
    const value = typeof rawValue === 'string' ? rawValue.trim() : ''
    if (!key || !key.includes('|') || !value) continue
    entries.push([key, value])
  }
  const recent = entries.slice(-MAX_TURN_MODEL_LABELS)
  return Object.fromEntries(recent)
}

export function saveTurnModelMap(map: Record<string, string>): void {
  writeBrowserStorageItem(TURN_MODEL_STORAGE_KEY, JSON.stringify(normalizeTurnModelMap(map)))
}

export function loadThreadComposerSelectionMap(): Record<string, ThreadComposerSelection> {
  try {
    const raw = readBrowserStorageItem(THREAD_COMPOSER_SELECTION_STORAGE_KEY)
    if (!raw) return {}
    return normalizeThreadComposerSelectionMap(JSON.parse(raw))
  } catch {
    return {}
  }
}

export function saveThreadComposerSelectionMap(map: Record<string, ThreadComposerSelection>): void {
  writeBrowserStorageItem(
    THREAD_COMPOSER_SELECTION_STORAGE_KEY,
    JSON.stringify(normalizeThreadComposerSelectionMap(map))
  )
}

export function loadThreadComposerModeMap(): Record<string, ComposerPlanMode> {
  try {
    const raw = readBrowserStorageItem(THREAD_COMPOSER_MODE_STORAGE_KEY)
    if (!raw) return {}
    return normalizeThreadComposerModeMap(JSON.parse(raw))
  } catch {
    return {}
  }
}

export function saveThreadComposerModeMap(map: Record<string, ComposerPlanMode>): void {
  writeBrowserStorageItem(
    THREAD_COMPOSER_MODE_STORAGE_KEY,
    JSON.stringify(normalizeThreadComposerModeMap(map))
  )
}
