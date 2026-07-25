import { randomUUID } from 'node:crypto'
import {
  GEMINI_CLI_CODE_ASSIST_API_VERSION,
  GEMINI_CLI_CODE_ASSIST_ENDPOINT
} from '../../../kun/src/adapters/model/gemini-cli-api-model-client.js'
import { GeminiCliOAuthSource } from '../../../kun/src/adapters/model/gemini-cli-oauth.js'
import type { KunSpeechToTextSettingsV1 } from '../../shared/app-settings'
import type { SpeechTranscriptionRequest } from '../../shared/speech-to-text'

type GeminiCliOAuthTokenSource = Pick<GeminiCliOAuthSource, 'accessToken'>

type GeminiCliSpeechOptions = {
  fetchImpl?: typeof fetch
  oauthSource?: GeminiCliOAuthTokenSource
  endpoint?: string
  apiVersion?: string
}

type GeminiCodeAssistPayload = {
  cloudaicompanionProject?: string
  ineligibleTiers?: Array<{ reasonMessage?: string }>
  response?: GeminiGenerateContentResponse
  candidates?: GeminiGenerateContentResponse['candidates']
  error?: {
    code?: number
    status?: string
    message?: string
  }
}

type GeminiGenerateContentResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string
        thought?: boolean
      }>
    }
  }>
}

/**
 * Uses the same OAuth credential and Code Assist request contract as the
 * official Gemini CLI. The credential stays in the OS keychain/CLI store and
 * is never copied into Kun settings.
 */
export async function transcribeViaGeminiCliAudio(
  speechToText: KunSpeechToTextSettingsV1,
  request: SpeechTranscriptionRequest,
  options: GeminiCliSpeechOptions = {}
): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch
  const oauthSource = options.oauthSource ?? new GeminiCliOAuthSource({ fetchImpl })
  const endpoint = (
    options.endpoint ??
    process.env.CODE_ASSIST_ENDPOINT?.trim() ??
    GEMINI_CLI_CODE_ASSIST_ENDPOINT
  ).replace(/\/+$/, '')
  const apiVersion = (
    options.apiVersion ??
    process.env.CODE_ASSIST_API_VERSION?.trim() ??
    GEMINI_CLI_CODE_ASSIST_API_VERSION
  ).replace(/^\/+|\/+$/g, '')
  const signal = AbortSignal.timeout(speechToText.timeoutMs)

  let accessToken = await oauthSource.accessToken()
  let setup = await postGeminiCliJson(
    fetchImpl,
    `${endpoint}/${apiVersion}:loadCodeAssist`,
    accessToken,
    {
      metadata: {
        ideType: 'IDE_UNSPECIFIED',
        platform: 'PLATFORM_UNSPECIFIED',
        pluginType: 'GEMINI'
      }
    },
    signal
  )
  if (setup.status === 401) {
    accessToken = await oauthSource.accessToken(accessToken)
    setup = await postGeminiCliJson(
      fetchImpl,
      `${endpoint}/${apiVersion}:loadCodeAssist`,
      accessToken,
      {
        metadata: {
          ideType: 'IDE_UNSPECIFIED',
          platform: 'PLATFORM_UNSPECIFIED',
          pluginType: 'GEMINI'
        }
      },
      signal
    )
  }
  assertGeminiCliResponse(setup)
  const projectId = setup.payload.cloudaicompanionProject?.trim()
  if (!projectId) {
    const reason = setup.payload.ineligibleTiers
      ?.map((tier) => tier.reasonMessage?.trim())
      .filter(Boolean)
      .join('; ')
    throw new Error(
      reason ||
      'Gemini CLI account setup is incomplete. Run `gemini` once to finish Google subscription onboarding.'
    )
  }

  let generated = await postGeminiCliJson(
    fetchImpl,
    `${endpoint}/${apiVersion}:generateContent`,
    accessToken,
    {
      model: speechToText.model,
      project: projectId,
      user_prompt_id: randomUUID(),
      request: {
        contents: [{
          role: 'user',
          parts: [
            { text: speechTranscriptionPrompt(speechToText.language) },
            {
              inlineData: {
                mimeType: request.mimeType,
                data: request.audioBase64
              }
            }
          ]
        }],
        generationConfig: {
          temperature: 0,
          maxOutputTokens: 2_048
        },
        session_id: randomUUID()
      }
    },
    signal
  )
  if (generated.status === 401) {
    accessToken = await oauthSource.accessToken(accessToken)
    generated = await postGeminiCliJson(
      fetchImpl,
      `${endpoint}/${apiVersion}:generateContent`,
      accessToken,
      {
        model: speechToText.model,
        project: projectId,
        user_prompt_id: randomUUID(),
        request: {
          contents: [{
            role: 'user',
            parts: [
              { text: speechTranscriptionPrompt(speechToText.language) },
              {
                inlineData: {
                  mimeType: request.mimeType,
                  data: request.audioBase64
                }
              }
            ]
          }],
          generationConfig: {
            temperature: 0,
            maxOutputTokens: 2_048
          },
          session_id: randomUUID()
        }
      },
      signal
    )
  }
  assertGeminiCliResponse(generated)
  return geminiResponseText(generated.payload)
}

export function speechTranscriptionPrompt(language: string): string {
  const normalizedLanguage = language.trim()
  const languageInstruction =
    normalizedLanguage && normalizedLanguage !== 'auto'
      ? ` The expected language is ${normalizedLanguage}.`
      : ''
  return [
    'Transcribe the speech in this audio accurately.',
    'Return only the transcript, without commentary, labels, timestamps, or Markdown.',
    languageInstruction
  ].join('').trim()
}

function geminiResponseText(payload: GeminiCodeAssistPayload): string {
  const response = payload.response ?? payload
  const text = response.candidates?.[0]?.content?.parts
    ?.filter((part) => !part.thought && typeof part.text === 'string')
    .map((part) => part.text)
    .join('')
    .trim()
  if (!text) throw new Error('Gemini speech response has no transcript text')
  return text
}

async function postGeminiCliJson(
  fetchImpl: typeof fetch,
  url: string,
  accessToken: string,
  body: Record<string, unknown>,
  signal: AbortSignal
): Promise<{ status: number; ok: boolean; payload: GeminiCodeAssistPayload; rawBody: string }> {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
      'user-agent': 'google-gemini-cli',
      'x-goog-api-client': 'gl-node/kun gemini-cli-audio'
    },
    body: JSON.stringify(body),
    signal
  })
  const rawBody = await response.text()
  let payload: GeminiCodeAssistPayload = {}
  try {
    payload = JSON.parse(rawBody) as GeminiCodeAssistPayload
  } catch {
    if (response.ok) throw new Error('Gemini CLI speech response is not valid JSON')
  }
  return { status: response.status, ok: response.ok, payload, rawBody }
}

function assertGeminiCliResponse(
  result: { status: number; ok: boolean; payload: GeminiCodeAssistPayload; rawBody: string }
): void {
  if (result.ok) return
  const detail =
    result.payload.error?.message?.trim() ||
    result.payload.error?.status?.trim() ||
    result.rawBody.replace(/\s+/g, ' ').trim() ||
    'Unknown provider error'
  throw new Error(`Gemini CLI speech request failed (HTTP ${result.status}): ${detail.slice(0, 1_000)}`)
}
