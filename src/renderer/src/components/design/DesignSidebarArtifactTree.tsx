import type { Dispatch, ReactElement, SetStateAction } from 'react'
import {
  Check,
  ChevronDown,
  ChevronRight,
  FileCode2,
  Layers,
  Palette,
  RotateCcw,
  Spline,
  Trash2,
  TriangleAlert
} from 'lucide-react'
import type { TFunction } from 'i18next'
import { groupDesignArtifacts } from '../../design/design-artifact-actions'
import type { DesignArtifact } from '../../design/design-types'
import { SidebarIconButton, SidebarSectionHeader, SidebarTreeRow } from '../sidebar/SidebarPrimitives'
import { CanvasLayersPanel } from './canvas/CanvasLayersPanel'
import { getDesignSidebarArtifactVersionBadge } from './design-sidebar-model'

type Props = {
  activeArtifact: DesignArtifact | null
  activeArtifactId: string | null
  agentDrawingArtifactIds: ReadonlySet<string>
  agentDrawingArtifacts: DesignArtifact[]
  agentDrawingsOpen: boolean
  designSystemHash: string
  draft: string
  editingId: string | null
  grouped: ReturnType<typeof groupDesignArtifacts>
  selectedEmbeddedArtifactId: string | null
  selectedHtmlArtifactId: string | null
  t: TFunction
  onBeginRename: (artifactId: string, title: string) => void
  onCommitRename: (artifactId: string) => void
  onRemoveArtifact: (artifactId: string) => void
  onSelectAgentDrawing: (artifact: DesignArtifact) => void
  onSetActiveArtifact: (artifactId: string) => void
  setAgentDrawingsOpen: Dispatch<SetStateAction<boolean>>
  setDraft: Dispatch<SetStateAction<string>>
  setEditingId: Dispatch<SetStateAction<string | null>>
}

