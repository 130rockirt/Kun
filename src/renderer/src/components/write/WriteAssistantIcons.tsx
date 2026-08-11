import type { ReactElement, SVGProps } from 'react'

type Props = SVGProps<SVGSVGElement>

export function WriteAssistantSparkleIcon({ className = '', ...props }: Props): ReactElement {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className} {...props}>
      <path
        d="M10.2 3.2c.45 3.45 2.25 5.25 5.7 5.7-3.45.45-5.25 2.25-5.7 5.7-.45-3.45-2.25-5.25-5.7-5.7 3.45-.45 5.25-2.25 5.7-5.7Z"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinejoin="round"
      />
      <path
        d="M18.2 12.6c.25 1.9 1.25 2.9 3.15 3.15-1.9.25-2.9 1.25-3.15 3.15-.25-1.9-1.25-2.9-3.15-3.15 1.9-.25 2.9-1.25 3.15-3.15Z"
        stroke="currentColor"
        strokeWidth="1.65"
        strokeLinejoin="round"
      />
      <path d="M18.6 3.2v3.2M17 4.8h3.2" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" />
    </svg>
  )
}

export function WriteAssistantPanelToggleIcon({ className = '', ...props }: Props): ReactElement {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className} {...props}>
      <rect x="2.75" y="3.25" width="18.5" height="17.5" rx="3" stroke="currentColor" strokeWidth="1.55" />
      <path d="M12.1 3.75v16.5" stroke="currentColor" strokeWidth="1.55" opacity=".7" />
      <path
        d="M16.2 6.45c.25 1.85 1.2 2.8 3.05 3.05-1.85.25-2.8 1.2-3.05 3.05-.25-1.85-1.2-2.8-3.05-3.05 1.85-.25 2.8-1.2 3.05-3.05Z"
        className="write-assistant-toggle-sparkle"
        strokeWidth="1.45"
        strokeLinejoin="round"
      />
      <path
        d="M19.1 13.45c.13 1 .65 1.52 1.65 1.65-1 .13-1.52.65-1.65 1.65-.13-1-.65-1.52-1.65-1.65 1-.13 1.52-.65 1.65-1.65Z"
        className="write-assistant-toggle-sparkle"
        strokeWidth="1.25"
        strokeLinejoin="round"
      />
    </svg>
  )
}
