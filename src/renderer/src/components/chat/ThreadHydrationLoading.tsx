import { useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'

export function ThreadHydrationGate({ loading, presentationKey = null, children }: {
  loading: boolean
  presentationKey?: string | null
  children: ReactNode
}): ReactElement {
  const [revealedKey, setRevealedKey] = useState<string | null>(() =>
    loading ? null : presentationKey
  )
  const committedKeyRef = useRef(presentationKey)
  const waitingForPaint = loading || Boolean(presentationKey && revealedKey !== presentationKey)

  useLayoutEffect(() => {
    const keyChanged = committedKeyRef.current !== presentationKey
    committedKeyRef.current = presentationKey
    if (!presentationKey) return
    if (loading || keyChanged) setRevealedKey(null)
    if (loading) return
    if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
      setRevealedKey(presentationKey)
      return
    }
    let firstFrame: number | null = null
    let secondFrame: number | null = null
    firstFrame = window.requestAnimationFrame(() => {
      firstFrame = null
      secondFrame = window.requestAnimationFrame(() => {
        secondFrame = null
        setRevealedKey(presentationKey)
      })
    })
    return () => {
      if (firstFrame !== null) window.cancelAnimationFrame(firstFrame)
      if (secondFrame !== null) window.cancelAnimationFrame(secondFrame)
    }
  }, [loading, presentationKey])

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        className={`flex min-h-0 flex-1 flex-col ${waitingForPaint ? 'pointer-events-none' : ''}`}
        aria-hidden={waitingForPaint || undefined}
        inert={waitingForPaint || undefined}
      >
        {children}
      </div>
      {waitingForPaint ? <ThreadHydrationLoading /> : null}
    </div>
  )
}

export function ThreadHydrationLoading(): ReactElement {
  const { t } = useTranslation('common')

  return (
    <div
      data-testid="thread-hydration-loading"
      role="status"
      aria-busy="true"
      aria-live="polite"
      className="pointer-events-auto absolute inset-0 z-20 flex min-h-[18rem] select-none items-center justify-center bg-white px-6 dark:bg-ds-main"
    >
      <div className="flex max-w-sm flex-col items-center text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-full border border-ds-border-muted bg-ds-card shadow-sm">
          <Loader2
            aria-hidden="true"
            className="h-5 w-5 animate-spin text-accent motion-reduce:animate-none"
            strokeWidth={2}
          />
        </div>
        <p className="mt-4 text-[14px] font-medium text-ds-ink">
          {t('threadHydrationLoadingTitle')}
        </p>
        <p className="mt-1.5 text-[12.5px] leading-5 text-ds-muted">
          {t('threadHydrationLoadingDescription')}
        </p>
      </div>
    </div>
  )
}
