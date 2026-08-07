import { describe, expect, it, vi } from 'vitest'
import type { AppSettingsV1, ModelProviderProfileV1 } from '../shared/app-settings'
import {
  classifyProviderQuotaProbe,
  listProviderQuotas,
  parseDeepSeekQuota,
  parseKimiCodeQuota,
  parseMiniMaxQuota,
  parseMoonshotQuota,
  parseOpenAiQuota,
  parseOpenRouterQuota,
  parseZaiQuota
} from './provider-quota'
import {
  decodeAntigravityUnifiedOAuth,
  parseClaudeSubscriptionQuota,
  parseCodexSubscriptionQuota,
  parseCursorSubscriptionQuota,
  parseGrokSubscriptionQuota,
  parseGoogleCodeAssistQuota
} from './provider-subscription-quota'

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

function subscriptionProvider(
  id: string,
  kind: 'agent-sdk' | 'cursor-sdk' | 'antigravity-cli' | 'gemini-cli-api' | 'http'
): ModelProviderProfileV1 {
  return {
    ...provider(id, id, id === 'codex'
      ? 'https://chatgpt.com/backend-api/codex/responses'
      : id === 'claude-subscription'
        ? 'https://api.anthropic.com'
        : '', '', id),
    kind,
    endpointFormat: 'custom_endpoint'
  }
}

