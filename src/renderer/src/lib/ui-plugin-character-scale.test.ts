import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  UI_PLUGIN_CHARACTER_SCALE_DEFAULT,
  normalizeUiPluginCharacterScale,
  readUiPluginCharacterScalePreference,
  removeUiPluginCharacterScalePreference,
  uiPluginCharacterScaleStorageKey,
  writeUiPluginCharacterScalePreference
} from './ui-plugin-character-scale'

class MemoryStorage {
  private readonly values = new Map<string, string>()

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

describe('UI plugin character scale preference', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('normalizes finite values and safely defaults malformed input', () => {
    expect(normalizeUiPluginCharacterScale(0.1)).toBe(0.5)
    expect(normalizeUiPluginCharacterScale(2.8)).toBe(2)
    expect(normalizeUiPluginCharacterScale(1.236)).toBe(1.24)
    expect(normalizeUiPluginCharacterScale('1.35')).toBe(1.35)
    expect(normalizeUiPluginCharacterScale('')).toBe(UI_PLUGIN_CHARACTER_SCALE_DEFAULT)
    expect(normalizeUiPluginCharacterScale('invalid')).toBe(UI_PLUGIN_CHARACTER_SCALE_DEFAULT)
    expect(normalizeUiPluginCharacterScale(Number.NaN)).toBe(UI_PLUGIN_CHARACTER_SCALE_DEFAULT)
  })

  it('isolates persisted values by normalized plugin id and removes them', () => {
    const localStorage = new MemoryStorage()
    vi.stubGlobal('window', { localStorage })

    expect(writeUiPluginCharacterScalePreference(' Alpha-Theme ', 1.65)).toBe(1.65)
    expect(writeUiPluginCharacterScalePreference('beta-theme', 0.75)).toBe(0.75)
    expect(readUiPluginCharacterScalePreference('alpha-theme')).toBe(1.65)
    expect(readUiPluginCharacterScalePreference('BETA-THEME')).toBe(0.75)

    removeUiPluginCharacterScalePreference('alpha-theme')

    expect(localStorage.getItem(uiPluginCharacterScaleStorageKey('alpha-theme'))).toBeNull()
    expect(readUiPluginCharacterScalePreference('alpha-theme'))
      .toBe(UI_PLUGIN_CHARACTER_SCALE_DEFAULT)
    expect(readUiPluginCharacterScalePreference('beta-theme')).toBe(0.75)
  })

  it('clamps stored finite values and defaults malformed storage', () => {
    const localStorage = new MemoryStorage()
    vi.stubGlobal('window', { localStorage })
    localStorage.setItem(uiPluginCharacterScaleStorageKey('small-theme'), '0.2')
    localStorage.setItem(uiPluginCharacterScaleStorageKey('large-theme'), '9')
    localStorage.setItem(uiPluginCharacterScaleStorageKey('broken-theme'), 'NaN')

    expect(readUiPluginCharacterScalePreference('small-theme')).toBe(0.5)
    expect(readUiPluginCharacterScalePreference('large-theme')).toBe(2)
    expect(readUiPluginCharacterScalePreference('broken-theme'))
      .toBe(UI_PLUGIN_CHARACTER_SCALE_DEFAULT)
  })
})
