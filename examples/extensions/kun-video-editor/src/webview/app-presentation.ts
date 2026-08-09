import type { CSSProperties } from 'react'
import { formatMessage, type Messages } from './i18n.js'
import type { EditorNotice, EditorState } from './model.js'

const HOST_THEME_TOKEN_VARIABLES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  background: ['--bg', '--app-glow'],
  sidebarBackground: ['--surface-raised', '--surface-soft', '--control', '--control-hover'],
  surface: ['--surface'],
  foreground: ['--text'],
  mutedForeground: ['--muted'],
  border: ['--border', '--border-strong'],
  accent: ['--accent', '--accent-strong'],
  focusRing: ['--focus'],
  success: ['--green'],
  danger: ['--danger']
})


export function syncDocumentPresentation(
  documentRoot: Pick<HTMLElement, 'dataset' | 'dir' | 'lang'> & {
    style?: Pick<CSSStyleDeclaration, 'setProperty' | 'removeProperty'>
  },
  theme: EditorState['theme'],
  locale: EditorState['locale']
): void {
  documentRoot.dataset.theme = theme?.kind ?? 'dark'
  documentRoot.dataset.reducedMotion = theme?.reducedMotion ? 'true' : 'false'
  documentRoot.dataset.zoomFactor = String(theme?.zoomFactor ?? 1)
  documentRoot.lang = locale?.language ?? 'en'
  documentRoot.dir = locale?.direction ?? 'ltr'
  if (documentRoot.style) {
    for (const variables of Object.values(HOST_THEME_TOKEN_VARIABLES)) {
      for (const variable of variables) documentRoot.style.removeProperty(variable)
    }
    for (const [token, value] of Object.entries(theme?.tokens ?? {})) {
      for (const variable of HOST_THEME_TOKEN_VARIABLES[token] ?? []) {
        documentRoot.style.setProperty(variable, value)
      }
    }
    const zoomFactor = Math.min(3, Math.max(0.5, theme?.zoomFactor ?? 1))
    documentRoot.style.setProperty('font-size', `${16 * zoomFactor}px`)
    documentRoot.style.setProperty('color-scheme', themeColorScheme(theme))
  }
}

export function themeStyle(theme: EditorState['theme']): CSSProperties {
  const style: Record<string, string | number> = {
    colorScheme: themeColorScheme(theme)
  }
  for (const [token, value] of Object.entries(theme?.tokens ?? {})) {
    for (const variable of HOST_THEME_TOKEN_VARIABLES[token] ?? []) style[variable] = value
  }
  return style as CSSProperties
}

export function noticeMessage(notice: EditorNotice, messages: Messages): string {
  return notice.messageKey
    ? formatMessage(messages[notice.messageKey], notice.messageValues)
    : notice.message
}

function themeColorScheme(theme: EditorState['theme']): 'light' | 'dark' {
  if (theme?.kind === 'light') return 'light'
  if (theme?.kind === 'dark') return 'dark'
  const background = theme?.tokens.background?.trim().toLowerCase()
  if (background === '#fff' || background === '#ffffff' || background === 'white') return 'light'
  return 'dark'
}
