import { describe, expect, it } from 'vitest'
import { buildSddAssistantModelOverrides } from './useWorkbenchSddTurnController'

describe('SDD assistant model selection', () => {
  it('forwards the model, provider, and reasoning selected in the assistant sidebar', () => {
    expect(buildSddAssistantModelOverrides({
      model: ' gpt-5.6-sol ',
      providerId: ' codex ',
      reasoningEffort: 'max'
    })).toEqual({
      model: 'gpt-5.6-sol',
      providerId: 'codex',
      reasoningEffort: 'max'
    })
  })

  it('omits only empty model routing fields', () => {
    expect(buildSddAssistantModelOverrides({
      model: ' ',
      providerId: '',
      reasoningEffort: 'auto'
    })).toEqual({
      reasoningEffort: 'auto'
    })
  })
})
