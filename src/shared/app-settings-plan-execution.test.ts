import { describe, expect, it } from 'vitest'
import {
  defaultKunRuntimeSettings,
  mergeKunRuntimeSettings,
  normalizeAppSettings,
  type AppSettingsV1
} from './app-settings'

describe('Kun plan execution settings', () => {
  it('defaults isolated worktree builds on for new and legacy settings', () => {
    expect(defaultKunRuntimeSettings().planExecution.useWorktreeByDefault).toBe(true)

    const legacy = defaultKunRuntimeSettings() as Partial<ReturnType<typeof defaultKunRuntimeSettings>>
    delete legacy.planExecution
    const normalized = normalizeAppSettings({
      version: 1,
      agents: { kun: legacy }
    } as unknown as AppSettingsV1)

    expect(normalized.agents.kun.planExecution).toEqual({ useWorktreeByDefault: true })
  })

  it('round-trips explicit off and on patches', () => {
    const disabled = mergeKunRuntimeSettings(defaultKunRuntimeSettings(), {
      planExecution: { useWorktreeByDefault: false }
    })
    const enabled = mergeKunRuntimeSettings(disabled, {
      planExecution: { useWorktreeByDefault: true }
    })

    expect(disabled.planExecution.useWorktreeByDefault).toBe(false)
    expect(enabled.planExecution.useWorktreeByDefault).toBe(true)
  })
})
