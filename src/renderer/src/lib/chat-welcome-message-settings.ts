import { useEffect, useState } from 'react'
import {
  normalizeChatWelcomeMessage,
  type AppSettingsV1
} from '@shared/app-settings'
import { SETTINGS_CHANGED_EVENT } from './keyboard-shortcut-settings'

export function useChatWelcomeMessageSetting(): string {
  const [welcomeMessage, setWelcomeMessage] = useState('')

  useEffect(() => {
    let cancelled = false
    const apply = (settings: AppSettingsV1): void => {
      if (!cancelled) setWelcomeMessage(normalizeChatWelcomeMessage(settings.chatWelcomeMessage))
    }

    if (typeof window.kunGui?.getSettings === 'function') {
      void window.kunGui.getSettings().then(apply).catch(() => undefined)
    }

    const onSettingsChanged = (event: Event): void => {
      apply((event as CustomEvent<AppSettingsV1>).detail)
    }
    window.addEventListener(SETTINGS_CHANGED_EVENT, onSettingsChanged)
    return () => {
      cancelled = true
      window.removeEventListener(SETTINGS_CHANGED_EVENT, onSettingsChanged)
    }
  }, [])

  return welcomeMessage
}
