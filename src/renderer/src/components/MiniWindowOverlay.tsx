import type { ReactElement } from 'react'
import { useTranslation } from 'react-i18next'

function ExpandIcon(): ReactElement {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <path
        d="M11 2h5v5M16 2l-6.2 6.2M7 16H2v-5M2 16l6.2-6.2"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

// Hover overlay shown while the window is in mini-pane mode. Clicking it (or
// the title-bar mini button) toggles back to the normal window size.
export function MiniWindowOverlay(): ReactElement {
  const { t } = useTranslation('common')
  const restore = (): void => {
    if (typeof window.kunGui?.runDesktopCommand === 'function') {
      void window.kunGui.runDesktopCommand('toggleMini')
    }
  }
  return (
    <button
      type="button"
      className="ds-mini-restore ds-no-drag"
      aria-label={t('miniWindowRestore')}
      title={t('miniWindowRestore')}
      onClick={restore}
    >
      <span className="ds-mini-restore-badge">
        <ExpandIcon />
        <span>{t('miniWindowRestore')}</span>
      </span>
    </button>
  )
}
