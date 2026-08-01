import { describe, expect, it } from 'vitest'
import {
  DEVELOPMENT_APP_ID,
  DEVELOPMENT_APP_NAME,
  DEVELOPMENT_WINDOW_TITLE,
  PRODUCTION_APP_ID,
  PRODUCTION_APP_NAME,
  appIdentityForFlavor,
  appWindowTitleForFlavor,
  createAppEnvironmentInfo,
  resolveAppFlavor
} from './app-environment'

describe('application environment contracts', () => {
  it('keeps the production identity compatible', () => {
    expect(appIdentityForFlavor('production')).toEqual({
      flavor: 'production',
      appName: PRODUCTION_APP_NAME,
      appId: PRODUCTION_APP_ID,
      runtimeFlavor: 'production'
    })
    expect(PRODUCTION_APP_NAME).toBe('Kun')
    expect(PRODUCTION_APP_ID).toBe('com.xingyuzhong.deepseekgui')
  })

  it('assigns an independent development identity', () => {
    expect(appIdentityForFlavor('development')).toEqual({
      flavor: 'development',
      appName: DEVELOPMENT_APP_NAME,
      appId: DEVELOPMENT_APP_ID,
      runtimeFlavor: 'development'
    })
    expect(DEVELOPMENT_APP_NAME).toBe('kun-dv')
    expect(DEVELOPMENT_APP_ID).toBe('com.xingyuzhong.deepseekgui.dv')
  })

  it('puts the DV marker in the development window title only', () => {
    expect(appWindowTitleForFlavor('development')).toBe(DEVELOPMENT_WINDOW_TITLE)
    expect(DEVELOPMENT_WINDOW_TITLE).toBe('kun-dv · DV')
    expect(appWindowTitleForFlavor('production')).toBe('Kun')
  })

  it('prefers an explicit process argument over environment and package metadata', () => {
    expect(resolveAppFlavor({
      argv: ['--kun-app-flavor=development'],
      env: { KUN_APP_FLAVOR: 'production' },
      packagedFlavor: 'production'
    })).toBe('development')
  })

  it('uses environment, packaged metadata, then production as deterministic fallbacks', () => {
    expect(resolveAppFlavor({ env: { KUN_APP_FLAVOR: 'development' } })).toBe('development')
    expect(resolveAppFlavor({ packagedFlavor: 'development' })).toBe('development')
    expect(resolveAppFlavor()).toBe('production')
  })

  it('rejects unknown flavors instead of silently sharing production identity', () => {
    expect(() => resolveAppFlavor({ env: { KUN_APP_FLAVOR: 'preview' } }))
      .toThrow('invalid Kun application flavor')
  })

  it('returns an immutable renderer environment snapshot', () => {
    const environment = createAppEnvironmentInfo({
      identity: appIdentityForFlavor('development'),
      profilePath: '/profiles/kun-dv',
      isPackaged: false
    })
    expect(environment).toMatchObject({
      flavor: 'development',
      appName: 'kun-dv',
      profilePath: '/profiles/kun-dv',
      runtimeFlavor: 'development',
      isPackaged: false
    })
    expect(Object.isFrozen(environment)).toBe(true)
  })
})
