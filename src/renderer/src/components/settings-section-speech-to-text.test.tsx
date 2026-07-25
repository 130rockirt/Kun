import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import {
  defaultKunRuntimeSettings,
  getModelProviderPreset,
  modelProviderPresetProfile
} from '@shared/app-settings'
import { SpeechToTextSettingsSection } from './settings-section-speech-to-text'

const LABELS: Record<string, string> = {
  speechToText: 'Speech to text',
  speechToTextEnabled: 'Enable speech to text',
  speechToTextEnabledDesc: 'Enable voice input',
  speechToTextProvider: 'Speech provider',
  speechToTextProviderDesc: 'Choose a speech provider',
  speechToTextProviderLocalWhisper: 'Local Whisper',
  speechToTextProviderCustom: 'Custom speech API',
  speechToTextProviderMissingKey: '{{provider}} has no API key',
  speechToTextModel: 'Speech model',
  speechToTextModelDesc: 'Remote speech model',
  speechToTextLanguage: 'Language',
  speechToTextLanguageDesc: 'Language hint',
  speechLanguage_auto: 'Auto',
  speechLanguage_zh: 'Chinese',
  speechLanguage_en: 'English',
  speechLanguage_ja: 'Japanese',
  speechLanguage_ko: 'Korean',
  speechToTextAdvanced: 'Advanced',
  speechToTextAdvancedDesc: 'Advanced speech settings',
  speechToTextTimeout: 'Timeout',
  speechToTextTimeoutDesc: 'Request timeout',
  speechToTextTest: 'Test transcription',
  speechToTextTestDesc: 'Test provider',
  speechToTextTestAction: 'Test',
  modelSelectDefaultOption: 'Default ({{model}})'
}

function t(key: string, values?: Record<string, unknown>): string {
  let text = LABELS[key] ?? key
  for (const [name, value] of Object.entries(values ?? {})) {
    text = text.replace(`{{${name}}}`, String(value))
  }
  return text
}

describe('SpeechToTextSettingsSection', () => {
  it('shows real Grok and Gemini speech transports but hides stale Cursor speech metadata', () => {
    const grok = modelProviderPresetProfile(
      getModelProviderPreset('grok-subscription')!,
      'grok-oauth-json'
    )
    const geminiCli = modelProviderPresetProfile(
      getModelProviderPreset('gemini-cli-subscription')!,
      ''
    )
    const cursor = {
      ...modelProviderPresetProfile(
        getModelProviderPreset('cursor-subscription')!,
        'cursor-key'
      ),
      speech: {
        protocol: 'openai-transcriptions' as const,
        baseUrl: '',
        models: ['gemini-2.5-flash']
      }
    }
    const defaults = defaultKunRuntimeSettings()
    const html = renderToStaticMarkup(createElement(SpeechToTextSettingsSection, {
      ctx: {
        t,
        provider: { providers: [cursor, grok, geminiCli] },
        kun: {
          ...defaults,
          speechToText: {
            ...defaults.speechToText,
            enabled: true,
            providerId: grok.id,
            protocol: 'xai-stt',
            model: 'grok-transcribe'
          }
        },
        selectControlClass: 'select',
        updateKun: vi.fn()
      }
    }))

    expect(html).toContain('Grok 订阅')
    expect(html).toContain('Gemini CLI 订阅（API）')
    expect(html).not.toContain('Cursor 订阅')
    expect(html).toContain('grok-transcribe')
  })

  it('does not demand an API key for Gemini CLI subscription audio', () => {
    const geminiCli = modelProviderPresetProfile(
      getModelProviderPreset('gemini-cli-subscription')!,
      ''
    )
    const defaults = defaultKunRuntimeSettings()
    const html = renderToStaticMarkup(createElement(SpeechToTextSettingsSection, {
      ctx: {
        t,
        provider: { providers: [geminiCli] },
        kun: {
          ...defaults,
          speechToText: {
            ...defaults.speechToText,
            enabled: true,
            providerId: geminiCli.id,
            protocol: 'gemini-cli-audio',
            model: 'gemini-2.5-flash'
          }
        },
        selectControlClass: 'select',
        updateKun: vi.fn()
      }
    }))

    expect(html).not.toContain('has no API key')
    expect(html).toContain('gemini-2.5-flash')
  })
})
