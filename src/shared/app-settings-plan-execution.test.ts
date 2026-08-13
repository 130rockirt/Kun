import { describe, expect, it } from 'vitest'
import {
  defaultKunRuntimeSettings,
  mergeKunRuntimeSettings,
  normalizeAppSettings,
  type AppSettingsV1
} from './app-settings'

describe('Kun plan execution settings', () => {
  it('defaults isolated worktree builds off for new and legacy settings', () => {
    expect(defaultKunRuntimeSettings().planExecution.useWorktreeByDefault).toBe(false)
    expect(defaultKunRuntimeSettings().lab.planWorktree.enabled).toBe(false)

    const legacy = defaultKunRuntimeSettings() as Partial<ReturnType<typeof defaultKunRuntimeSettings>>
    delete (legacy.lab as Partial<ReturnType<typeof defaultKunRuntimeSettings>['lab']>)
      .planWorktree
    delete legacy.planExecution
    const normalized = normalizeAppSettings({
      version: 1,
      agents: { kun: legacy }
    } as unknown as AppSettingsV1)

    expect(normalized.agents.kun.planExecution).toEqual({ useWorktreeByDefault: false })
    expect(normalized.agents.kun.lab.planWorktree).toEqual({ enabled: false })
  })

  it('migrates the legacy preference and keeps the compatibility alias synchronized', () => {
    const legacyEnabled = mergeKunRuntimeSettings(defaultKunRuntimeSettings(), {
      planExecution: { useWorktreeByDefault: true }
    })
    const disabled = mergeKunRuntimeSettings(legacyEnabled, {
      lab: { planWorktree: { enabled: false } }
    })

    expect(legacyEnabled.lab.planWorktree.enabled).toBe(true)
    expect(legacyEnabled.planExecution.useWorktreeByDefault).toBe(true)
    expect(disabled.lab.planWorktree.enabled).toBe(false)
    expect(disabled.planExecution.useWorktreeByDefault).toBe(false)
  })
})