function grokBillingFrame(
  usedPercent: number,
  resetEpoch: number
): Uint8Array<ArrayBuffer> {
  const float = Buffer.alloc(4)
  float.writeFloatLE(usedPercent)
  const varint: number[] = []
  let remaining = resetEpoch
  do {
    const next = remaining % 128
    remaining = Math.floor(remaining / 128)
    varint.push(next | (remaining > 0 ? 0x80 : 0))
  } while (remaining > 0)
  const payload = Buffer.concat([
    Buffer.from([0x0d]),
    float,
    Buffer.from([0x10, ...varint])
  ])
  const frame = Buffer.alloc(5 + payload.length)
  frame.writeUInt32BE(payload.length, 1)
  payload.copy(frame, 5)
  const output = new Uint8Array(frame.length)
  output.set(frame)
  return output
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

  it('normalizes Kimi Code weekly and five-hour request quotas', () => {
    expect(parseKimiCodeQuota({
      usage: {
        limit: '2048',
        used: '375',
        remaining: '1673',
        resetTime: '2027-01-09T15:23:13.373329235Z'
      },
      limits: [{
        window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' },
        detail: {
          limit: '200',
          remaining: '181',
          reset_at: '2027-01-06T15:05:24.374187075Z'
        }
      }]
    })).toEqual([
      {
        id: 'weekly',
        label: 'Weekly request quota',
        unit: 'requests',
        used: 375,
        limit: 2048,
        remaining: 1673,
        usedPercent: 18.310546875,
        resetsAt: '2027-01-09T15:23:13.373Z'
      },
      {
        id: 'rate-limit-0',
        label: '5-hour rate limit',
        unit: 'requests',
        used: 19,
        limit: 200,
        remaining: 181,
        usedPercent: 9.5,
        resetsAt: '2027-01-06T15:05:24.374Z'
      }
    ])
  })

  it('normalizes Grok gRPC-web billing frames', () => {
    expect(parseGrokSubscriptionQuota(
      grokBillingFrame(42.5, 1_900_000_000),
      new Date('2027-01-01T00:00:00Z')
    )).toEqual([{
      id: 'credits',
      label: 'Credits usage',
      unit: 'percent',
      usedPercent: 42.5,
      resetsAt: '2030-03-17T17:46:40.000Z'
    }])
  })

  it('normalizes Claude and Codex subscription usage windows', () => {
    expect(parseClaudeSubscriptionQuota({
      five_hour: { utilization: 35, resets_at: '2027-01-15T09:00:00Z' },
      seven_day: { utilization: 20, resets_at: '2027-01-20T09:00:00Z' }
    })).toEqual([
      {
        id: 'five-hour',
        label: '5-hour usage',
        unit: 'percent',
        usedPercent: 35,
        resetsAt: '2027-01-15T09:00:00.000Z'
      },
      {
        id: 'seven-day',
        label: '7-day usage',
        unit: 'percent',
        usedPercent: 20,
        resetsAt: '2027-01-20T09:00:00.000Z'
      }
    ])

    expect(parseCodexSubscriptionQuota({
      plan_type: 'plus',
      rate_limit: {
        primary_window: {
          used_percent: 45,
          reset_at: 1_800_000_000,
          limit_window_seconds: 18_000
        },
        secondary_window: {
          used_percent: 12,
          reset_at: 1_800_086_400,
          limit_window_seconds: 604_800
        }
      },
      additional_rate_limits: [{
        limit_name: 'codex_spark',
        rate_limit: {
          primary_window: {
            used_percent: 7,
            reset_at: 1_800_172_800,
            limit_window_seconds: 604_800
          }
        }
      }]
    })).toMatchObject({
      summary: 'plus',
      metrics: [
        { id: 'primary', label: '5-hour usage', usedPercent: 45 },
        { id: 'secondary', label: '1-week usage', usedPercent: 12 },
        {
          id: 'additional-0-primary',
          label: 'Spark - 1-week usage',
          usedPercent: 7
        }
      ]
    })
  })

  it('normalizes Cursor and Google subscription allowances', () => {
    expect(parseCursorSubscriptionQuota({
      billingCycleEnd: '2027-02-01T00:00:00Z',
      membershipType: 'pro',
      individualUsage: {
        plan: {
          enabled: true,
          used: 750,
          limit: 2_000,
          remaining: 1_250,
          totalPercentUsed: 37.5
        },
        onDemand: { enabled: true, used: 125, limit: 1_000, remaining: 875 }
      }
    })).toMatchObject({
      summary: 'pro',
      metrics: [
        {
          id: 'included-plan',
          unit: 'USD',
          used: 7.5,
          limit: 20,
          remaining: 12.5,
          usedPercent: 37.5
        },
        {
          id: 'on-demand',
          used: 1.25,
          limit: 10,
          remaining: 8.75
        }
      ]
    })

    expect(parseGoogleCodeAssistQuota({
      buckets: [{
        modelId: 'gemini-pro',
        remainingFraction: 0.65,
        resetTime: '2027-01-16T00:00:00Z'
      }]
    })).toEqual([{
      id: 'bucket-0',
      label: 'gemini-pro',
      unit: 'percent',
      usedPercent: 35,
      resetsAt: '2027-01-16T00:00:00.000Z'
    }])
  })

  it('decodes the official Antigravity unified OAuth protobuf without exposing it', () => {
    const field = (number: number, value: string | Buffer): Buffer => {
      const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value)
      const varint = (input: number): Buffer => {
        const output: number[] = []
        let remaining = input
        do {
          const byte = remaining & 0x7f
          remaining = Math.floor(remaining / 128)
          output.push(remaining ? byte | 0x80 : byte)
        } while (remaining)
        return Buffer.from(output)
      }
      return Buffer.concat([varint((number << 3) | 2), varint(bytes.length), bytes])
    }
    const tokenInfo = Buffer.concat([
      field(1, 'ya29.test-access-token'),
      field(3, '1//test-refresh-token')
    ]).toString('base64')
    const wrapper = field(1, tokenInfo)
    const entry = Buffer.concat([
      field(1, 'oauthTokenInfoSentinelKey'),
      field(2, wrapper)
    ])
    const encoded = field(1, entry).toString('base64')

    expect(decodeAntigravityUnifiedOAuth(encoded)).toEqual({
      accessToken: 'ya29.test-access-token',
      refreshToken: '1//test-refresh-token'
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

  it('recognizes subscription probes only by their stable preset identity and expected kind', () => {
    expect(classifyProviderQuotaProbe(
      subscriptionProvider('claude-subscription', 'agent-sdk')
    )?.kind).toBe('claude-subscription')
    expect(classifyProviderQuotaProbe(
      subscriptionProvider('codex', 'http')
    )?.kind).toBe('codex-subscription')
    expect(classifyProviderQuotaProbe(provider(
      'opencode-go',
      'OpenCode Go',
      'https://opencode.ai/zen/go/v1',
      '',
      'opencode-go'
    ))?.kind).toBe('opencode-go-local')
    expect(classifyProviderQuotaProbe(
      provider(
        'codex',
        'ChatGPT subscription',
        'https://chatgpt.com/backend-api/codex/responses',
        '',
        'codex'
      )
    )?.kind).toBe('codex-subscription')
    expect(classifyProviderQuotaProbe(
      provider(
        'grok-subscription',
        'Grok subscription',
        'https://cli-chat-proxy.grok.com/v1',
        '',
        'grok-subscription'
      )
    )?.kind).toBe('grok-subscription')
    expect(classifyProviderQuotaProbe(
      provider(
        'kimi-code',
        'Kimi Code',
        'https://api.kimi.com/coding/v1',
        'kimi-key',
        'kimi-code'
      )
    )?.kind).toBe('kimi-code')
    expect(classifyProviderQuotaProbe(
      subscriptionProvider('cursor-subscription', 'cursor-sdk')
    )?.kind).toBe('cursor-subscription')
    expect(classifyProviderQuotaProbe(
      subscriptionProvider('gemini-subscription', 'antigravity-cli')
    )?.kind).toBe('antigravity-subscription')
    expect(classifyProviderQuotaProbe(
      subscriptionProvider('gemini-subscription-2', 'antigravity-cli')
    )?.kind).toBe('antigravity-subscription')
    expect(classifyProviderQuotaProbe({
      ...subscriptionProvider('claude-subscription', 'agent-sdk'),
      kind: 'http'
    })).toBeNull()
    expect(classifyProviderQuotaProbe({
      ...subscriptionProvider('codex', 'http'),
      kind: 'agent-sdk'
    })).toBeNull()
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

  it('uses existing subscription login state and fixed read-only endpoints', async () => {
    const fetcher = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const requestUrl = url.toString()
      const headers = new Headers(init?.headers)
      if (requestUrl.endsWith('/api/oauth/usage')) {
        expect(headers.get('authorization')).toBe('Bearer claude-secret')
        expect(headers.get('anthropic-beta')).toBe('oauth-2025-04-20')
        return new Response(JSON.stringify({
          five_hour: { utilization: 10, resets_at: '2027-01-15T10:00:00Z' }
        }))
      }
      if (requestUrl.endsWith('/wham/usage')) {
        expect(headers.get('authorization')).toBe('Bearer codex-secret')
        expect(headers.get('chatgpt-account-id')).toBe('acct-test')
        return new Response(JSON.stringify({
          plan_type: 'plus',
          rate_limit: {
            primary_window: {
              used_percent: 20,
              reset_at: 1_800_000_000,
              limit_window_seconds: 18_000
            }
          }
        }))
      }
      if (requestUrl.endsWith('/api/usage-summary')) {
        expect(headers.get('cookie')).toBe('WorkosCursorSessionToken=session-secret')
        return new Response(JSON.stringify({
          membershipType: 'pro',
          individualUsage: {
            plan: { enabled: true, used: 100, limit: 2_000, remaining: 1_900 }
          }
        }))
      }
      if (requestUrl.endsWith(':loadCodeAssist')) {
        expect(headers.get('authorization')).toBe('Bearer google-secret')
        return new Response(JSON.stringify({
          currentTier: { id: 'standard-tier', name: 'standard' },
          cloudaicompanionProject: 'project-test'
        }))
      }
      if (requestUrl.endsWith(':retrieveUserQuota')) {
        return new Response(JSON.stringify({
          buckets: [{ modelId: 'gemini-pro', remainingFraction: 0.8 }]
        }))
      }
      throw new Error(`Unexpected URL: ${requestUrl}`)
    })
    const result = await listProviderQuotas(settings([
      subscriptionProvider('claude-subscription', 'agent-sdk'),
      subscriptionProvider('codex', 'http'),
      subscriptionProvider('cursor-subscription', 'cursor-sdk'),
      subscriptionProvider('gemini-subscription', 'antigravity-cli')
    ]), fetcher, {
      resolveClaudeToken: async () => 'claude-secret',
      resolveCodexCredential: async () => ({
        accessToken: 'codex-secret',
        accountId: 'acct-test'
      }),
      resolveCursorSession: async () => ({
        cookieHeader: 'WorkosCursorSessionToken=session-secret'
      }),
      resolveAntigravityCredential: async () => ({
        accessToken: 'google-secret',
        accountEmail: 'account@example.test'
      })
    })

    expect(result.entries
      .filter((entry) => entry.providerId !== 'deepseek')
      .map((entry) => [entry.providerId, entry.status])).toEqual([
      ['claude-subscription', 'available'],
      ['codex', 'available'],
      ['cursor-subscription', 'available'],
      ['gemini-subscription', 'available']
    ])
    expect(JSON.stringify(result)).not.toMatch(/claude-secret|codex-secret|session-secret|google-secret/)
  })

  it('queries ChatGPT, Kimi Code, and Grok presets that omit an explicit HTTP kind', async () => {
    const fetcher = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const requestUrl = url.toString()
      const headers = new Headers(init?.headers)
      if (requestUrl.endsWith('/wham/usage')) {
        expect(headers.get('authorization')).toBe('Bearer codex-secret')
        return new Response(JSON.stringify({
          plan_type: 'pro',
          rate_limit: {
            primary_window: {
              used_percent: 15,
              reset_at: 1_900_000_000,
              limit_window_seconds: 18_000
            }
          }
        }))
      }
      if (requestUrl.endsWith('/coding/v1/usages')) {
        expect(headers.get('authorization')).toBe('Bearer kimi-secret')
        return new Response(JSON.stringify({
          usage: { limit: '1000', used: '250', remaining: '750' },
          limits: []
        }))
      }
      if (requestUrl.includes('GetGrokCreditsConfig')) {
        expect(headers.get('authorization')).toBe('Bearer grok-secret')
        expect(headers.get('content-type')).toBe('application/grpc-web+proto')
        expect(Array.from(init?.body as Uint8Array)).toEqual([0, 0, 0, 0, 0])
        return new Response(grokBillingFrame(32, 1_900_000_000), {
          headers: { 'Content-Type': 'application/grpc-web+proto' }
        })
      }
      throw new Error(`Unexpected URL: ${requestUrl}`)
    })
    const result = await listProviderQuotas(settings([
      provider(
        'codex',
        'ChatGPT subscription',
        'https://chatgpt.com/backend-api/codex/responses',
        '',
        'codex'
      ),
      provider(
        'kimi-code',
        'Kimi Code',
        'https://api.kimi.com/coding/v1',
        'kimi-secret',
        'kimi-code'
      ),
      provider(
        'grok-subscription',
        'Grok subscription',
        'https://cli-chat-proxy.grok.com/v1',
        '',
        'grok-subscription'
      )
    ]), fetcher, {
      resolveCodexCredential: async () => ({ accessToken: 'codex-secret' }),
      resolveGrokCredential: async () => ({
        accessToken: 'grok-secret',
        email: 'grok@example.test'
      })
    })

    expect(result.entries
      .filter((entry) => [
        'codex',
        'kimi-code',
        'grok-subscription'
      ].includes(entry.providerId))
      .map((entry) => [
        entry.providerId,
        entry.status,
        entry.metrics[0]?.usedPercent
      ])).toEqual([
      ['codex', 'available', 15],
      ['kimi-code', 'available', 25],
      ['grok-subscription', 'available', 32]
    ])
    expect(JSON.stringify(result)).not.toMatch(/codex-secret|kimi-secret|grok-secret/)
  })

  it('refreshes an expired configured Codex login before querying quota', async () => {
    const refreshFetch = vi.fn(async (url: string | URL) => {
      expect(String(url)).toBe('https://auth.openai.com/oauth/token')
      return Response.json({
        access_token: 'codex-refreshed-access',
        refresh_token: 'codex-refreshed-refresh',
        expires_in: 3_600
      })
    })
    vi.stubGlobal('fetch', refreshFetch)
    const fetcher = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      expect(headers.get('authorization')).toBe('Bearer codex-refreshed-access')
      expect(headers.get('chatgpt-account-id')).toBe('acct-refresh')
      expect(headers.get('user-agent')).toMatch(/^codex_cli_rs\//)
      return Response.json({
        plan_type: 'plus',
        rate_limit: {
          primary_window: {
            used_percent: 21,
            reset_at: 1_900_000_000,
            limit_window_seconds: 18_000
          }
        }
      })
    })

    try {
      const codex = subscriptionProvider('codex', 'http')
      codex.apiKey = JSON.stringify({
        kind: 'codex-oauth',
        accessToken: 'codex-expired-access',
        refreshToken: 'codex-expired-refresh',
        expiresAt: Date.now() - 60_000,
        accountId: 'acct-refresh'
      })
      const result = await listProviderQuotas(settings([codex]), fetcher)

      expect(result.entries.find((entry) => entry.providerId === 'codex')).toMatchObject({
        providerId: 'codex',
        status: 'available',
        metrics: [expect.objectContaining({ id: 'primary', usedPercent: 21 })]
      })
      expect(refreshFetch).toHaveBeenCalledTimes(1)
      expect(fetcher).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('refreshes and retries once when Codex rejects a current access token', async () => {
    const resolveCodexCredential = vi.fn(async (
      _provider: ModelProviderProfileV1,
      rejectedAccessToken?: string
    ) => rejectedAccessToken
      ? { accessToken: 'codex-retry-access', accountId: 'acct-retry' }
      : { accessToken: 'codex-rejected-access', accountId: 'acct-retry' })
    const fetcher = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const authorization = new Headers(init?.headers).get('authorization')
      if (authorization === 'Bearer codex-rejected-access') {
        return new Response('expired', { status: 401 })
      }
      expect(authorization).toBe('Bearer codex-retry-access')
      return Response.json({
        plan_type: 'pro',
        rate_limit: {
          primary_window: {
            used_percent: 7,
            reset_at: 1_900_000_000,
            limit_window_seconds: 18_000
          }
        }
      })
    })

    const result = await listProviderQuotas(settings([
      subscriptionProvider('codex', 'http')
    ]), fetcher, { resolveCodexCredential })

    expect(result.entries.find((entry) => entry.providerId === 'codex')).toMatchObject({
      providerId: 'codex',
      status: 'available',
      metrics: [expect.objectContaining({ id: 'primary', usedPercent: 7 })]
    })
    expect(resolveCodexCredential).toHaveBeenNthCalledWith(2, expect.anything(), 'codex-rejected-access')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('refreshes and retries once when Grok rejects a current access token', async () => {
    const resolveGrokCredential = vi.fn(async (
      _provider: ModelProviderProfileV1,
      rejectedAccessToken?: string
    ) => rejectedAccessToken
      ? { accessToken: 'grok-retry-access' }
      : { accessToken: 'grok-rejected-access' })
    const fetcher = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const authorization = new Headers(init?.headers).get('authorization')
      if (authorization === 'Bearer grok-rejected-access') {
        return new Response('expired', { status: 401 })
      }
      expect(authorization).toBe('Bearer grok-retry-access')
      return new Response(grokBillingFrame(18, 1_900_000_000), {
        headers: { 'Content-Type': 'application/grpc-web+proto' }
      })
    })

    const result = await listProviderQuotas(settings([
      subscriptionProvider('grok-subscription', 'http')
    ]), fetcher, { resolveGrokCredential })

    expect(result.entries.find((entry) => entry.providerId === 'grok-subscription')).toMatchObject({
      status: 'available',
      metrics: [expect.objectContaining({ id: 'credits', usedPercent: 18 })]
    })
    expect(resolveGrokCredential).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      'grok-rejected-access'
    )
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('reports the Gemini CLI migration reason instead of a generic authorization error', async () => {
    const fetcher = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toContain(':loadCodeAssist')
      const headers = new Headers(init?.headers)
      expect(headers.get('user-agent')).toBe('google-gemini-cli')
      expect(JSON.parse(String(init?.body))).toMatchObject({
        metadata: { ideType: 'IDE_UNSPECIFIED', pluginType: 'GEMINI' }
      })
      return Response.json({
        allowedTiers: [{ id: 'standard-tier' }],
        ineligibleTiers: [{
          reasonMessage: 'This client is no longer supported. Migrate to Antigravity.'
        }]
      })
    })

    const result = await listProviderQuotas(settings([
      subscriptionProvider('gemini-cli-subscription', 'gemini-cli-api')
    ]), fetcher, {
      resolveGeminiCliToken: async () => 'gemini-cli-access'
    })

    expect(result.entries.find((entry) => entry.providerId === 'gemini-cli-subscription')).toMatchObject({
      status: 'error',
      message: 'This client is no longer supported. Migrate to Antigravity.'
    })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('reports a missing subscription login without making a request', async () => {
    const fetcher = vi.fn()
    const result = await listProviderQuotas(settings([
      subscriptionProvider('claude-subscription', 'agent-sdk')
    ]), fetcher, {
      resolveClaudeToken: async () => undefined
    })
    expect(result.entries.find((entry) => entry.providerId === 'claude-subscription')).toMatchObject({
      providerId: 'claude-subscription',
      status: 'missing_credentials'
    })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('reads OpenCode Go local usage without requiring an API key or network request', async () => {
    const fetcher = vi.fn()
    const result = await listProviderQuotas(settings([
      provider(
        'opencode-go',
        'OpenCode Go',
        'https://opencode.ai/zen/go/v1',
        '',
        'opencode-go'
      )
    ]), fetcher, {
      resolveOpenCodeGoCookie: async () => undefined,
      resolveOpenCodeGoQuota: async () => ({
        summary: 'Local estimate · $12 / $30 / $60 plan limits',
        metrics: [{
          id: 'weekly',
          label: 'Weekly usage',
          unit: 'USD',
          used: 9,
          limit: 30,
          remaining: 21,
          usedPercent: 30
        }]
      })
    })

    expect(result.entries.find((entry) => entry.providerId === 'opencode-go')).toMatchObject({
      providerId: 'opencode-go',
      status: 'available',
      source: 'OpenCode Go local usage estimate',
      summary: 'Local estimate · $12 / $30 / $60 plan limits',
      metrics: [expect.objectContaining({ id: 'weekly', usedPercent: 30 })]
    })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('explains when OpenCode Go has no local usage history yet', async () => {
    const result = await listProviderQuotas(settings([
      provider(
        'opencode-go',
        'OpenCode Go',
        'https://opencode.ai/zen/go/v1',
        '',
        'opencode-go'
      )
    ]), vi.fn(), {
      resolveOpenCodeGoCookie: async () => undefined,
      resolveOpenCodeGoQuota: async () => undefined
    })

    expect(result.entries.find((entry) => entry.providerId === 'opencode-go')).toMatchObject({
      status: 'missing_credentials',
      message: 'Sign in to opencode.ai in your browser, or use OpenCode Go locally first so its usage history exists.'
    })
  })
})
