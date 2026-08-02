import { describe, expect, it } from 'vitest'
import {
  allowsDevelopmentManagerBootstrap,
  resolveCliRuntimeFlavor,
  runtimeBuildIdForFlavor,
  runtimeDisplayName
} from './runtime-flavor.js'

describe('CLI runtime flavor', () => {
  it('routes kun and kun-dv executable names deterministically', () => {
    expect(resolveCliRuntimeFlavor({ executablePath: '/usr/local/bin/kun' })).toBe('production')
    expect(resolveCliRuntimeFlavor({ executablePath: 'C:\\Kun\\kun-dv.exe' })).toBe('development')
  })

  it('prefers the explicit runtime flavor environment', () => {
    expect(resolveCliRuntimeFlavor({
      executablePath: '/usr/local/bin/kun',
      env: { KUN_RUNTIME_FLAVOR: 'development' }
    })).toBe('development')
  })

  it('uses distinct status labels', () => {
    expect(runtimeDisplayName('production')).toBe('Kun runtime')
    expect(runtimeDisplayName('development')).toBe('kun-dv runtime')
  })

  it('allows Manager bootstrap only for an explicitly marked development workflow', () => {
    expect(allowsDevelopmentManagerBootstrap({
      flavor: 'development',
      env: { KUN_ALLOW_DEVELOPMENT_MANAGER_BOOTSTRAP: '1' }
    })).toBe(true)
    expect(allowsDevelopmentManagerBootstrap({
      flavor: 'development',
      env: {}
    })).toBe(false)
    expect(allowsDevelopmentManagerBootstrap({
      flavor: 'production',
      env: { KUN_ALLOW_DEVELOPMENT_MANAGER_BOOTSTRAP: '1' }
    })).toBe(false)
    expect(allowsDevelopmentManagerBootstrap({
      flavor: 'development',
      env: { KUN_ALLOW_DEVELOPMENT_MANAGER_BOOTSTRAP: '1' },
      isPackaged: true
    })).toBe(false)
  })

  it('keeps production build IDs stable and namespaces development builds', () => {
    const buildId = 'a'.repeat(64)
    expect(runtimeBuildIdForFlavor(buildId, 'production')).toBe(buildId)
    const development = runtimeBuildIdForFlavor(buildId, 'development')
    expect(development).toMatch(/^[a-f0-9]{64}$/u)
    expect(development).not.toBe(buildId)
    expect(runtimeBuildIdForFlavor(buildId, 'development')).toBe(development)
  })
})
