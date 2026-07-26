import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import enCommon from './locales/en/common.json'
import enSettings from './locales/en/settings.json'
import hiCommon from './locales/hi/common.json'
import hiSettings from './locales/hi/settings.json'
import jaCommon from './locales/ja/common.json'
import jaSettings from './locales/ja/settings.json'
import koCommon from './locales/ko/common.json'
import koSettings from './locales/ko/settings.json'
import ruCommon from './locales/ru/common.json'
import ruSettings from './locales/ru/settings.json'
import thCommon from './locales/th/common.json'
import thSettings from './locales/th/settings.json'
import zhCommon from './locales/zh/common.json'
import zhSettings from './locales/zh/settings.json'
import { APP_LOCALES } from '@shared/app-locales'

const englishGraphResources = Object.fromEntries(
  Object.entries(enCommon).filter(([key]) =>
    key.startsWith('graph') || key === 'rightPanelGraph')
)
const englishGraphSettingsResources = Object.fromEntries(
  Object.entries(enSettings).filter(([key]) => key.startsWith('graphSettings'))
)

/**
 * Graph Mode launches with complete English and Chinese copy. Other active
 * locales receive an explicit English Graph bundle so controls never render
 * raw translation keys while native translations can be added incrementally.
 */
export function withGraphCommonFallback<T extends Record<string, unknown>>(locale: T): T {
  return {
    ...locale,
    ...Object.fromEntries(
      Object.entries(englishGraphResources).filter(([key]) => !(key in locale))
    )
  } as T
}

export function withGraphSettingsFallback<T extends Record<string, unknown>>(locale: T): T {
  return {
    ...locale,
    ...Object.fromEntries(
      Object.entries(englishGraphSettingsResources).filter(([key]) => !(key in locale))
    )
  } as T
}

void i18n.use(initReactI18next).init({
  resources: {
    en: { common: enCommon, settings: enSettings },
    zh: { common: zhCommon, settings: zhSettings },
    ru: {
      common: withGraphCommonFallback(ruCommon),
      settings: withGraphSettingsFallback(ruSettings)
    },
    hi: {
      common: withGraphCommonFallback(hiCommon),
      settings: withGraphSettingsFallback(hiSettings)
    },
    th: {
      common: withGraphCommonFallback(thCommon),
      settings: withGraphSettingsFallback(thSettings)
    },
    ja: {
      common: withGraphCommonFallback(jaCommon),
      settings: withGraphSettingsFallback(jaSettings)
    },
    ko: {
      common: withGraphCommonFallback(koCommon),
      settings: withGraphSettingsFallback(koSettings)
    }
  },
  lng: 'en',
  fallbackLng: 'en',
  supportedLngs: APP_LOCALES,
  load: 'languageOnly',
  interpolation: { escapeValue: false },
  defaultNS: 'common',
  ns: ['common', 'settings']
})

export default i18n
