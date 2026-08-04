import { describe, expect, it } from 'vitest'
import { buildSddAssistantModelOverrides } from './useWorkbenchSddTurnController'

describe('SDD assistant model selection', () => {
  it('forwards the model, provider, and reasoning selected in the assistant sidebar', () => {
    expect(buildSddAssistantModelOverrides({
      model: ' gpt-5.6-sol ',
      providerId: ' codex ',
      reasoningEffort: 'max',
      fastMode: true,
      modelGroups: [{
        providerId: 'codex',
        presetSource: 'codex',
        label: 'Codex',
        modelIds: ['gpt-5.6-sol'],
        modelProfiles: {
          'gpt-5.6-sol': {
            inputModalities: ['text'],
            outputModalities: ['text'],
            supportsToolCalling: true,
            messageParts: ['text'],
            serviceTiers: ['priority']
          }
        }
      }]
    })).toEqual({
      model: 'gpt-5.6-sol',
      providerId: 'codex',
      reasoningEffort: 'max',
      serviceTier: 'priority'
    })
  })

  it('omits only empty model routing fields', () => {
    expect(buildSddAssistantModelOverrides({
      model: ' ',
      providerId: '',
      reasoningEffort: 'auto',
      fastMode: false,
      modelGroups: []
    })).toEqual({
      reasoningEffort: 'auto'
    })
  })
})
