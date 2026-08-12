import type { ReactElement } from 'react'
import { FileText } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { WritePromptDisplayOfficeDocument } from '../../write/quoted-selection'

export function WritePromptOfficeDocumentCard({
  document
}: {
  document: WritePromptDisplayOfficeDocument
}): ReactElement {
  const { t } = useTranslation('common')
  return (
    <div className="rounded-xl border border-accent/15 bg-accent/[0.055] px-3 py-2.5 text-left shadow-sm">
      <div className="flex min-w-0 items-center gap-2 text-[12px] leading-5">
        <FileText className="h-3.5 w-3.5 shrink-0 text-accent" strokeWidth={1.9} />
        <span className="min-w-0 flex-1 truncate font-medium text-ds-ink">
          {document.sourceTitle}
        </span>
        <span className="shrink-0 rounded-full bg-white/65 px-2 py-0.5 font-mono text-[11px] text-ds-faint dark:bg-white/8">
          {document.sourceFormat.toUpperCase()}
        </span>
      </div>
      <div className="mt-1.5 text-[11.5px] text-ds-muted">
        {t('writePromptOfficeContextDetail', {
          count: document.charCount,
          truncated: document.truncated ? ' · truncated' : ''
        })}
      </div>
      <div className="mt-1.5 truncate font-mono text-[11px] text-ds-faint" title={document.sourceFilePath}>
        {document.sourceFilePath}
      </div>
    </div>
  )
}
