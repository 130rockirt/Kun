import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement
} from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, CircleHelp, CircleSlash, Settings2, Sparkles } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  calculateComposerPopoverPlacement,
  currentComposerBodyZoom
} from './floating-composer-popover-placement'
import type { ResolvedCodeAgentPreset } from './code-agent-presets'
import { LucideIconByName } from '../lucide-icon-by-name'

type Props = {
  presets: readonly ResolvedCodeAgentPreset[]
  activePresetId: string
  disabled?: boolean
  onSelect: (presetId: string) => void
  onOpenPersonaSettings?: () => void
}

const PERSONA_MENU_WIDTH = 224
const PERSONA_MENU_MAX_HEIGHT = 320
/** Header + "None" row + three single-line preset rows; refined once mounted. */
const PERSONA_MENU_ESTIMATED_HEIGHT = 180

export function FloatingComposerPersonaPicker({
  presets,
  activePresetId,
  disabled = false,
  onSelect,
  onOpenPersonaSettings
}: Props): ReactElement | null {
  const { t } = useTranslation('common')
  const [open, setOpen] = useState(false)
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({})
  const rootRef = useRef<HTMLDivElement | null>(null)
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)

  const active = presets.find((preset) => preset.id === activePresetId)

  const updateMenuPosition = useCallback((): void => {
    const rect = buttonRef.current?.getBoundingClientRect()
    if (!rect) return
    const { left, top, width, maxHeight } = calculateComposerPopoverPlacement({
      anchorRect: rect,
      popoverHeight: menuRef.current?.offsetHeight ?? PERSONA_MENU_ESTIMATED_HEIGHT,
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
      preferredWidth: PERSONA_MENU_WIDTH,
      maximumHeight: PERSONA_MENU_MAX_HEIGHT,
      coordinateScale: currentComposerBodyZoom()
    })
    setMenuStyle({ left, top, width, maxHeight })
  }, [])

  useEffect(() => {
    if (!open) return
    updateMenuPosition()
    // A second pass after paint swaps the estimated height for the measured one.
    const frame = window.requestAnimationFrame(updateMenuPosition)
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target
      if (target instanceof Node && rootRef.current?.contains(target)) return
      if (target instanceof Node && menuRef.current?.contains(target)) return
      setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('resize', updateMenuPosition)
    window.addEventListener('scroll', updateMenuPosition, true)
    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('resize', updateMenuPosition)
      window.removeEventListener('scroll', updateMenuPosition, true)
    }
  }, [open, updateMenuPosition])

  // Nothing to pick and no way to add one: render nothing rather than a dead control.
  if (presets.length === 0 && !onOpenPersonaSettings) return null

  const commit = (presetId: string): void => {
    onSelect(presetId)
    setOpen(false)
  }

  const menu =
    open && typeof document !== 'undefined' ? (
      <div
        ref={menuRef}
        role="menu"
        aria-label={t('codeAgentPersonaLabel')}
        style={menuStyle}
        className="ds-composer-persona-menu fixed z-50 max-w-[calc(100vw-24px)] overflow-y-auto rounded-[18px] border border-ds-border-muted bg-white px-2 py-2 text-[13px] text-ds-ink shadow-[0_18px_48px_rgba(20,47,95,0.14)] dark:bg-ds-card"
      >
        <div
          role="presentation"
          className="ds-composer-persona-menu-header flex items-center justify-between gap-4 px-2.5 pb-1.5 pt-1"
        >
          <span className="truncate text-[12.5px] font-medium text-ds-muted">
            {t('codeAgentPersonaLabel')}
          </span>
          {onOpenPersonaSettings ? (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false)
                onOpenPersonaSettings()
              }}
              className="inline-flex shrink-0 items-center gap-1 rounded-md px-1 py-0.5 text-[12px] font-medium text-ds-muted transition-colors hover:text-ds-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ds-accent/40"
            >
              <Settings2 className="h-3 w-3" strokeWidth={1.9} />
              {t('codeAgentPersonaManage')}
            </button>
          ) : null}
        </div>
        <div role="presentation" className="ds-composer-persona-options">
          <PersonaRow
            selected={activePresetId === ''}
            icon=""
            label={t('codeAgentPersonaNone')}
            onClick={() => commit('')}
          />
          {presets.map((preset) => (
            <PersonaRow
              key={preset.id}
              selected={activePresetId === preset.id}
              icon={preset.icon}
              label={preset.name}
              description={preset.persona}
              onClick={() => commit(activePresetId === preset.id ? '' : preset.id)}
            />
          ))}
          {presets.length === 0 ? (
            <p className="px-2.5 py-2 text-[12px] text-ds-muted">
              {t('codeAgentPersonaEmptyHint')}
            </p>
          ) : null}
        </div>
      </div>
    ) : null

  return (
    <>
      <div
        ref={rootRef}
        className="ds-composer-persona-control ds-no-drag relative inline-flex shrink-0 items-center"
        title={active ? `${t('codeAgentPersonaLabel')}: ${active.name}` : t('codeAgentPersonaLabel')}
      >
        <button
          ref={buttonRef}
          type="button"
          data-composer-persona={activePresetId || 'none'}
          disabled={disabled}
          onClick={() => {
            updateMenuPosition()
            setOpen((current) => !current)
          }}
          className={`ds-composer-persona-button inline-flex min-h-7 items-center gap-1.5 rounded-full border border-transparent px-2.5 py-0.5 text-[12.5px] font-semibold shadow-none transition-colors disabled:cursor-not-allowed disabled:opacity-55 ${
            active
              ? 'bg-accent/12 text-accent hover:bg-accent/20'
              : 'bg-ds-hover/65 text-ds-muted hover:bg-ds-hover hover:text-ds-ink'
          }`}
          aria-expanded={open}
          aria-haspopup="menu"
          aria-label={t('codeAgentPersonaLabel')}
        >
          {active ? (
            <LucideIconByName name={active.icon} className="h-3.5 w-3.5 shrink-0" strokeWidth={1.8} />
          ) : (
            <Sparkles className="h-3.5 w-3.5 shrink-0" strokeWidth={1.8} />
          )}
          <span className="ds-composer-persona-label max-w-[112px] truncate">
            {active ? active.name : t('codeAgentPersonaLabel')}
          </span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0" strokeWidth={1.8} />
        </button>
      </div>
      {menu ? createPortal(menu, document.body) : null}
    </>
  )
}

