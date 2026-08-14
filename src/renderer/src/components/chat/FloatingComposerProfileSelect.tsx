import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactElement
} from 'react'
import { Check, ChevronDown, type LucideIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'

export type ComposerProfileSelectOption<Value extends string> = {
  value: Value
  label: string
  icon: LucideIcon
  iconClassName: string
  disabled?: boolean
}

type PopupPlacement = 'top' | 'bottom'

function resolvePopupLayout(
  trigger: Pick<DOMRect, 'top' | 'bottom'>,
  viewportHeight: number,
  preferredHeight: number
): { placement: PopupPlacement; maxHeight: number } {
  const viewportMargin = 16
  const popupGap = 8
  const spaceAbove = Math.max(0, trigger.top - viewportMargin - popupGap)
  const spaceBelow = Math.max(0, viewportHeight - trigger.bottom - viewportMargin - popupGap)
  const placement = spaceBelow >= preferredHeight || spaceBelow >= spaceAbove ? 'bottom' : 'top'
  return {
    placement,
    maxHeight: Math.min(preferredHeight, placement === 'bottom' ? spaceBelow : spaceAbove)
  }
}

export function FloatingComposerProfileSelect<Value extends string>({
  pickerId,
  label,
  value,
  options,
  disabled,
  onChange
}: {
  pickerId: string
  label: string
  value: Value
  options: readonly [
    ComposerProfileSelectOption<Value>,
    ...Array<ComposerProfileSelectOption<Value>>
  ]
  disabled: boolean
  onChange?: (value: Value) => void
}): ReactElement {
  const { t } = useTranslation('common')
  const [open, setOpen] = useState(false)
  const preferredHeight = Math.min(280, options.length * 44 + 20)
  const [popupLayout, setPopupLayout] = useState<{
    placement: PopupPlacement
    maxHeight: number
  }>({ placement: 'bottom', maxHeight: preferredHeight })
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([])
  const optionsRef = useRef(options)
  optionsRef.current = options
  const labelId = useId()
  const listboxId = useId()
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value))
  const selectedOption = options[selectedIndex] ?? options[0]

  const updatePopupLayout = useCallback((): void => {
    const trigger = triggerRef.current?.getBoundingClientRect()
    if (!trigger) return
    setPopupLayout(resolvePopupLayout(trigger, window.innerHeight, preferredHeight))
  }, [preferredHeight])

  const focusOption = useCallback((requestedIndex: number, direction: 1 | -1): void => {
    const currentOptions = optionsRef.current
    for (let offset = 0; offset < currentOptions.length; offset += 1) {
      const index = (
        requestedIndex + offset * direction + currentOptions.length
      ) % currentOptions.length
      if (!currentOptions[index]?.disabled) {
        optionRefs.current[index]?.focus()
        return
      }
    }
  }, [])

  const closeAndFocusTrigger = (): void => {
    setOpen(false)
    window.requestAnimationFrame(() => triggerRef.current?.focus())
  }

  useEffect(() => {
    if (!open) return undefined
    const handlePointerDown = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const detailsElement = rootRef.current?.closest('details')
    const handleDetailsToggle = (): void => {
      if (!detailsElement?.open) setOpen(false)
    }
    updatePopupLayout()
    document.addEventListener('pointerdown', handlePointerDown)
    detailsElement?.addEventListener('toggle', handleDetailsToggle)
    window.addEventListener('resize', updatePopupLayout)
    window.addEventListener('scroll', updatePopupLayout, true)
    const frame = window.requestAnimationFrame(() => focusOption(selectedIndex, 1))
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      detailsElement?.removeEventListener('toggle', handleDetailsToggle)
      window.removeEventListener('resize', updatePopupLayout)
      window.removeEventListener('scroll', updatePopupLayout, true)
      window.cancelAnimationFrame(frame)
    }
  }, [focusOption, open, selectedIndex, updatePopupLayout])

  const selectOption = (option: ComposerProfileSelectOption<Value>): void => {
    if (option.disabled) return
    onChange?.(option.value)
    closeAndFocusTrigger()
  }

  const SelectedIcon = selectedOption.icon

  return (
    <div
      ref={rootRef}
      className="relative grid gap-1"
      data-profile-select={pickerId}
    >
      <span id={labelId} className="text-[11.5px] font-medium text-ds-muted">
        {label}
      </span>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled || !onChange}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-labelledby={labelId}
        onClick={() => {
          if (!open) updatePopupLayout()
          setOpen((current) => !current)
        }}
        onKeyDown={(event) => {
          if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
          event.preventDefault()
          if (!open) setOpen(true)
          const moveBackward = event.key === 'ArrowUp' || event.key === 'End'
          const requestedIndex = event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? options.length - 1
              : selectedIndex
          window.requestAnimationFrame(() => focusOption(requestedIndex, moveBackward ? -1 : 1))
        }}
        className={`flex h-9 w-full items-center gap-2 rounded-xl border bg-ds-surface-subtle px-2.5 text-left text-[12px] font-medium outline-none transition disabled:cursor-not-allowed disabled:opacity-60 ${
          open
            ? 'border-[#788bff] text-ds-ink shadow-[0_0_0_3px_rgba(107,124,255,0.12)]'
            : 'border-ds-border-muted text-ds-muted hover:border-ds-border-strong hover:text-ds-ink focus-visible:border-[#788bff] focus-visible:shadow-[0_0_0_3px_rgba(107,124,255,0.12)]'
        }`}
      >
        <span className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md ${selectedOption.iconClassName}`}>
          <SelectedIcon className="h-3 w-3" strokeWidth={2} aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1 truncate">{selectedOption.label}</span>
        <ChevronDown className={`h-3.5 w-3.5 shrink-0 transition ${open ? 'rotate-180' : ''}`} strokeWidth={1.8} />
      </button>
      {open ? (
        <div
          id={listboxId}
          role="listbox"
          aria-labelledby={labelId}
          className={`absolute left-0 z-[70] w-full overflow-y-auto overscroll-contain rounded-2xl border border-ds-border-muted bg-white p-1.5 shadow-[0_18px_44px_rgba(15,23,42,0.15),0_3px_12px_rgba(15,23,42,0.06)] dark:bg-ds-card ${
            popupLayout.placement === 'top'
              ? 'bottom-[calc(100%+8px)]'
              : 'top-[calc(100%+8px)]'
          }`}
          style={{ maxHeight: popupLayout.maxHeight }}
          data-profile-select-listbox={pickerId}
          data-placement={popupLayout.placement}
          onKeyDown={(event) => {
            const currentIndex = optionRefs.current.indexOf(document.activeElement as HTMLButtonElement)
            if (event.key === 'Escape') {
              event.preventDefault()
              closeAndFocusTrigger()
              return
            }
            if (event.key === 'Tab') {
              setOpen(false)
              return
            }
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              const option = options[Math.max(0, currentIndex)]
              if (option) selectOption(option)
              return
            }
            const direction = event.key === 'ArrowUp' ? -1 : 1
            const requestedIndex = event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? options.length - 1
                : event.key === 'ArrowDown' || event.key === 'ArrowUp'
                  ? currentIndex + direction
                  : null
            if (requestedIndex === null) return
            event.preventDefault()
            focusOption(requestedIndex, direction)
          }}
        >
          {options.map((option, index) => {
            const selected = option.value === value
            const OptionIcon = option.icon
            return (
              <button
                key={option.value}
                ref={(element) => { optionRefs.current[index] = element }}
                type="button"
                role="option"
                tabIndex={-1}
                aria-selected={selected}
                aria-disabled={option.disabled || undefined}
                disabled={option.disabled}
                onClick={() => selectOption(option)}
                className={`flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-[12px] font-medium outline-none transition focus-visible:ring-2 focus-visible:ring-[#788bff]/40 disabled:cursor-not-allowed disabled:opacity-45 ${
                  selected
                    ? 'bg-[#eef0ff] text-[#5558e8] dark:bg-indigo-400/15 dark:text-indigo-300'
                    : 'text-ds-ink hover:bg-ds-hover'
                }`}
              >
                <span
                  className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${option.iconClassName}`}
                  data-profile-option-icon={option.value}
                >
                  <OptionIcon className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
                </span>
                <span className="min-w-0 flex-1 truncate">{option.label}</span>
                {selected ? (
                  <span className="inline-flex shrink-0 items-center gap-1 text-[9.5px] font-semibold">
                    <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-[#6267ee] text-white">
                      <Check className="h-2.5 w-2.5" strokeWidth={2.6} />
                    </span>
                    {t('designStyleCurrent', { defaultValue: 'Current' })}
                  </span>
                ) : null}
              </button>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}
