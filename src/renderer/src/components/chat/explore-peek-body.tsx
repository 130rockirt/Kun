import type { ReactElement } from 'react'
import { Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ExplorePeekStep } from './explore-peek-summary'

/** Presentational peek body — kept free of portal/document for unit tests. */
export function ExplorePeekBody({
  loading,
  error,
  summary,
  reasoningPreview,
  assistantPreview,
  steps
}: {
  loading: boolean
  error: string | null
  summary?: string
  reasoningPreview?: string
  assistantPreview?: string
  steps: ExplorePeekStep[]
}): ReactElement {
  const { t } = useTranslation('common')
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-3.5 py-3">
      {loading && steps.length === 0 && !summary?.trim() ? (
        <div className="flex items-center gap-2 text-[12.5px] text-ds-muted">
          <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} />
          {t('explorePeekLoading', { defaultValue: 'Loading explore progress…' })}
        </div>
      ) : null}
      {error ? (
        <p className="text-[12.5px] text-ds-danger">{error}</p>
      ) : null}
      {!error && summary?.trim() ? (
        <div
          className="mb-3 max-h-[180px] overflow-y-auto whitespace-pre-wrap break-words rounded-[10px] border border-ds-border-muted bg-ds-card-muted/35 px-2.5 py-2 text-[13px] leading-5 text-ds-ink"
          data-testid="explore-peek-summary"
        >
          {summary.trim()}
        </div>
      ) : null}
      {!error && !summary?.trim() && reasoningPreview ? (
        <p className="mb-2 whitespace-pre-wrap text-[12.5px] leading-5 text-ds-muted">
          {reasoningPreview}
        </p>
      ) : null}
      {!error && !summary?.trim() && !reasoningPreview && assistantPreview ? (
        <p className="mb-2 whitespace-pre-wrap text-[12.5px] leading-5 text-ds-muted">
          {assistantPreview}
        </p>
      ) : null}
      {!error && steps.length > 0 ? (
        <ul className="flex flex-col gap-1.5" data-testid="explore-peek-steps">
          {steps.map((step) => (
            <li
              key={step.id}
              className="flex items-start gap-2 rounded-[8px] bg-ds-card-muted/40 px-2 py-1.5 text-[12px] leading-4 text-ds-ink"
            >
              <span className="mt-0.5 shrink-0 text-[10px] font-semibold uppercase tracking-wide text-ds-faint">
                {step.kind === 'tool' ? t('explorePeekStepTool', { defaultValue: 'Tool' })
                  : step.kind === 'reasoning' ? t('explorePeekStepThinking', { defaultValue: 'Think' })
                    : t('explorePeekStepReply', { defaultValue: 'Reply' })}
              </span>
              <span className="min-w-0 flex-1 break-words">{step.label}</span>
              {step.status === 'running' ? (
                <Loader2 className="mt-0.5 h-3 w-3 shrink-0 animate-spin text-accent" strokeWidth={2} />
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {!error && !loading && steps.length === 0 && !summary?.trim() && !reasoningPreview && !assistantPreview ? (
        <p className="text-[12.5px] text-ds-faint">
          {t('explorePeekEmpty', { defaultValue: 'Waiting for explore steps…' })}
        </p>
      ) : null}
    </div>
  )
}
