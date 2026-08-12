import { useMemo, useState, type ReactElement } from 'react'
import { Sparkles } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { parseSddRequirementBlocks } from '@shared/sdd-trace'
import type { SddDesignContext } from '../../sdd/sdd-draft-store'
import { SDD_DESIGN_TONE_OPTIONS } from '../../sdd/sdd-design-context'
import type { WriteSelectedImage } from '../write/WriteMarkdownEditor'
import type { WriteQuotedSelection } from '../../write/quoted-selection'

export const SDD_AUTOSAVE_MS = 650
export const PROTOTYPE_POLL_INTERVAL_MS = 4_000
export const PROTOTYPE_POLL_TIMEOUT_MS = 5 * 60_000

export function randomPrototypeFileName(): string {
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14)
  const hex = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0')
  return `prototype-${stamp}-${hex}.html`
}

export function firstMeaningfulDraftLine(markdown: string, fallback: string): string {
  const line = markdown
    .split(/\r?\n/)
    .map((item) => item.replace(/^#{1,6}\s+/, '').trim())
    .find(Boolean)
  return (line || fallback).slice(0, 240)
}

export function designReferenceTextFromImage(
  image: WriteSelectedImage,
  markdown: string,
  fallbackPath: string
): string {
  return [
    'Use the attached reference image as the primary visual basis for a refreshed high-fidelity UI design mockup.',
    image.alt.trim() ? `Reference image label: ${image.alt.trim()}` : '',
    `Requirement context: ${firstMeaningfulDraftLine(markdown, fallbackPath)}`,
    'Preserve the visible information architecture and key UI elements, while improving polish, hierarchy, spacing, and component consistency.'
  ].filter(Boolean).join('\n')
}

export type Props = {
  leftSidebarCollapsed: boolean
  assistantOpen: boolean
  onToggleLeftSidebar: () => void
  onToggleAssistant: () => void
  /** Queue plain user text and an optional structured selection reference. */
  onAssistantQuote: (prompt: string, selection?: WriteQuotedSelection) => void
  /** Dispatch a prototype-generation turn to the sidebar assistant (handles
   * the vision-model gate and image attachment). Resolves false when nothing
   * was sent (cancelled, busy plan, no thread). */
  onPrototypeTurn: (payload: {
    prompt: string
    displayText: string
    image?: { absolutePath: string; alt: string }
  }) => Promise<boolean>
  /** Open design mode seeded with this requirement (requirement → design). */
  onExploreInDesign?: () => void
  onNext: () => void
  onClose: () => void
  nextDisabled: boolean
}

export function SddDesignContextBar({
  designContext,
  onChange
}: {
  designContext: SddDesignContext | undefined
  onChange: (patch: Partial<SddDesignContext>) => void
}): ReactElement {
  const { t } = useTranslation('common')
  const [open, setOpen] = useState(false)
  const tone = designContext?.tone ?? []
  const brandColor = designContext?.brandColor ?? ''
  const isHexBrandColor = /^#[0-9a-fA-F]{6}$/.test(brandColor)
  // The native color swatch can only represent 6-digit hex. When the user has
  // typed a non-hex value (oklch/named), don't let the swatch silently clobber
  // it — keep the text field as the source of truth for those.
  const colorInputValue = isHexBrandColor ? brandColor : '#3b82d8'
  const swatchEditable = brandColor === '' || isHexBrandColor
  const toggleTone = (value: string): void => {
    const next = tone.includes(value) ? tone.filter((item) => item !== value) : [...tone, value]
    onChange({ tone: next })
  }
  const summaryParts = [
    designContext?.designType ? t(`sddDesignType_${designContext.designType}`) : null,
    brandColor || null,
    tone.length ? tone.join('·') : null
  ].filter(Boolean) as string[]
  const summary = summaryParts.length > 0 ? summaryParts.join(' · ') : t('sddDesignContextEmpty')
  const chipClass = (active: boolean): string =>
    `rounded-full border px-2.5 py-1 text-[12px] transition-colors ${
      active
        ? 'border-accent bg-accent/12 text-accent'
        : 'border-ds-border-muted bg-ds-main/40 text-ds-muted hover:text-ds-ink'
    }`
  return (
    <div className="mt-2 rounded-[14px] border border-ds-border-muted bg-ds-card/70">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left"
      >
        <span className="flex items-center gap-1.5 text-[13px] font-medium text-ds-ink">
          <Sparkles className="h-3.5 w-3.5 text-accent" />
          {t('sddDesignContextTitle')}
        </span>
        <span className="min-w-0 flex-1 truncate text-right text-[12px] text-ds-faint">{summary}</span>
      </button>
      {open ? (
        <div className="space-y-3 border-t border-ds-border-muted px-3 py-3">
          <div>
            <div className="mb-1.5 text-[12px] text-ds-muted">{t('sddDesignTypeLabel')}</div>
            <div className="flex gap-2">
              {(['brand', 'product'] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => onChange({ designType: value })}
                  className={chipClass(designContext?.designType === value)}
                >
                  {t(`sddDesignType_${value}`)}
                </button>
              ))}
            </div>
          </div>
          <div>
            <div className="mb-1.5 text-[12px] text-ds-muted">{t('sddDesignBrandColorLabel')}</div>
            <div className="flex items-center gap-2">
              <input
                type="color"
                aria-label={t('sddDesignBrandColorLabel')}
                value={colorInputValue}
                disabled={!swatchEditable}
                onChange={(e) => {
                  if (swatchEditable) onChange({ brandColor: e.target.value })
                }}
                className={`h-7 w-9 rounded border border-ds-border-muted bg-transparent ${
                  swatchEditable ? 'cursor-pointer' : 'cursor-not-allowed opacity-40'
                }`}
              />
              <input
                type="text"
                value={brandColor}
                placeholder={t('sddDesignBrandColorPlaceholder')}
                onChange={(e) => onChange({ brandColor: e.target.value })}
                className="h-7 flex-1 rounded-lg border border-ds-border-muted bg-ds-main/40 px-2 text-[12px] text-ds-ink outline-none focus:border-accent"
              />
              {brandColor ? (
                <button
                  type="button"
                  onClick={() => onChange({ brandColor: '' })}
                  className="text-[12px] text-ds-faint hover:text-ds-ink"
                >
                  {t('clear')}
                </button>
              ) : null}
            </div>
          </div>
          <div>
            <div className="mb-1.5 text-[12px] text-ds-muted">{t('sddDesignToneLabel')}</div>
            <div className="flex flex-wrap gap-1.5">
              {SDD_DESIGN_TONE_OPTIONS.map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => toggleTone(value)}
                  className={chipClass(tone.includes(value))}
                >
                  {value}
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

export function SddRequirementProgress({ content }: { content: string }): ReactElement | null {
  const { t } = useTranslation('common')
  const blocks = useMemo(() => parseSddRequirementBlocks(content), [content])
  if (blocks.length === 0) return null

  const counts = { verified: 0, done: 0, building: 0, planned: 0 }
  for (const block of blocks) {
    if (block.status === 'verified') counts.verified += 1
    else if (block.status === 'done') counts.done += 1
    else if (block.status === 'building') counts.building += 1
    else if (block.status === 'planned') counts.planned += 1
  }
  const total = blocks.length
  const implemented = counts.verified + counts.done

  return (
    <div className="sdd-req-progress shrink-0 px-1 pb-1 pt-2">
      <span className="text-[12px] font-semibold text-ds-muted">{t('sddReqProgressLabel')}</span>
      <div className="sdd-req-progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={implemented}>
        {(['verified', 'done', 'building', 'planned'] as const).map((key) =>
          counts[key] > 0 ? (
            <span
              key={key}
              className={`sdd-req-progress-seg-${key}`}
              style={{ width: `${(counts[key] / total) * 100}%` }}
            />
          ) : null
        )}
      </div>
      <span className="text-[12px] font-medium text-ds-faint">
        {t('sddReqProgressSummary', { done: implemented, total })}
      </span>
    </div>
  )
}

export function statusKey(saveStatus: string, operationStatus: string): string {
  if (operationStatus === 'upgrading') return 'sddStatusUpgrading'
  if (operationStatus === 'error' || saveStatus === 'error') return 'sddStatusError'
  if (saveStatus === 'saving') return 'sddStatusSaving'
  if (saveStatus === 'dirty') return 'sddStatusDirty'
  return 'sddStatusSaved'
}

export function SddAssistantToggleButton({
  assistantOpen,
  onToggleAssistant,
  label
}: {
  assistantOpen: boolean
  onToggleAssistant: () => void
  label: string
}): ReactElement {
  return (
    <button
      type="button"
      onClick={onToggleAssistant}
      className={`ds-sidebar-toggle-button ${
        assistantOpen ? 'border-ds-border-strong bg-white/70 text-ds-ink dark:bg-white/10' : ''
      }`}
      title={label}
      aria-label={label}
      aria-pressed={assistantOpen}
    >
      <Sparkles className="h-4 w-4" strokeWidth={1.85} />
    </button>
  )
}
