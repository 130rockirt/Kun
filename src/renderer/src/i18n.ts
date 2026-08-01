import i18n, { type BackendModule } from 'i18next'
import { initReactI18next } from 'react-i18next'
import enCommon from './locales/en/common.json'
import enConnectors from './locales/en/connectors.json'
import enSettings from './locales/en/settings.json'
import { APP_LOCALES } from '@shared/app-locales'

const englishGraphResources = Object.fromEntries(
  Object.entries(enCommon).filter(([key]) =>
    key.startsWith('graph') || key === 'rightPanelGraph')
)
const englishGraphSettingsResources = Object.fromEntries(
  Object.entries(enSettings).filter(([key]) =>
    key.startsWith('graphSettings') || key.startsWith('storageRelocation')
  )
)

/**
 * Graph Mode launches with complete English and Chinese copy. Other active
 * locales receive an explicit English Graph/Storage bundle so controls never
 * render raw translation keys while native translations can be added incrementally.
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

type LocaleModule = { default: Record<string, unknown> }

const localeLoaders = import.meta.glob<LocaleModule>(
  './locales/{hi,ja,ko,ru,th,zh}/*.json'
)

const lazyLocaleBackend: BackendModule = {
  type: 'backend',
  init() {},
  read(language, namespace, callback) {
    const loader = localeLoaders[`./locales/${language}/${namespace}.json`]
    if (!loader) {
      callback(new Error(`Unsupported locale resource: ${language}/${namespace}`), false)
      return
    }
    void loader().then(({ default: resource }) => {
      callback(
        null,
        namespace === 'common'
          ? withGraphCommonFallback(resource)
          : namespace === 'settings'
            ? withGraphSettingsFallback(resource)
            : resource
      )
    }, (error: unknown) => {
      callback(
        error instanceof Error ? error : new Error(`Failed to load ${language}/${namespace}`),
        false
      )
    })
  }
}

void i18n.use(lazyLocaleBackend).use(initReactI18next).init({
  resources: {
    en: { common: enCommon, connectors: enConnectors, settings: enSettings }
  },
  partialBundledLanguages: true,
  lng: 'en',
  fallbackLng: 'en',
  supportedLngs: APP_LOCALES,
  load: 'languageOnly',
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
  defaultNS: 'common',
  ns: ['common', 'connectors', 'settings']
})

export default i18n