export function DesignSidebarArtifactTree({
  activeArtifact,
  activeArtifactId,
  agentDrawingArtifactIds,
  agentDrawingArtifacts,
  agentDrawingsOpen,
  designSystemHash,
  draft,
  editingId,
  grouped,
  selectedEmbeddedArtifactId,
  selectedHtmlArtifactId,
  t,
  onBeginRename,
  onCommitRename,
  onRemoveArtifact,
  onSelectAgentDrawing,
  onSetActiveArtifact,
  setAgentDrawingsOpen,
  setDraft,
  setEditingId
}: Props): ReactElement {
  const renderArtifactStatus = (artifact: DesignArtifact): ReactElement | null => {
    const implemented = Boolean(artifact.implementedAt)
    if (!implemented) return null
    const drift = (artifact.implementedAt ?? '') < artifact.updatedAt
    const codeDrift =
      !drift &&
      Boolean(artifact.implementedDesignSystemHash) &&
      Boolean(designSystemHash) &&
      artifact.implementedDesignSystemHash !== designSystemHash
    const title = drift ? t('designDrift') : codeDrift ? t('designCodeDrift') : t('designImplemented')
    const Icon = drift ? RotateCcw : codeDrift ? TriangleAlert : Check
    return (
      <span
        title={title}
        aria-label={title}
        className={`inline-flex h-5 w-5 shrink-0 items-center justify-center ${
          drift ? 'text-[#c98a3a]' : codeDrift ? 'text-[#c0392b]' : 'text-[#2e9e6b]'
        }`}
      >
        <Icon className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
      </span>
    )
  }

  const renderArtifactRows = (items: DesignArtifact[]): ReactElement => (
    <ul className="space-y-1">
      {items.map((artifact) => {
        const active = artifact.id === activeArtifactId || artifact.id === selectedEmbeddedArtifactId
        const status = renderArtifactStatus(artifact)
        const versionBadge = getDesignSidebarArtifactVersionBadge(artifact)
        return (
          <li key={artifact.id}>
            {editingId === artifact.id ? (
              <div className="flex min-h-[34px] items-center rounded-[8px] bg-[var(--ds-sidebar-row-active)] px-2.5 py-1 shadow-[inset_0_0_0_1px_var(--ds-sidebar-row-ring)]">
                <input
                  autoFocus
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onBlur={() => onCommitRename(artifact.id)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') onCommitRename(artifact.id)
                    else if (event.key === 'Escape') setEditingId(null)
                  }}
                  className="h-7 min-w-0 flex-1 rounded-md border border-[var(--ds-sidebar-row-ring)] bg-[var(--ds-sidebar-field-focus)] px-2 text-[13px] text-[#1f2733] outline-none focus:border-[#3b82d8] dark:text-white"
                />
              </div>
            ) : (
              <SidebarTreeRow
                active={active}
                onClick={() => artifact.kind === 'svg'
                  ? onSelectAgentDrawing(artifact)
                  : onSetActiveArtifact(artifact.id)}
                onDoubleClick={() => onBeginRename(artifact.id, artifact.title)}
                title={artifact.title}
                className="min-h-[34px]"
                buttonClassName="items-center gap-2 px-2.5 py-2"
                trailing={
                  <>
                    {versionBadge ? <span className="text-[11.5px] text-ds-faint">{versionBadge}</span> : null}
                    {status}
                  </>
                }
                actions={
                  <SidebarIconButton
                    onClick={() => onRemoveArtifact(artifact.id)}
                    title={t('designDeleteArtifact')}
                    ariaLabel={t('designDeleteArtifact')}
                    tone="danger"
                    stopPropagation
                  >
                    <Trash2 className="h-3.5 w-3.5" strokeWidth={1.9} />
                  </SidebarIconButton>
                }
              >
                {artifact.kind === 'canvas' ? (
                  <Layers className="h-3.5 w-3.5 shrink-0 text-ds-muted" strokeWidth={1.9} />
                ) : artifact.kind === 'svg' ? (
                  <Spline className="h-3.5 w-3.5 shrink-0 text-[#6557ff]" strokeWidth={1.9} />
                ) : (
                  <FileCode2 className="h-3.5 w-3.5 shrink-0 text-ds-muted" strokeWidth={1.9} />
                )}
                <span className="min-w-0 flex-1 truncate">{artifact.title}</span>
              </SidebarTreeRow>
            )}
          </li>
        )
      })}
    </ul>
  )

  const renderAgentDrawingRows = (items: DesignArtifact[]): ReactElement => {
    const scrollable = items.length > 5
    return (
      <div className={scrollable ? 'max-h-[190px] overflow-y-auto pr-1' : undefined}>
        <ul className="space-y-1">
          {items.map((artifact) => {
            const active = artifact.id === activeArtifactId || artifact.id === selectedHtmlArtifactId
            const status = renderArtifactStatus(artifact)
            const versionBadge = getDesignSidebarArtifactVersionBadge(artifact)
            return (
              <li key={artifact.id}>
                {editingId === artifact.id ? (
                  <div className="flex min-h-[34px] items-center rounded-[8px] bg-[var(--ds-sidebar-row-active)] px-2.5 py-1 shadow-[inset_0_0_0_1px_var(--ds-sidebar-row-ring)]">
                    <input
                      autoFocus
                      value={draft}
                      onChange={(event) => setDraft(event.target.value)}
                      onBlur={() => onCommitRename(artifact.id)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') onCommitRename(artifact.id)
                        else if (event.key === 'Escape') setEditingId(null)
                      }}
                      className="h-7 min-w-0 flex-1 rounded-md border border-[var(--ds-sidebar-row-ring)] bg-[var(--ds-sidebar-field-focus)] px-2 text-[13px] text-[#1f2733] outline-none focus:border-[#3b82d8] dark:text-white"
                    />
                  </div>
                ) : (
                  <SidebarTreeRow
                    active={active}
                    onClick={() => onSelectAgentDrawing(artifact)}
                    onDoubleClick={() => onBeginRename(artifact.id, artifact.title)}
                    title={artifact.title}
                    className="min-h-[34px]"
                    buttonClassName="items-center gap-2 px-2.5 py-2"
                    trailing={
                      <>
                        {versionBadge ? <span className="text-[11.5px] text-ds-faint">{versionBadge}</span> : null}
                        {status}
                      </>
                    }
                    actions={
                      <SidebarIconButton
                        onClick={() => onRemoveArtifact(artifact.id)}
                        title={t('designDeleteArtifact')}
                        ariaLabel={t('designDeleteArtifact')}
                        tone="danger"
                        stopPropagation
                      >
                        <Trash2 className="h-3.5 w-3.5" strokeWidth={1.9} />
                      </SidebarIconButton>
                    }
                  >
                    <Palette className="h-3.5 w-3.5 shrink-0 text-ds-muted" strokeWidth={1.9} />
                    <span className="min-w-0 flex-1 truncate">{artifact.title}</span>
                  </SidebarTreeRow>
                )}
              </li>
            )
          })}
        </ul>
      </div>
    )
  }

  const items = [
    ...grouped.html.filter((artifact) => !agentDrawingArtifactIds.has(artifact.id)),
    ...grouped.svg
  ]
  const toggleLabel = t(agentDrawingsOpen ? 'designAgentDrawingsCollapse' : 'designAgentDrawingsExpand')
  return (
    <div className="ml-3 mt-0.5 space-y-1 border-l border-[var(--ds-sidebar-row-ring)] pl-2">
      {items.length > 0 ? renderArtifactRows(items) : agentDrawingArtifacts.length === 0 && activeArtifact?.kind !== 'canvas' ? (
        <div className="px-2.5 py-1.5 text-[12px] leading-5 text-ds-faint">{t('designDocEmpty')}</div>
      ) : null}
      {agentDrawingArtifacts.length > 0 ? (
        <section>
          <button
            type="button"
            onClick={() => setAgentDrawingsOpen((open) => !open)}
            title={toggleLabel}
            aria-label={toggleLabel}
            className="flex w-full items-center gap-1 px-2.5 pb-2 pt-5 text-left text-[12px] font-normal text-[#9aa5b5] transition hover:text-ds-muted dark:text-white/35 dark:hover:text-white/55"
          >
            {agentDrawingsOpen ? (
              <ChevronDown className="h-3.5 w-3.5 shrink-0" strokeWidth={1.8} />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 shrink-0" strokeWidth={1.8} />
            )}
            <span className="min-w-0 flex-1 truncate">{t('designAgentDrawingsTitle')}</span>
            <span className="shrink-0 text-[11.5px] text-ds-faint">{agentDrawingArtifacts.length}</span>
          </button>
          {agentDrawingsOpen ? renderAgentDrawingRows(agentDrawingArtifacts) : null}
        </section>
      ) : null}
      {activeArtifact?.kind === 'canvas' ? (
        <section>
          <SidebarSectionHeader label={t('canvasLayersTitle')} />
          <CanvasLayersPanel />
        </section>
      ) : null}
    </div>
  )
}
