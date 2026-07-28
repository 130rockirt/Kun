import { describe, expect, it } from 'vitest'
import { defaultModelProviderSettings } from '@shared/app-settings'
import {
  projectSharedModelConnections,
  sharedProviderSetupNeedsApiKey
} from './settings-section-providers'

describe('shared model connection API-key setup status', () => {
  it('accepts a credential held only by the protected shared registry', () => {
    const providers = defaultModelProviderSettings().providers

    expect(sharedProviderSetupNeedsApiKey(providers, {
      schemaVersion: 1,
      revision: 1,
      providers: [{
        id: 'deepseek',
        accountId: 'account:deepseek',
        name: 'DeepSeek',
        kind: 'http',
        authType: 'api-key',
        baseUrl: 'https://api.deepseek.com',
        endpointFormat: 'chat_completions',
        configured: true,
        models: ['deepseek-chat']
      }]
    })).toBe(false)
  })

  it('requests setup only after the shared registry confirms no credential', () => {
    const providers = defaultModelProviderSettings().providers

    expect(sharedProviderSetupNeedsApiKey(providers, null)).toBe(false)
    expect(sharedProviderSetupNeedsApiKey(providers, {
      schemaVersion: 1,
      revision: 1,
      providers: [{
        id: 'deepseek',
        accountId: 'account:deepseek',
        name: 'DeepSeek',
        kind: 'http',
        authType: 'api-key',
        baseUrl: 'https://api.deepseek.com',
        endpointFormat: 'chat_completions',
        configured: false,
        models: ['deepseek-chat']
      }]
    })).toBe(true)
  })
})

describe('shared model connection settings projection', () => {
  it('projects a TUI-owned default without clearing existing protected compatibility credentials', () => {
    const current = defaultModelProviderSettings()
    current.providers[0]!.apiKey = 'legacy-plaintext'

    const projected = projectSharedModelConnections(current, {
      schemaVersion: 1,
      revision: 4,
      providers: [{
        id: 'codex',
        accountId: 'account:codex',
        name: 'Codex',
        kind: 'http',
        authType: 'subscription',
        baseUrl: 'https://example.test/codex',
        endpointFormat: 'responses',
        configured: true,
        models: ['gpt-live'],
        selectedModel: 'gpt-live'
      }],
      defaultProviderId: 'codex',
      defaultAccountId: 'account:codex',
      defaultModel: 'gpt-live',
      proxy: { enabled: false, url: '' },
      routePools: [],
      localModelGateway: { enabled: false }
    })

    expect(projected.kun).toEqual({ providerId: 'codex', model: 'gpt-live' })
    expect(projected.provider.providers.find((provider) => provider.id === 'codex')).toMatchObject({
      apiKey: '',
      models: ['gpt-live']
    })
    expect(projected.provider.providers.find((provider) => provider.id === 'deepseek')?.apiKey)
      .toBe('legacy-plaintext')
  })

  it('preserves an existing provider credential while applying shared metadata', () => {
    const current = defaultModelProviderSettings()
    current.providers.push({
      ...current.providers[0]!,
      id: 'custom',
      name: 'Old name',
      apiKey: 'protected-runtime-value',
      baseUrl: 'https://old.example/v1',
      models: ['old-model']
    })

    const projected = projectSharedModelConnections(current, {
      schemaVersion: 1,
      revision: 7,
      providers: [{
        id: 'custom',
        accountId: 'account:custom',
        name: 'Shared name',
        kind: 'http',
        authType: 'api-key',
        baseUrl: 'https://new.example/v1',
        endpointFormat: 'chat_completions',
        configured: true,
        models: ['new-model']
      }]
    })

    expect(projected.provider.providers.find((provider) => provider.id === 'custom')).toMatchObject({
      apiKey: 'protected-runtime-value',
      baseUrl: 'https://new.example/v1',
      models: ['new-model']
    })
  })

  it('clears the GUI default when the last shared connection is removed', () => {
    const projected = projectSharedModelConnections(defaultModelProviderSettings(), {
      schemaVersion: 1,
      revision: 5,
      providers: [],
      proxy: { enabled: false, url: '' },
      routePools: [],
      localModelGateway: { enabled: false }
    })

    expect(projected.kun).toEqual({ providerId: '', model: '' })
  })
})
