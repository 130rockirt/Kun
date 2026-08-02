import { describe, expect, it } from 'vitest'
import { storageRelocationFeatureEnabled } from './feature-policy'

describe('storage relocation feature policy', () => {
  it('is internal opt-in for Windows production only', () => {
    expect(storageRelocationFeatureEnabled({ platform: 'win32', flavor: 'production', environment: {} })).toBe(false)
    expect(storageRelocationFeatureEnabled({ platform: 'win32', flavor: 'production', environment: { KUN_STORAGE_RELOCATION_ENABLED: '1' } })).toBe(true)
    expect(storageRelocationFeatureEnabled({ platform: 'win32', flavor: 'development', environment: { KUN_STORAGE_RELOCATION_ENABLED: '1' } })).toBe(false)
    expect(storageRelocationFeatureEnabled({ platform: 'darwin', flavor: 'production', environment: { KUN_STORAGE_RELOCATION_ENABLED: '1' } })).toBe(false)
    expect(storageRelocationFeatureEnabled({ platform: 'win32', flavor: 'production', environment: { KUN_STORAGE_RELOCATION_ENABLED: '0' } })).toBe(false)
  })
})
