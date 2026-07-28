import { describe, expect, it, vi } from 'vitest'
import type { AppSettingsV1, ModelProviderProfileV1 } from '../shared/app-settings'
import {
  classifyProviderQuotaProbe,
  listProviderQuotas,
  parseDeepSeekQuota,
  parseMiniMaxQuota,
  parseMoonshotQuota,
  parseOpenAiQuota,
  parseOpenRouterQuota,
  parseZaiQuota
} from './provider-quota'

function provider(
  id: string,
  name: string,
  baseUrl: string,
  apiKey = 'secret-key',
  presetId?: string
): ModelProviderProfileV1 {
  return {
    id,
    name,
    ...(presetId ? { presetSource: { presetId, mode: 'api' as const } } : {}),
    apiKey,
    baseUrl,
    endpointFormat: 'chat_completions',
    models: ['test-model'],
    modelProfiles: {
      'test-model': {
        inputModalities: ['text'],
        outputModalities: ['text'],
        supportsToolCalling: true,
        messageParts: ['text']
      }
    }
  }
}

function settings(providers: ModelProviderProfileV1[], proxyUrl = ''): AppSettingsV1 {
  const defaultProvider = providers.find((item) => item.id === 'deepseek')
  return {
    provider: {
      apiKey: defaultProvider?.apiKey ?? '',
      baseUrl: defaultProvider?.baseUrl ?? 'https://api.deepseek.com',
      providers,
      proxy: { enabled: Boolean(proxyUrl), url: proxyUrl }
    }
  } as unknown as AppSettingsV1
}

describe('provider quota parsers', () => {
  it('normalizes DeepSeek monetary balances', () => {
    expect(parseDeepSeekQuota({
      is_available: true,
      balance_infos: [{
        currency: 'CNY',
        total_balance: '12.50',
        granted_balance: '2.50',
        topped_up_balance: '10.00'
      }]
    })).toEqual([
      { id: 'balance', label: 'Account balance', unit: 'CNY', remaining: 12.5 },
      { id: 'paid-balance', label: 'Paid balance', unit: 'CNY', remaining: 10 },
      { id: 'granted-balance', label: 'Granted balance', unit: 'CNY', remaining: 2.5 }
    ])
  })

  it('normalizes OpenRouter credits and an optional API-key budget', () => {
    expect(parseOpenRouterQuota(
      { data: { total_credits: 100, total_usage: 25 } },
      { data: { limit: 20, usage: 5 } }
    )).toEqual([
      {
        id: 'credits',
        label: 'Credits',
        unit: 'USD',
        used: 25,
        limit: 100,
        remaining: 75,
        usedPercent: 25
      },
      {
        id: 'key-budget',
        label: 'API key budget',
        unit: 'USD',
        used: 5,
        limit: 20,
        remaining: 15,
        usedPercent: 25
      }
    ])
  })

  it('normalizes Moonshot balance components', () => {
    expect(parseMoonshotQuota({
      code: 0,
      status: true,
      data: { available_balance: 8.5, cash_balance: 6, voucher_balance: 2.5 }
    })).toHaveLength(3)
  })

  it('normalizes Z.ai token and request windows', () => {
    const result = parseZaiQuota({
      code: 200,
      success: true,
      data: {
        planName: 'Lite plan',
        limits: [{
          type: 'TOKENS_LIMIT',
          unit: 3,
          number: 5,
          usage: 1000,
          currentValue: 250,
          remaining: 750,
          percentage: 25,
          nextResetTime: 1_800_000_000_000
        }]
      }
    })
    expect(result.summary).toBe('Lite plan')
    expect(result.metrics[0]).toMatchObject({
      label: '5-hour token quota',
      unit: 'tokens',
      used: 250,
      limit: 1000,
      remaining: 750,
      usedPercent: 25,
      resetsAt: '2027-01-15T08:00:00.000Z'
    })
  })

  it('normalizes MiniMax interval and weekly remains', () => {
    const result = parseMiniMaxQuota({
      base_resp: { status_code: 0 },
      current_subscribe_title: 'Coding Plan Plus',
      model_remains: [{
        model_name: 'MiniMax-M2.5',
        current_interval_total_count: 100,
        current_interval_usage_count: 60,
        current_interval_remaining_percent: 60,
        end_time: 1_800_000_000,
        current_weekly_total_count: 1000,
        current_weekly_usage_count: 700,
        current_weekly_remaining_percent: 70,
        weekly_end_time: 1_800_086_400
      }]
    })
    expect(result.summary).toBe('Coding Plan Plus')
    expect(result.metrics).toEqual([
      {
        id: 'interval-0',
        label: 'MiniMax-M2.5 interval quota',
        unit: 'requests',
        used: 40,
        limit: 100,
        remaining: 60,
        usedPercent: 40,
        resetsAt: '2027-01-15T08:00:00.000Z'
      },
      {
        id: 'weekly-0',
        label: 'MiniMax-M2.5 weekly quota',
        unit: 'requests',
        used: 300,
        limit: 1000,
        remaining: 700,
        usedPercent: 30,
        resetsAt: '2027-01-16T08:00:00.000Z'
      }
    ])
  })

  it('handles MiniMax percentage-only windows and skips unavailable quota lanes', () => {
    const result = parseMiniMaxQuota({
      model_remains: [{
        model_name: 'general',
        current_interval_total_count: 0,
        current_interval_usage_count: 0,
        current_interval_remaining_percent: 96,
        current_interval_status: 1,
        end_time: 1_800_000_000_000,
        current_weekly_total_count: 0,
        current_weekly_usage_count: 0,
        current_weekly_remaining_percent: 70,
        current_weekly_status: 1,
        weekly_end_time: 1_800_086_400_000
      }, {
        model_name: 'video',
        current_interval_total_count: 0,
        current_interval_usage_count: 0,
        current_interval_remaining_percent: 100,
        current_interval_status: 3
      }],
      base_resp: { status_code: 0 }
    })

    expect(result.metrics).toEqual([
      {
        id: 'interval-0',
        label: 'general interval quota',
        unit: 'requests',
        usedPercent: 4,
        resetsAt: '2027-01-15T08:00:00.000Z'
      },
      {
        id: 'weekly-0',
        label: 'general weekly quota',
        unit: 'requests',
        usedPercent: 30,
        resetsAt: '2027-01-16T08:00:00.000Z'
      }
    ])
  })

  it('normalizes OpenAI credit grants without inventing missing fields', () => {
    expect(parseOpenAiQuota({
      total_granted: 50,
      total_used: 10,
      total_available: 40,
      grants: { data: [] }
    })[0]).toEqual({
      id: 'credits',
      label: 'Credits',
      unit: 'USD',
      used: 10,
      limit: 50,
      remaining: 40,
      usedPercent: 20
    })
  })
})

