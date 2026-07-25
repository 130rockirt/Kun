import { describe, expect, it, vi } from 'vitest'
import {
  GEMINI_CLI_OAUTH_TOKEN_URL,
  GeminiCliOAuthSource,
  normalizeGeminiCliCredential
} from './gemini-cli-oauth.js'

describe('GeminiCliOAuthSource', () => {
  it('normalizes both legacy file and current keychain credential shapes', () => {
    expect(normalizeGeminiCliCredential({
      access_token: 'legacy-access',
      refresh_token: 'legacy-refresh',
      expiry_date: 123
    })).toEqual({
      accessToken: 'legacy-access',
      refreshToken: 'legacy-refresh',
      expiresAt: 123
    })
    expect(normalizeGeminiCliCredential({
      token: {
        accessToken: 'keychain-access',
        refreshToken: 'keychain-refresh',
        expiresAt: 456,
        tokenType: 'Bearer'
      }
    })).toEqual({
      accessToken: 'keychain-access',
      refreshToken: 'keychain-refresh',
      expiresAt: 456,
      tokenType: 'Bearer'
    })
  })

  it('reuses a fresh official CLI access token without a network call', async () => {
    const fetchImpl = vi.fn()
    const source = new GeminiCliOAuthSource({
      now: () => 1_000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      loadCredential: async () => ({
        accessToken: 'fresh-access',
        refreshToken: 'refresh',
        expiresAt: 100_000
      })
    })

    await expect(source.accessToken()).resolves.toBe('fresh-access')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('refreshes an expired token in memory without exposing the refresh token', async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe(GEMINI_CLI_OAUTH_TOKEN_URL)
      expect(String(init.body)).toContain('refresh_token=official-refresh')
      return new Response(JSON.stringify({
        access_token: 'next-access',
        expires_in: 3600,
        token_type: 'Bearer'
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    })
    const source = new GeminiCliOAuthSource({
      now: () => 10_000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      loadCredential: async () => ({
        accessToken: 'expired-access',
        refreshToken: 'official-refresh',
        expiresAt: 9_000
      })
    })

    await expect(source.accessToken()).resolves.toBe('next-access')
    await expect(source.accessToken()).resolves.toBe('next-access')
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('returns login guidance when the official CLI has no usable credential', async () => {
    const source = new GeminiCliOAuthSource({
      loadCredential: async () => null
    })

    await expect(source.accessToken()).rejects.toThrow(
      'Run `gemini`, choose “Login with Google”'
    )
  })
})
