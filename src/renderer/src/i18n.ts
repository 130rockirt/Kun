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

void i18n.use(initReactI18next).init({
  resources: {
    en: { common: enCommon, settings: enSettings },
    zh: { common: zhCommon, settings: zhSettings },
    ru: { common: ruCommon, settings: ruSettings },
    hi: { common: hiCommon, settings: hiSettings },
    th: { common: thCommon, settings: thSettings },
    ja: { common: jaCommon, settings: jaSettings },
    ko: { common: koCommon, settings: koSettings }
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
