import { describe, expect, it } from 'vitest'
import { settingsPatchSchema } from './app-ipc-schemas'

describe('app-ipc-schemas Laboratory settings', () => {
  it('rejects the retired isolated plan-build experiment switch', () => {
    expect(() => settingsPatchSchema.parse({
      agents: { kun: { lab: { planWorktree: { enabled: false } } } }
    })).toThrow()
  })

  it('keeps the formal plan execution preference boolean-only', () => {
    const payload = settingsPatchSchema.parse({
      agents: { kun: { planExecution: { useWorktreeByDefault: false } } }
    })
    expect(payload.agents?.kun?.planExecution?.useWorktreeByDefault).toBe(false)
    expect(() => settingsPatchSchema.parse({
      agents: { kun: { planExecution: { useWorktreeByDefault: 'yes' } } }
    })).toThrow()
  })
})
