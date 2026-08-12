import type { ReactElement } from 'react'
import { FileText, FolderOpen } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ToolBlock } from '../../agent/types'
import { useChatStore } from '../../store/chat-store'
import { useWriteWorkspaceStore } from '../../write/write-workspace-store'
import {
  requestKnowledgeSourceNavigation,
  type KnowledgeSourceNavigationLocation
} from '../../lib/knowledge-source-navigation'
import { parseToolBlockPayload } from './message-timeline-tools'

type KnowledgeEvidenceItem = {
  mountId: string
  relativePath: string
  format?: string
  sourceSha256?: string
  location: KnowledgeSourceNavigationLocation
  locationLabel: string
  text: string
  truncated: boolean
}

export function KnowledgeEvidenceDetail({ block }: { block: ToolBlock }): ReactElement {
  const { t } = useTranslation('common')
  const activeThread = useChatStore((state) =>
    state.threads.find((thread) => thread.id === state.activeThreadId)
  )
  const openWrite = useChatStore((state) => state.openWrite)
  const evidence = parseKnowledgeEvidence(block)

  const openSource = async (item: KnowledgeEvidenceItem): Promise<void> => {
    const mount = activeThread?.knowledgeBases?.find((candidate) => candidate.id === item.mountId)
    if (!mount) return
    const absolutePath = knowledgeEvidenceSourcePath(mount.root, item.relativePath)
    if (!absolutePath) return
    const write = useWriteWorkspaceStore.getState()
    await write.selectWriteWorkspace(mount.root)
    await openWrite()
    requestKnowledgeSourceNavigation({ filePath: absolutePath, location: item.location })
    await useWriteWorkspaceStore.getState().openFile(mount.root, absolutePath)
  }

  return (
    <div className="flex max-h-96 flex-col gap-2 overflow-y-auto">
      {evidence.map((item, index) => (
        <article key={`${item.mountId}:${item.relativePath}:${item.locationLabel}:${index}`} className="rounded-[10px] border border-ds-border-muted bg-ds-card/70 p-3">
          <div className="flex items-start gap-2">
            <FileText className="mt-0.5 h-4 w-4 shrink-0 text-accent" strokeWidth={1.8} />
            <div className="min-w-0 flex-1">
              <div className="truncate font-mono text-[12px] font-medium text-ds-ink">{item.relativePath}</div>
              <div className="mt-0.5 flex flex-wrap gap-x-2 text-[11px] text-ds-faint">
                {item.format ? <span>{item.format.toUpperCase()}</span> : null}
                <span>{item.locationLabel}</span>
                {item.sourceSha256 ? <span title={item.sourceSha256}>SHA {item.sourceSha256.slice(0, 8)}</span> : null}
                {item.truncated ? <span>{t('knowledgeBaseEvidenceTruncated')}</span> : null}
              </div>
            </div>
            <button
              type="button"
              className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-ds-muted hover:bg-ds-hover hover:text-ds-ink disabled:opacity-40"
              disabled={!activeThread?.knowledgeBases?.some((candidate) => candidate.id === item.mountId)}
              onClick={() => void openSource(item)}
              title={t('knowledgeBaseOpenSource')}
            >
              <FolderOpen className="h-3.5 w-3.5" />
              {t('knowledgeBaseOpenSource')}
            </button>
          </div>
          <pre className="mt-2 max-h-52 overflow-auto whitespace-pre-wrap break-words border-t border-ds-border-muted pt-2 font-mono text-[12px] leading-5 text-ds-muted">{item.text}</pre>
        </article>
      ))}
    </div>
  )
}

export function knowledgeEvidenceSourcePath(rootInput: string, relativeInput: string): string | null {
  const root = rootInput.replaceAll('\\', '/').replace(/\/+$/, '')
  const relativePath = relativeInput.replaceAll('\\', '/')
  if (relativePath.startsWith('/') || /^[a-z]:\//i.test(relativePath)) return null
  const parts = relativePath.split('/')
  if (!root || parts.length === 0 || parts.some((part) => !part || part === '.' || part === '..')) return null
  return `${root}/${parts.join('/')}`
}

export function parseKnowledgeEvidence(block: ToolBlock): KnowledgeEvidenceItem[] {
  const payload = parseToolBlockPayload(block)
  if (!Array.isArray(payload.evidence)) return []
  return payload.evidence.flatMap((value) => {
    if (!value || typeof value !== 'object') return []
    const item = value as Record<string, unknown>
    const location = parseLocation(item.location)
    if (!location || typeof item.mountId !== 'string' || typeof item.relativePath !== 'string' || typeof item.text !== 'string') return []
    return [{
      mountId: item.mountId,
      relativePath: item.relativePath,
      ...(typeof item.format === 'string' ? { format: item.format } : {}),
      ...(typeof item.sourceSha256 === 'string' ? { sourceSha256: item.sourceSha256 } : {}),
      location,
      locationLabel: formatLocation(location),
      text: item.text,
      truncated: item.truncated === true || item.documentTruncated === true
    }]
  })
}

function parseLocation(value: unknown): KnowledgeSourceNavigationLocation | null {
  if (!value || typeof value !== 'object') return null
  const location = value as Record<string, unknown>
  if (location.kind === 'text' && numbers(location, 'lineStart', 'lineEnd')) {
    return { kind: 'text', lineStart: location.lineStart as number, lineEnd: location.lineEnd as number }
  }
  if (location.kind === 'pdf' && numbers(location, 'pageStart', 'pageEnd')) {
    return { kind: 'pdf', pageStart: location.pageStart as number, pageEnd: location.pageEnd as number }
  }
  if (location.kind === 'word' && numbers(location, 'paragraphStart', 'paragraphEnd')) {
    return { kind: 'word', paragraphStart: location.paragraphStart as number, paragraphEnd: location.paragraphEnd as number }
  }
  if (location.kind === 'presentation' && numbers(location, 'slideStart', 'slideEnd')) {
    return { kind: 'presentation', slideStart: location.slideStart as number, slideEnd: location.slideEnd as number }
  }
  if (location.kind === 'spreadsheet' && typeof location.sheetName === 'string' && typeof location.range === 'string') {
    return { kind: 'spreadsheet', sheetName: location.sheetName, range: location.range }
  }
  return null
}

function numbers(value: Record<string, unknown>, first: string, second: string): boolean {
  return typeof value[first] === 'number' && Number.isFinite(value[first]) &&
    typeof value[second] === 'number' && Number.isFinite(value[second])
}

function formatLocation(value: unknown): string {
  if (!value || typeof value !== 'object') return ''
  const location = value as Record<string, unknown>
  if (location.kind === 'pdf') return `Page ${location.pageStart ?? ''}`
  if (location.kind === 'text') return `Lines ${location.lineStart ?? ''}-${location.lineEnd ?? ''}`
  if (location.kind === 'word') return `Paragraphs ${location.paragraphStart ?? ''}-${location.paragraphEnd ?? ''}`
  if (location.kind === 'presentation') return `Slide ${location.slideStart ?? ''}`
  if (location.kind === 'spreadsheet') return `${String(location.sheetName ?? '')}!${String(location.range ?? '')}`
  return ''
}
