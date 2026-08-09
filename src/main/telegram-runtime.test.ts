import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultClawSettings, type AppSettingsV1, type ClawImChannelV1 } from '../shared/app-settings'
import {
  createTelegramRuntime,
  parseAllowedChatIds,
  sanitizeTelegramTransportError,
  verifyTelegramBotToken
} from './telegram-runtime'

vi.mock('electron', () => ({ net: {} }))
const proxyFetchMock = vi.hoisted(() => vi.fn())
vi.mock('./proxy-fetch', () => ({ fetchWithOptionalProxy: proxyFetchMock }))

beforeEach(() => {
  proxyFetchMock.mockReset()
  proxyFetchMock.mockImplementation((input: string | URL, init?: RequestInit) => fetch(input, init))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function telegramSettings(): AppSettingsV1 {
  const channel: ClawImChannelV1 = {
    id: 'telegram_1',
    provider: 'telegram',
    label: 'Telegram',
    enabled: true,
    model: 'auto',
    threadId: '',
    workspaceRoot: '/tmp/workspace',
    agentProfile: {
      name: 'Kun',
      description: '',
      identity: '',
      personality: '',
      userContext: '',
      replyRules: ''
    },
    platformCredential: {
      kind: 'telegram',
      botToken: `123:${'a'.repeat(35)}`,
      botUsername: 'kun_test_bot',
      allowedChatIds: '',
      createdAt: '2026-07-11T00:00:00.000Z'
    },
    conversations: [],
    createdAt: '2026-07-11T00:00:00.000Z',
    updatedAt: '2026-07-11T00:00:00.000Z'
  }
  return {
    claw: {
      ...defaultClawSettings(),
      enabled: true,
      im: { ...defaultClawSettings().im, enabled: true },
      channels: [channel]
    }
  } as AppSettingsV1
}

describe('Telegram transport adapter', () => {
  it('normalizes the private-chat allowlist without retaining invalid or duplicate ids', () => {
    expect([...parseAllowedChatIds('123, 456 123, -1, nope, 0')]).toEqual([123, 456])
    expect(parseAllowedChatIds('')).toEqual(new Set())
  })

  it('rejects malformed bot tokens before any network request', async () => {
    await expect(verifyTelegramBotToken('not-a-token')).resolves.toEqual({
      ok: false,
      code: 'invalid_format',
      message: 'Invalid token format. Expected "<numeric-id>:<35+ chars>".'
    })
  })

  it('rejects invalid enabled proxies before any network request', async () => {
    await expect(verifyTelegramBotToken(`123:${'a'.repeat(35)}`, {
      enabled: true,
      url: 'ftp://127.0.0.1:21'
    })).resolves.toMatchObject({ ok: false, code: 'invalid_proxy' })
    expect(proxyFetchMock).not.toHaveBeenCalled()
  })

  it('verifies the bot token through the configured explicit proxy', async () => {
    proxyFetchMock.mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      result: { id: 123, username: 'kun_proxy_bot', first_name: 'Kun Proxy' }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    await expect(verifyTelegramBotToken(`123:${'a'.repeat(35)}`, {
      enabled: true,
      url: 'socks5://user:secret@127.0.0.1:1080'
    })).resolves.toMatchObject({ ok: true, botUsername: 'kun_proxy_bot' })
    expect(proxyFetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/getMe'),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
      'socks5://user:secret@127.0.0.1:1080'
    )
  })

  it('redacts Telegram bot tokens and proxy user information from transport errors', () => {
    const sanitized = sanitizeTelegramTransportError(new Error(
      'connect socks5://alice:secret@127.0.0.1:1080 failed for https://api.telegram.org/bot123:token/getMe'
    ))

    expect(sanitized).not.toContain('alice')
    expect(sanitized).not.toContain('secret')
    expect(sanitized).not.toContain('123:token')
    expect(sanitized).toContain('[REDACTED]')
  })

  it('reports disconnected text and file delivery without invoking another channel', async () => {
    const logError = vi.fn()
    const onInbound = vi.fn()
    const runtime = createTelegramRuntime({ store: {} as never, logError, onInbound })

    await expect(runtime.sendMessage('missing', '123', 'hello')).resolves.toEqual({
      ok: false,
      message: 'Telegram channel is not connected.'
    })
    await expect(runtime.sendFile('missing', '123', '/tmp/report.txt')).resolves.toEqual({
      ok: false,
      message: 'Telegram channel is not connected.'
    })
    expect(onInbound).not.toHaveBeenCalled()
    expect(logError).not.toHaveBeenCalled()
  })

  it('aborts polling, awaits inbound work, and cannot restart after stop', async () => {
    let pollCount = 0
    let pollAborted = false
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      pollCount += 1
      if (pollCount === 1) {
        return new Response(JSON.stringify({
          ok: true,
          result: [{
            update_id: 7,
            message: {
              message_id: 8,
              chat: { id: 123, type: 'private' },
              from: { id: 123, first_name: 'Ada' },
              text: 'hello'
            }
          }]
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return await new Promise<Response>((_resolve, reject) => {
        const abort = (): void => {
          pollAborted = true
          reject(new DOMException('aborted', 'AbortError'))
        }
        if (init?.signal?.aborted) abort()
        else init?.signal?.addEventListener('abort', abort, { once: true })
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    let releaseInbound!: () => void
    const onInbound = vi.fn(() => new Promise<void>((resolve) => {
      releaseInbound = resolve
    }))
    const runtime = createTelegramRuntime({ store: {} as never, logError: vi.fn(), onInbound })
    const settings = telegramSettings()
    runtime.sync(settings)

    await vi.waitFor(() => expect(onInbound).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    let stopped = false
    const stopping = runtime.stop().then(() => { stopped = true })
    await Promise.resolve()
    expect(stopped).toBe(false)
    expect(pollAborted).toBe(true)

    releaseInbound()
    await stopping
    expect(stopped).toBe(true)
    expect(runtime.has('telegram_1')).toBe(false)

    runtime.sync(settings)
    await Promise.resolve()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('keeps an equivalent proxy route and restarts the channel when that route changes', async () => {
    proxyFetchMock.mockImplementation(async (_input: string | URL, init?: RequestInit) => {
      return await new Promise<Response>((_resolve, reject) => {
        const abort = (): void => reject(new DOMException('aborted', 'AbortError'))
        if (init?.signal?.aborted) abort()
        else init?.signal?.addEventListener('abort', abort, { once: true })
      })
    })
    const runtime = createTelegramRuntime({ store: {} as never, logError: vi.fn(), onInbound: vi.fn() })
    const settings = telegramSettings()
    const credential = settings.claw.channels[0]?.platformCredential
    if (!credential || credential.kind !== 'telegram') throw new Error('Expected Telegram credential')
    credential.proxy = { enabled: true, url: 'socks5://127.0.0.1:1080' }

    runtime.sync(settings)
    await vi.waitFor(() => expect(proxyFetchMock).toHaveBeenCalledTimes(1))
    expect(proxyFetchMock.mock.calls[0]?.[2]).toBe('socks5://127.0.0.1:1080')

    runtime.sync(settings)
    await Promise.resolve()
    await Promise.resolve()
    expect(proxyFetchMock).toHaveBeenCalledTimes(1)

    credential.proxy = { enabled: true, url: 'http://127.0.0.1:7890' }
    runtime.sync(settings)
    await vi.waitFor(() => expect(proxyFetchMock).toHaveBeenCalledTimes(2))
    expect(proxyFetchMock.mock.calls[1]?.[2]).toBe('http://127.0.0.1:7890')

    await runtime.stop()
    expect(runtime.has('telegram_1')).toBe(false)
  })
})
