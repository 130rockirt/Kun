import { afterEach, describe, expect, it } from 'vitest'
import { APP_LOCALES, type AppLocale } from '@shared/app-locales'
import i18n from '../i18n'
import enCommon from './en/common.json'
import enSettings from './en/settings.json'
import hiCommon from './hi/common.json'
import hiSettings from './hi/settings.json'
import jaCommon from './ja/common.json'
import jaSettings from './ja/settings.json'
import koCommon from './ko/common.json'
import koSettings from './ko/settings.json'
import ruCommon from './ru/common.json'
import ruSettings from './ru/settings.json'
import thCommon from './th/common.json'
import thSettings from './th/settings.json'
import zhCommon from './zh/common.json'
import zhSettings from './zh/settings.json'

type LocaleTree = Record<string, unknown>

const resources: Record<AppLocale, { common: LocaleTree; settings: LocaleTree }> = {
  en: { common: enCommon, settings: enSettings },
  zh: { common: zhCommon, settings: zhSettings },
  ru: { common: ruCommon, settings: ruSettings },
  hi: { common: hiCommon, settings: hiSettings },
  th: { common: thCommon, settings: thSettings },
  ja: { common: jaCommon, settings: jaSettings },
  ko: { common: koCommon, settings: koSettings }
}

function flattenStrings(
  tree: LocaleTree,
  prefix = '',
  result = new Map<string, string>()
): Map<string, string> {
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (typeof value === 'string') result.set(path, value)
    else if (value && typeof value === 'object' && !Array.isArray(value)) {
      flattenStrings(value as LocaleTree, path, result)
    } else {
      throw new Error(`locale value must be a string or object: ${path}`)
    }
  }
  return result
}

function interpolationTokens(value: string): string[] {
  return Array.from(value.matchAll(/{{\s*([^,}\s]+)[^}]*}}/g), (match) => match[1]).sort()
}

describe('active locale resources', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en')
  })

  it('registers every persisted application locale', () => {
    expect(Object.keys(resources)).toEqual([...APP_LOCALES])
    for (const locale of APP_LOCALES) {
      expect(i18n.hasResourceBundle(locale, 'common')).toBe(true)
      expect(i18n.hasResourceBundle(locale, 'settings')).toBe(true)
    }
  })

  it.each(['ru', 'hi', 'th', 'ja', 'ko'] as const)(
    'keeps the %s locale complete and interpolation-safe',
    (locale) => {
      for (const namespace of ['common', 'settings'] as const) {
        const source = flattenStrings(resources.en[namespace])
        const translated = flattenStrings(resources[locale][namespace])
        expect([...translated.keys()], namespace).toEqual([...source.keys()])
        for (const [key, sourceValue] of source) {
          const translatedValue = translated.get(key)
          expect(translatedValue, `${namespace}:${key}`).toBeTruthy()
          expect(interpolationTokens(translatedValue ?? ''), `${namespace}:${key}`)
            .toEqual(interpolationTokens(sourceValue))
        }
      }
    }
  )

  it.each(APP_LOCALES)('can switch i18next to %s without falling back to another locale', async (locale) => {
    await i18n.changeLanguage(locale)
    expect(i18n.resolvedLanguage).toBe(locale)
    expect(i18n.t('settings:language')).toBe(resources[locale].settings.language)
  })
})
