import {
  readBrowserStorageItem,
  removeBrowserStorageItem,
  writeBrowserStorageItem
} from './browser-storage'

export const UI_PLUGIN_CHARACTER_SCALE_MIN = 0.5
export const UI_PLUGIN_CHARACTER_SCALE_MAX = 2
export const UI_PLUGIN_CHARACTER_SCALE_DEFAULT = 1
export const UI_PLUGIN_CHARACTER_SCALE_STEP = 0.05

const UI_PLUGIN_CHARACTER_SCALE_STORAGE_PREFIX = 'kun.uiPlugin.characterScale.'

export function normalizeUiPluginCharacterScale(value: unknown): number {
  if ((typeof value !== 'number' && typeof value !== 'string') || value === '') {
    return UI_PLUGIN_CHARACTER_SCALE_DEFAULT
  }
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return UI_PLUGIN_CHARACTER_SCALE_DEFAULT
  return Math.min(
    UI_PLUGIN_CHARACTER_SCALE_MAX,
    Math.max(UI_PLUGIN_CHARACTER_SCALE_MIN, Math.round(parsed * 100) / 100)
  )
}

export function uiPluginCharacterScaleStorageKey(pluginId: string): string {
  return `${UI_PLUGIN_CHARACTER_SCALE_STORAGE_PREFIX}${encodeURIComponent(pluginId.trim().toLowerCase())}`
}

export function readUiPluginCharacterScalePreference(pluginId: string): number {
  const normalizedId = pluginId.trim().toLowerCase()
  if (!normalizedId) return UI_PLUGIN_CHARACTER_SCALE_DEFAULT
  const stored = readBrowserStorageItem(uiPluginCharacterScaleStorageKey(normalizedId))
  if (stored === null || !stored.trim()) return UI_PLUGIN_CHARACTER_SCALE_DEFAULT
  return normalizeUiPluginCharacterScale(stored)
}

export function writeUiPluginCharacterScalePreference(pluginId: string, value: unknown): number {
  const normalizedId = pluginId.trim().toLowerCase()
  const normalizedScale = normalizeUiPluginCharacterScale(value)
  if (normalizedId) {
    writeBrowserStorageItem(
      uiPluginCharacterScaleStorageKey(normalizedId),
      String(normalizedScale)
    )
  }
  return normalizedScale
}

export function removeUiPluginCharacterScalePreference(pluginId: string): void {
  const normalizedId = pluginId.trim().toLowerCase()
  if (!normalizedId) return
  removeBrowserStorageItem(uiPluginCharacterScaleStorageKey(normalizedId))
}
