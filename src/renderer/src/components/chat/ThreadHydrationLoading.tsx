import type { ReactElement, ReactNode } from 'react'
import { Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'

export function ThreadHydrationGate({ loading, children }: {
  loading: boolean
  children: ReactNode
}): ReactElement {
  return loading ? <ThreadHydrationLoading /> : <>{children}</>
}

export function ThreadHydrationLoading(): ReactElement {
  const { t } = useTranslation('common')

  return (
    <div
      data-testid="thread-hydration-loading"
      role="status"
      aria-busy="true"
      aria-live="polite"
      className="absolute inset-0 z-20 flex min-h-[18rem] select-none items-center justify-center bg-white px-6 dark:bg-ds-main"
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
