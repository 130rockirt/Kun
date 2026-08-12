import { describe, expect, it } from 'vitest'
import { settingsPatchSchema } from './settings'

describe('settings:set codeAgentPresets payload', () => {
  it('accepts a persona preset patch from the settings editor', () => {
    const parsed = settingsPatchSchema.safeParse({
      codeAgentPresets: [
        { id: 'doubter', name: '', icon: 'SearchCheck', persona: '' },
        { id: 'custom-abc', name: 'My persona', icon: 'Brain', persona: 'Be terse.' }
      ]
    })
    expect(parsed.success).toBe(true)
  })

  it('rejects rows with unknown keys (e.g. the legacy emoji field)', () => {
    const parsed = settingsPatchSchema.safeParse({
      codeAgentPresets: [{ id: 'doubter', emoji: '🧐' }]
    })
    expect(parsed.success).toBe(false)
  })

  it('rejects personas over the runtime cap', () => {
    const parsed = settingsPatchSchema.safeParse({
      codeAgentPresets: [{ id: 'custom-1', persona: 'x'.repeat(2001) }]
    })
    expect(parsed.success).toBe(false)
  })

  it('accepts the experimental composer persona switch', () => {
    const parsed = settingsPatchSchema.safeParse({
      codeAgentPersonaEnabled: false
    })
    expect(parsed.success).toBe(true)
  })
})
