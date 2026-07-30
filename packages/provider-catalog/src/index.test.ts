import { describe, expect, it } from 'vitest'
import {
  getProviderCatalogPreset,
  providerCatalogEntries,
  PROVIDER_CATALOG
} from './index.js'

describe('provider catalog', () => {
  it('publishes every GUI base preset and Token Plan as stable entries', () => {
    const entries = providerCatalogEntries()
    expect(PROVIDER_CATALOG).toHaveLength(23)
    expect(entries).toHaveLength(27)
    expect(entries.filter((entry) => entry.category === 'subscription')).toHaveLength(17)
    expect(entries.filter((entry) => entry.category === 'api')).toHaveLength(10)
    expect(entries.map((entry) => entry.profileId)).toEqual(expect.arrayContaining([
      'gemini-subscription',
      'gemini-cli-subscription',
      'cursor-subscription',
      'ollama',
      'volcengine',
      'volcengine-agent-plan',
      'xiaomi-token-plan',
      'minimax-token-plan',
      'aliyun-token-plan',
      'tencentcloud-token-plan'
    ]))
  })

  it('keeps OAuth connection routing in the shared source of truth', () => {
    expect(getProviderCatalogPreset('grok-subscription')).toMatchObject({
      baseUrl: 'https://cli-chat-proxy.grok.com/v1',
      endpointFormat: 'responses',
      authFlow: 'grok-oauth',
      models: [
        'grok-4.5',
        'grok-4-1-fast-reasoning',
        'grok-4-1-fast-non-reasoning',
        'grok-code-fast-1'
      ]
    })
    expect(getProviderCatalogPreset('codex')?.models).toHaveLength(7)
    expect(getProviderCatalogPreset('claude-subscription')?.models).toContain('claude-opus-4-8')
  })
})
