import { describe, expect, it } from 'vitest'
import {
  getModelProviderPreset,
  modelProviderPresetProfile,
  normalizeModelProviderSettings
} from './app-settings'

describe('Antigravity provider settings persistence', () => {
  it('preserves a synchronized mixed-family catalog and reasoning metadata', () => {
    const profile = modelProviderPresetProfile(
      getModelProviderPreset('gemini-subscription')!,
      ''
    )
    const normalized = normalizeModelProviderSettings({
      providers: [{
        ...profile,
        models: ['gemini-3.6-flash', 'claude-sonnet-4-6', 'gpt-oss-120b'],
        modelProfiles: {
          ...profile.modelProfiles,
          'claude-sonnet-4-6': {
            inputModalities: ['text', 'image'],
            outputModalities: ['text'],
            supportsToolCalling: true,
            messageParts: ['text', 'image_url'],
            reasoning: {
              supportedEfforts: ['medium'],
              defaultEffort: 'medium',
              requestProtocol: 'none'
            }
          },
          'gpt-oss-120b': {
            inputModalities: ['text'],
            outputModalities: ['text'],
            supportsToolCalling: true,
            messageParts: ['text'],
            reasoning: {
              supportedEfforts: ['medium'],
              defaultEffort: 'medium',
              requestProtocol: 'none'
            }
          }
        }
      }]
    })
    const saved = normalized.providers.find((provider) => provider.id === profile.id)

    expect(saved?.models).toEqual([
      'claude-sonnet-4-6',
      'gemini-3.6-flash',
      'gpt-oss-120b'
    ])
    expect(saved?.modelProfiles['claude-sonnet-4-6']?.reasoning).toEqual({
      supportedEfforts: ['medium'],
      defaultEffort: 'medium',
      requestProtocol: 'none'
    })
    expect(saved?.modelProfiles['gpt-oss-120b']?.reasoning?.supportedEfforts)
      .toEqual(['medium'])
  })
})
