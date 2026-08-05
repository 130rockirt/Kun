import { describe, expect, it } from 'vitest'
import { activeModelConnectionProviderId } from './runtime-factory.js'

describe('activeModelConnectionProviderId', () => {
  const providers = {
    deepseek: {
      apiKey: '',
      baseUrl: 'https://api.deepseek.com',
      endpointFormat: 'chat_completions' as const,
      models: ['deepseek-chat']
    }
  }

  it('keeps the provider identity for legacy and Registry-owned credential sources', () => {
    expect(activeModelConnectionProviderId({
      credentialSourceId: 'settings:provider:deepseek',
      providers
    })).toBe('deepseek')
    expect(activeModelConnectionProviderId({
      credentialSourceId: 'model-connection:deepseek',
      providers
    })).toBe('deepseek')
  })

  it('does not accept a credential source for an unavailable provider', () => {
    expect(activeModelConnectionProviderId({
      credentialSourceId: 'model-connection:missing',
      providers
    })).toBe('default')
  })
})