function PersonaRow({
  selected,
  icon,
  label,
  description,
  onClick
}: {
  selected: boolean
  /** Lucide icon name; empty renders the "no persona" slash. */
  icon: string
  label: string
  /** Full persona text, shown instantly by hovering the row's "?" icon. */
  description?: string
  onClick: () => void
}): ReactElement {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      onClick={onClick}
      className={`ds-composer-persona-option flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ds-accent/35 ${
        selected ? 'text-accent hover:bg-accent/8' : 'text-ds-ink hover:bg-ds-hover/60'
      }`}
    >
      <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center">
        {icon ? (
          <LucideIconByName name={icon} className="h-4 w-4" strokeWidth={1.8} />
        ) : (
          <CircleSlash className="h-4 w-4 text-ds-faint" strokeWidth={1.8} />
        )}
      </span>
      <span className="min-w-0 flex-1 truncate text-[13px] font-medium leading-5">{label}</span>
      {description ? <PersonaHelpTip text={description} /> : null}
      {selected ? (
        <Check className="h-3.5 w-3.5 shrink-0 text-accent" strokeWidth={2.2} />
      ) : null}
    </button>
  )
}

const HELP_TIP_WIDTH = 264
const HELP_TIP_GAP = 8
const HELP_TIP_MARGIN = 12

/**
 * "?" affordance whose tooltip appears the moment the pointer enters — no
 * native-title delay. Rendered through a portal so the scrollable menu cannot
 * clip it; positioned beside the icon, flipping to whichever side has room.
 */
function PersonaHelpTip({ text }: { text: string }): ReactElement {
  const [tipStyle, setTipStyle] = useState<CSSProperties | null>(null)
  const anchorRef = useRef<HTMLSpanElement | null>(null)

  const show = (): void => {
    const rect = anchorRef.current?.getBoundingClientRect()
    if (!rect) return
    const scale = currentComposerBodyZoom()
    const viewportWidth = window.innerWidth / scale
    const viewportHeight = window.innerHeight / scale
    const anchor = {
      left: rect.left / scale,
      right: rect.right / scale,
      top: rect.top / scale,
      bottom: rect.bottom / scale
    }
    const fitsRight = anchor.right + HELP_TIP_GAP + HELP_TIP_WIDTH <= viewportWidth - HELP_TIP_MARGIN
    const left = fitsRight
      ? anchor.right + HELP_TIP_GAP
      : Math.max(HELP_TIP_MARGIN, anchor.left - HELP_TIP_GAP - HELP_TIP_WIDTH)
    const top = Math.min(
      Math.max(HELP_TIP_MARGIN, anchor.top - 8),
      viewportHeight - HELP_TIP_MARGIN - 120
    )
    setTipStyle({ left, top, width: HELP_TIP_WIDTH })
  }

  return (
    <>
      <span
        ref={anchorRef}
        onPointerEnter={show}
        onPointerLeave={() => setTipStyle(null)}
        className="inline-flex h-4 w-4 shrink-0 items-center justify-center text-ds-faint transition-colors hover:text-ds-ink"
      >
        <CircleHelp className="h-3.5 w-3.5" strokeWidth={1.8} />
      </span>
      {tipStyle && typeof document !== 'undefined'
        ? createPortal(
            <div
              role="tooltip"
              style={tipStyle}
              className="pointer-events-none fixed z-[60] rounded-xl border border-ds-border-muted bg-white px-3 py-2.5 text-[12px] leading-[1.5] text-ds-muted shadow-[0_12px_32px_rgba(20,47,95,0.16)] dark:bg-ds-card"
            >
              {text}
            </div>,
            document.body
          )
        : null}
    </>
  )
}
