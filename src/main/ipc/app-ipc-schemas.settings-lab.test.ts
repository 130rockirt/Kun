import { describe, expect, it } from 'vitest'
import { settingsPatchSchema } from './app-ipc-schemas'

describe('app-ipc-schemas Laboratory settings', () => {
  it('accepts the isolated plan-build experiment switch', () => {
    const payload = settingsPatchSchema.parse({
      agents: { kun: { lab: { planWorktree: { enabled: false } } } }
    })

    expect(payload.agents?.kun?.lab?.planWorktree?.enabled).toBe(false)
  })

  it('rejects invalid isolated plan-build experiment values', () => {
    expect(() => settingsPatchSchema.parse({
      agents: { kun: { lab: { planWorktree: { enabled: 'yes' } } } }
    })).toThrow()
    expect(() => settingsPatchSchema.parse({
      agents: { kun: { lab: { planWorktree: { unknown: true } } } }
    })).toThrow()
  })
})
