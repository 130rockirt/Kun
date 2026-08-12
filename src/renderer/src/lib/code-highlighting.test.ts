import { afterEach, describe, expect, it } from 'vitest'
import {
  clearHighlightCodeCache,
  extensionForLanguage,
  hasCachedHighlightCode,
  highlightCodeCacheSize,
  highlightCodeHtml,
  languageFromFilePath,
  MAX_HIGHLIGHT_CACHE_ENTRIES
} from './code-highlighting'

describe('code highlighting languages', () => {
  it('maps PowerShell workspace files to the bundled grammar', () => {
    expect(languageFromFilePath('/repo/install.ps1')).toBe('powershell')
    expect(languageFromFilePath('Profile.PSM1')).toBe('powershell')
    expect(languageFromFilePath('Module.psd1')).toBe('powershell')
    expect(extensionForLanguage('powershell')).toBe('ps1')
  })

  it('maps Work preview extensions to available bundled grammars', () => {
    expect(languageFromFilePath('/repo/page.astro')).toBe('astro')
    expect(languageFromFilePath('/repo/report.csv')).toBe('csv')
    expect(languageFromFilePath('/repo/settings.env')).toBe('dotenv')
    expect(languageFromFilePath('/repo/index.htm')).toBe('html')
    expect(languageFromFilePath('/repo/icon.svg')).toBe('xml')
    expect(languageFromFilePath('/repo/component.svelte')).toBe('svelte')
    expect(languageFromFilePath('/repo/Gemfile')).toBe('ruby')
    expect(languageFromFilePath('/repo/Justfile')).toBe('just')
    expect(languageFromFilePath('/repo/types.d.mts')).toBe('ts')
    expect(languageFromFilePath('/repo/stubs.pyi')).toBe('python')
    expect(languageFromFilePath('/repo/Dockerfile.dev')).toBe('dockerfile')
    expect(languageFromFilePath('/repo/.env.local')).toBe('dotenv')
  })
})

describe('code highlighting cache', () => {
  afterEach(() => {
    clearHighlightCodeCache()
  })

  it('caps cached highlighted blocks', async () => {
    for (let index = 0; index < MAX_HIGHLIGHT_CACHE_ENTRIES + 5; index += 1) {
      await highlightCodeHtml(`line-${index}`, 'text')
    }

    expect(highlightCodeCacheSize()).toBe(MAX_HIGHLIGHT_CACHE_ENTRIES)
    expect(hasCachedHighlightCode('line-0', 'text')).toBe(false)
    expect(hasCachedHighlightCode('line-4', 'text')).toBe(false)
    expect(hasCachedHighlightCode('line-5', 'text')).toBe(true)
  })

  it('refreshes cache entries when they are reused', async () => {
    await highlightCodeHtml('line-0', 'text')
    for (let index = 1; index < MAX_HIGHLIGHT_CACHE_ENTRIES; index += 1) {
      await highlightCodeHtml(`line-${index}`, 'text')
    }

    await highlightCodeHtml('line-0', 'text')
    await highlightCodeHtml(`line-${MAX_HIGHLIGHT_CACHE_ENTRIES}`, 'text')

    expect(highlightCodeCacheSize()).toBe(MAX_HIGHLIGHT_CACHE_ENTRIES)
    expect(hasCachedHighlightCode('line-1', 'text')).toBe(false)
    expect(hasCachedHighlightCode('line-0', 'text')).toBe(true)
  })
})
