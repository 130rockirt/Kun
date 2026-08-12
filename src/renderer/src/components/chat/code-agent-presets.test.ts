import { describe, expect, it, vi } from 'vitest'

vi.mock('../../i18n', () => ({
  default: { t: (key: string) => `i18n:${key}` }
}))

const { resolveCodeAgentPreset, resolveCodeAgentPersona } = await import('./code-agent-presets')

describe('resolveCodeAgentPreset', () => {
  it('falls back to localized text for a blank built-in', () => {
    const resolved = resolveCodeAgentPreset({ id: 'doubter', name: '', icon: 'SearchCheck', persona: '' })
    expect(resolved.builtin).toBe(true)
    expect(resolved.name).toBe('i18n:codeAgentPreset_doubter_name')
    expect(resolved.persona).toBe('i18n:codeAgentPreset_doubter_persona')
  })

  it('prefers user text over the localized default', () => {
    const resolved = resolveCodeAgentPreset({
      id: 'doubter',
      name: 'My skeptic',
      icon: 'ScanSearch',
      persona: 'My wording'
    })
    expect(resolved.name).toBe('My skeptic')
    expect(resolved.persona).toBe('My wording')
  })

  it('renders a legacy built-in row that predates the icon field', () => {
    const resolved = resolveCodeAgentPreset({ id: 'doubter' })

    expect(resolved.name).toBe('i18n:codeAgentPreset_doubter_name')
    expect(resolved.icon).toBe('SearchCheck')
    expect(resolved.persona).toBe('i18n:codeAgentPreset_doubter_persona')
  })

  it('never invents localized text for custom presets', () => {
    const resolved = resolveCodeAgentPreset({ id: 'custom-1', name: '', icon: '', persona: '' })
    expect(resolved.builtin).toBe(false)
    expect(resolved.name).toBe('custom-1')
    expect(resolved.persona).toBe('')
    expect(resolved.icon).toBe('Bot')
  })
})

describe('resolveCodeAgentPersona', () => {
  const presets = [{ id: 'doubter', name: 'Doubter', icon: 'SearchCheck', persona: 'Be skeptical.' }]

  it('returns the persona text for the active preset', () => {
    expect(resolveCodeAgentPersona(presets, 'doubter')).toBe('Be skeptical.')
  })

  it('returns empty when nothing is selected', () => {
    expect(resolveCodeAgentPersona(presets, '')).toBe('')
  })

  it('degrades to no persona when the selected preset was deleted', () => {
    expect(resolveCodeAgentPersona(presets, 'removed-id')).toBe('')
  })
})
