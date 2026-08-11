import { describe, expect, it } from 'vitest'
import {
  CODE_AGENT_PRESET_BUILTIN_IDS,
  CODE_AGENT_PRESET_FALLBACK_ICON,
  defaultCodeAgentPresets,
  isBuiltinCodeAgentPresetId,
  normalizeCodeAgentPresets
} from './app-settings-code-agents'
import {
  CODE_AGENT_PERSONA_MAX_CHARS,
  CODE_AGENT_PRESET_MAX_COUNT,
  CODE_AGENT_PRESET_NAME_MAX_CHARS
} from './app-settings-types'

describe('code agent presets', () => {
  it('seeds the built-ins when the field is absent', () => {
    expect(normalizeCodeAgentPresets(undefined).map((preset) => preset.id)).toEqual([
      ...CODE_AGENT_PRESET_BUILTIN_IDS
    ])
  })

  it('ships built-ins with blank name and persona so they re-translate', () => {
    for (const preset of defaultCodeAgentPresets()) {
      expect(preset.name).toBe('')
      expect(preset.persona).toBe('')
      expect(preset.icon).not.toBe('')
    }
  })

  it('falls back to a default icon for rows without one (incl. legacy emoji rows)', () => {
    const [builtin] = normalizeCodeAgentPresets([{ id: 'doubter' }])
    expect(builtin.icon).toBe('SearchCheck')
    const [custom] = normalizeCodeAgentPresets([{ id: 'custom-1', persona: 'x' }])
    expect(custom.icon).toBe(CODE_AGENT_PRESET_FALLBACK_ICON)
  })

  it('keeps an explicitly emptied list empty instead of resurrecting built-ins', () => {
    expect(normalizeCodeAgentPresets([])).toEqual([])
  })

  it('drops rows without an id and de-duplicates repeated ids', () => {
    const presets = normalizeCodeAgentPresets([
      { id: '  ', name: 'blank' },
      { id: 'doubter', name: 'first' },
      { id: 'doubter', name: 'second' }
    ])
    expect(presets).toHaveLength(1)
    expect(presets[0]).toMatchObject({ id: 'doubter', name: 'first' })
  })

  it('truncates name and persona to their caps', () => {
    const [preset] = normalizeCodeAgentPresets([
      { id: 'custom-1', name: 'n'.repeat(500), persona: 'p'.repeat(CODE_AGENT_PERSONA_MAX_CHARS + 40) }
    ])
    expect(preset.name).toHaveLength(CODE_AGENT_PRESET_NAME_MAX_CHARS)
    expect(preset.persona).toHaveLength(CODE_AGENT_PERSONA_MAX_CHARS)
  })

  it('caps the catalog length', () => {
    const many = Array.from({ length: CODE_AGENT_PRESET_MAX_COUNT + 5 }, (_, index) => ({
      id: `custom-${index}`,
      persona: 'x'
    }))
    expect(normalizeCodeAgentPresets(many)).toHaveLength(CODE_AGENT_PRESET_MAX_COUNT)
  })

  it('preserves a user-customized built-in row', () => {
    const [preset] = normalizeCodeAgentPresets([{ id: 'doubter', persona: 'my own wording' }])
    expect(preset).toMatchObject({ id: 'doubter', persona: 'my own wording' })
  })

  it('recognizes only the shipped built-in ids', () => {
    expect(isBuiltinCodeAgentPresetId('doubter')).toBe(true)
    expect(isBuiltinCodeAgentPresetId('custom-abc')).toBe(false)
  })
})
