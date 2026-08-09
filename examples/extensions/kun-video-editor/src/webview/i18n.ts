import type { Locale } from '@kun/extension-api'
import { EN_PRODUCTION } from './i18n-en-production.js'
import { EN_WORKSPACE } from './i18n-en-workspace.js'
import { ZH_PRODUCTION } from './i18n-zh-production.js'
import { ZH_WORKSPACE } from './i18n-zh-workspace.js'

const EN = {
  ...EN_WORKSPACE,
  ...EN_PRODUCTION
} as const

const ZH = {
  ...ZH_WORKSPACE,
  ...ZH_PRODUCTION
} satisfies Record<keyof typeof EN, string>

export type MessageKey = keyof typeof EN
export type Messages = Record<MessageKey, string>

export function formatMessage(
  message: string,
  values: Readonly<Record<string, string | number>> = {}
): string {
  return message.replace(/\{([^}]+)\}/g, (match, key: string) => {
    const value = values[key]
    return value === undefined ? match : String(value)
  })
}

export function messagesFor(locale?: Locale): Messages {
  const base: Messages = locale?.language.toLowerCase().startsWith('zh') ? { ...ZH } : { ...EN }
  for (const key of Object.keys(base) as MessageKey[]) {
    const override = locale?.messages[`kun-video-editor.${key}`]
    if (override) base[key] = override
  }
  return base
}
