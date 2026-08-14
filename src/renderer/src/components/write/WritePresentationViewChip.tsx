import { Presentation } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ReactElement } from 'react'
import type { WorkspacePresentationViewReference } from '@shared/office-document'

export function WritePresentationViewChip({
  view
}: {
  view: WorkspacePresentationViewReference
}): ReactElement {
  const { t } = useTranslation('common')
  const slideLabel = t('writeAssistantSlidePosition', {
    slide: view.slide,
    slideCount: view.slideCount
  })
  const title = `${t('writeAssistantCurrentView')} · ${view.sourceName} · ${slideLabel}`

  return (
    <div
      data-write-presentation-view="true"
      className="mb-2 flex min-w-0 items-center gap-1.5 rounded-xl border border-accent/20 bg-accent/[0.07] px-3 py-2 text-[12px] font-medium text-ds-muted"
      title={title}
    >
      <Presentation className="h-3.5 w-3.5 shrink-0 text-accent" strokeWidth={1.9} />
      <span className="shrink-0 text-accent">{t('writeAssistantCurrentView')}</span>
      <span className="text-ds-faint" aria-hidden="true">·</span>
      <span className="min-w-0 flex-1 truncate">{view.sourceName}</span>
      <span className="text-ds-faint" aria-hidden="true">·</span>
      <span className="shrink-0">{slideLabel}</span>
    </div>
  )
}
