import { describe, expect, it } from 'vitest'
import type { AppSettingsV1 } from '../shared/app-settings'
import { managedKunHostCanAutoStart } from './managed-runtime-startup-policy'

describe('managed Kun host startup policy', () => {
  it('allows an SDK-only configuration without a default DeepSeek key', () => {
    const settings = {
      agents: {
        kun: {
          autoStart: true,
          apiKey: '',
          providerId: 'cursor-subscription',
          model: 'auto'
        }
      }
    } as AppSettingsV1

    expect(managedKunHostCanAutoStart(settings)).toBe(true)
  })

  it('still respects an explicit auto-start disable', () => {
    const settings = {
      agents: { kun: { autoStart: false, apiKey: '' } }
    } as AppSettingsV1

    expect(managedKunHostCanAutoStart(settings)).toBe(false)
  })
})
