import { describe, expect, it } from 'vitest'
import { resolveDataMigrationFeatureEnabled } from './feature-policy'

describe('data migration release policy', () => {
  it('keeps normal packaged launches disabled until rollout gates pass', () => {
    expect(resolveDataMigrationFeatureEnabled({})).toBe(false)
  })

  it('accepts only the explicit internal-dogfood opt-in', () => {
    expect(resolveDataMigrationFeatureEnabled({ KUN_DATA_MIGRATION_ENABLED: '1' })).toBe(true)
    expect(resolveDataMigrationFeatureEnabled({ KUN_DATA_MIGRATION_ENABLED: 'true' })).toBe(false)
  })

  it('keeps the emergency disable override', () => {
    expect(resolveDataMigrationFeatureEnabled({ KUN_DATA_MIGRATION_ENABLED: '0' })).toBe(false)
  })
})
