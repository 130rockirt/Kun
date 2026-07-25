import { describe, expect, it, vi } from 'vitest'
import type { KunSpeechToTextSettingsV1 } from '../../shared/app-settings'
import {
  speechTranscriptionPrompt,
  transcribeViaGeminiCliAudio
} from './gemini-cli-speech-to-text-service'

const SPEECH_SETTINGS: KunSpeechToTextSettingsV1 = {
  enabled: true,
  providerId: 'gemini-cli-subscription',
  protocol: 'gemini-cli-audio',
  baseUrl: '',
  apiKey: '',
  model: 'gemini-2.5-flash',
  localWhisperDownloadSource: 'huggingface',
  language: 'zh',
  timeoutMs: 30_000
}

describe('Gemini CLI speech-to-text service', () => {
  it('sends inline audio through the official Code Assist OAuth path', async () => {
    const requests: Array<{
      url: string
      authorization: string
      body: Record<string, unknown>
    }> = []
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(url),
        authorization: new Headers(init?.headers).get('authorization') ?? '',
        body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      })
      if (String(url).endsWith(':loadCodeAssist')) {
        return new Response(JSON.stringify({
          cloudaicompanionProject: 'managed-project'
        }), { status: 200 })
      }
      return new Response(JSON.stringify({
        response: {
          candidates: [{
            content: {
              parts: [
                { text: 'hidden', thought: true },
                { text: ' 你好，世界 ' }
              ]
            }
          }]
        }
      }), { status: 200 })
    }) as unknown as typeof fetch
    const accessToken = vi.fn(async () => 'official-access-token')

    const text = await transcribeViaGeminiCliAudio(
      SPEECH_SETTINGS,
      {
        audioBase64: 'ZmFrZS13YXY=',
        mimeType: 'audio/wav',
        durationMs: 500
      },
      {
        fetchImpl,
        oauthSource: { accessToken },
        endpoint: 'https://code-assist.example.test',
        apiVersion: 'v1internal'
      }
    )

    expect(text).toBe('你好，世界')
    expect(requests.map((request) => request.url)).toEqual([
      'https://code-assist.example.test/v1internal:loadCodeAssist',
      'https://code-assist.example.test/v1internal:generateContent'
    ])
    expect(requests[1].authorization).toBe('Bearer official-access-token')
    expect(requests[1].body).toMatchObject({
      model: 'gemini-2.5-flash',
      project: 'managed-project',
      request: {
        contents: [{
          role: 'user',
          parts: [
            { text: expect.stringContaining('expected language is zh') },
            {
              inlineData: {
                mimeType: 'audio/wav',
                data: 'ZmFrZS13YXY='
              }
            }
          ]
        }]
      }
    })
  })

  it('refreshes a rejected OAuth token once', async () => {
    let setupAttempts = 0
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith(':loadCodeAssist')) {
        setupAttempts += 1
        if (setupAttempts === 1) return new Response('unauthorized', { status: 401 })
        return new Response(JSON.stringify({
          cloudaicompanionProject: 'project'
        }), { status: 200 })
      }
      return new Response(JSON.stringify({
        response: {
          candidates: [{ content: { parts: [{ text: 'recovered' }] } }]
        }
      }), { status: 200 })
    }) as unknown as typeof fetch
    const accessToken = vi.fn(async (rejected?: string) =>
      rejected ? 'fresh-token' : 'expired-token'
    )

    await expect(transcribeViaGeminiCliAudio(
      SPEECH_SETTINGS,
      { audioBase64: 'YXVkaW8=', mimeType: 'audio/wav' },
      {
        fetchImpl,
        oauthSource: { accessToken },
        endpoint: 'https://code-assist.example.test'
      }
    )).resolves.toBe('recovered')

    expect(accessToken).toHaveBeenNthCalledWith(2, 'expired-token')
  })

  it('builds a transcript-only prompt with optional language guidance', () => {
    expect(speechTranscriptionPrompt('')).not.toContain('expected language')
    expect(speechTranscriptionPrompt('en')).toContain('expected language is en')
    expect(speechTranscriptionPrompt('en')).toContain('Return only the transcript')
  })
})
