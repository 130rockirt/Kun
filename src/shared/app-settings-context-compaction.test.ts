import { describe, expect, it } from 'vitest'
import {
  KUN_CONTEXT_COMPACTION_DEFAULTS_VERSION,
  defaultKunRuntimeSettings,
  defaultModelProviderSettings,
  mergeKunRuntimeSettings,
  migrateKunContextCompactionDefaults,
  normalizeAppSettings,
  type AppSettingsV1,
  type KunContextCompactionSettingsV1
} from './app-settings'

function settingsWithCompaction(
  contextCompaction: Partial<KunContextCompactionSettingsV1>
): AppSettingsV1 {
  const runtime = defaultKunRuntimeSettings()
  return {
    version: 1,
    provider: defaultModelProviderSettings(),
    agents: {
      kun: {
        ...runtime,
        contextCompaction: {
          ...runtime.contextCompaction,
          ...contextCompaction
        }
      }
    }
  } as AppSettingsV1
}

describe('Kun context compaction default migrations', () => {
  it.each([
    { soft: 16_000, hard: 24_000 },
    { soft: 96_000, hard: 108_800 }
  ])('upgrades the markerless legacy $soft/$hard defaults', ({ soft, hard }) => {
    const input = settingsWithCompaction({
      defaultSoftThreshold: soft,
      defaultHardThreshold: hard
    })
    delete input.agents.kun.contextCompaction.defaultsVersion
    const migrated = migrateKunContextCompactionDefaults(input.agents.kun.contextCompaction)
    expect(migrated).toMatchObject({
      defaultSoftThreshold: 192_000,
      defaultHardThreshold: 217_600
    })
    expect(mergeKunRuntimeSettings(defaultKunRuntimeSettings(), {
      contextCompaction: migrated
    }).contextCompaction).toMatchObject({
      defaultSoftThreshold: 192_000,
      defaultHardThreshold: 217_600
    })

    const normalized = normalizeAppSettings(input)

    expect(normalized.agents.kun.contextCompaction).toMatchObject({
      defaultsVersion: KUN_CONTEXT_COMPACTION_DEFAULTS_VERSION,
      defaultSoftThreshold: 192_000,
      defaultHardThreshold: 217_600
    })
  })

  it('preserves an intentional low threshold after the defaults migration is recorded', () => {
    const normalized = normalizeAppSettings(settingsWithCompaction({
      defaultsVersion: KUN_CONTEXT_COMPACTION_DEFAULTS_VERSION,
      defaultSoftThreshold: 16_000,
      defaultHardThreshold: 24_000
    }))

    expect(normalized.agents.kun.contextCompaction).toMatchObject({
      defaultsVersion: KUN_CONTEXT_COMPACTION_DEFAULTS_VERSION,
      defaultSoftThreshold: 16_000,
      defaultHardThreshold: 24_000
    })
  })
})