describe('provider quota registry and refresh', () => {
  it('requires exact known hostnames for custom providers', () => {
    expect(classifyProviderQuotaProbe(
      provider('custom-openai', 'OpenAI', 'https://api.openai.com/v1')
    )?.kind).toBe('openai')
    expect(classifyProviderQuotaProbe(
      provider('hostile', 'Hostile', 'https://attacker.example/api.openai.com/v1')
    )).toBeNull()
    expect(classifyProviderQuotaProbe(
      provider('deepseek-proxy', 'DeepSeek proxy', 'https://gateway.example/v1', 'gateway-key', 'deepseek')
    )).toBeNull()
  })

  it('keeps every configured provider separate and does not request unsupported or keyless entries', async () => {
    const fetcher = vi.fn(async (url: string | URL, _: RequestInit | undefined, proxyUrl: string) => {
      expect(proxyUrl).toBe('http://127.0.0.1:7890/')
      expect(url.toString()).toBe('https://api.deepseek.com/user/balance')
      return new Response(JSON.stringify({
        balance_infos: [{ currency: 'CNY', total_balance: '9.5' }]
      }))
    })
    const result = await listProviderQuotas(settings([
      provider('deepseek', 'DeepSeek One', 'https://api.deepseek.com', 'secret-one', 'deepseek'),
      provider('deepseek-two', 'DeepSeek Two', 'https://api.deepseek.com', '', 'deepseek'),
      provider('unknown', 'Unknown', 'https://example.test/v1')
    ], 'http://127.0.0.1:7890'), fetcher)

    expect(result.entries.map((entry) => [entry.providerId, entry.status])).toEqual([
      ['deepseek', 'available'],
      ['deepseek-two', 'missing_credentials'],
      ['unknown', 'unsupported']
    ])
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(result)).not.toContain('secret-one')
  })

  it('isolates a provider HTTP failure from successful providers', async () => {
    const fetcher = vi.fn(async (url: string | URL) => {
      if (url.toString().includes('openrouter.ai')) {
        return new Response('sensitive upstream body', { status: 500 })
      }
      return new Response(JSON.stringify({
        balance_infos: [{ currency: 'CNY', total_balance: '2' }]
      }))
    })
    const result = await listProviderQuotas(settings([
      provider('deepseek', 'DeepSeek', 'https://api.deepseek.com'),
      provider('openrouter', 'OpenRouter', 'https://openrouter.ai/api/v1')
    ]), fetcher)

    expect(result.entries[0]).toMatchObject({ providerId: 'deepseek', status: 'available' })
    expect(result.entries[1]).toMatchObject({
      providerId: 'openrouter',
      status: 'error',
      message: 'The provider quota endpoint returned HTTP 500.'
    })
    expect(JSON.stringify(result)).not.toContain('sensitive upstream body')
  })
})
