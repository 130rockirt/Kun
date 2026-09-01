import type { ReactElement, Ref } from 'react'
import { ArrowUp, Loader2, MessageCircle, Pencil, Trash2 } from 'lucide-react'

type Props = {
  rootRef: Ref<HTMLDivElement>
  previewButtonRef: Ref<HTMLButtonElement>
  previewText: string
  count: number
  open: boolean
  guiding: boolean
  canEdit: boolean
  canGuide: boolean
  queueLabel: string
  editLabel: string
  removeLabel: string
  guideLabel: string
  guideTitle: string
  guidingLabel: string
  onOpen: () => void
  onCloseSoon: () => void
  onEdit?: () => void
  onRemove: () => void
  onGuide?: () => void
}

/** The compact, always-visible preview for the next queued composer message. */
export function FloatingComposerQueueStrip({
  rootRef,
  previewButtonRef,
  previewText,
  count,
  open,
  guiding,
  canEdit,
  canGuide,
  queueLabel,
  editLabel,
  removeLabel,
  guideLabel,
  guideTitle,
  guidingLabel,
  onOpen,
  onCloseSoon,
  onEdit,
  onRemove,
  onGuide
}: Props): ReactElement {
  const actionClass =
    'ds-no-drag flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-ds-faint transition hover:bg-ds-hover hover:text-ds-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-ds-faint'

  return (
    <div
      ref={rootRef}
      data-composer-stack-item="queue"
      data-queued-message-count={count}
      className="pointer-events-auto relative -mb-px w-[calc(100%-2rem)] shrink-0"
    >
      <div className="ds-composer-queue-strip flex h-10 min-w-0 items-center gap-1 rounded-t-[14px] rounded-b-[10px] border px-2">
        <button
          ref={previewButtonRef}
          type="button"
          data-queued-message-preview
          onClick={onOpen}
          onFocus={onOpen}
          onBlur={onCloseSoon}
          onMouseEnter={onOpen}
          onMouseLeave={onCloseSoon}
          className="ds-no-drag flex h-full min-w-0 flex-1 items-center gap-2 rounded-lg px-0.5 text-left text-[13px] text-ds-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30"
          aria-label={queueLabel}
          aria-expanded={open}
          aria-haspopup="dialog"
        >
          <MessageCircle className="h-3.5 w-3.5 shrink-0 text-ds-faint" strokeWidth={1.7} />
          <span className="min-w-0 flex-1 truncate">{previewText}</span>
          {count > 1 ? (
            <span
              data-queued-message-overflow-count={count - 1}
              className="shrink-0 rounded-md bg-ds-hover px-1.5 py-0.5 text-[11px] font-medium text-ds-muted"
              aria-hidden="true"
            >
              +{count - 1}
            </span>
          ) : null}
        </button>
        <div className="flex shrink-0 items-center gap-0.5">
          {canEdit && onEdit ? (
            <button
              type="button"
              data-queued-message-strip-action="edit"
              onClick={onEdit}
              disabled={guiding}
              className={actionClass}
              aria-label={editLabel}
              title={editLabel}
            >
              <Pencil className="h-3.5 w-3.5" strokeWidth={1.8} />
            </button>
          ) : null}
          <button
            type="button"
            data-queued-message-strip-action="remove"
            onClick={onRemove}
            disabled={guiding}
            className={actionClass}
            aria-label={removeLabel}
            title={removeLabel}
          >
            <Trash2 className="h-3.5 w-3.5" strokeWidth={1.8} />
          </button>
          {onGuide ? (
            <button
              type="button"
              data-queued-message-strip-action="guide"
              onClick={onGuide}
              disabled={!canGuide || guiding}
              className={actionClass}
              aria-label={guiding ? guidingLabel : guideLabel}
              title={guiding ? guidingLabel : guideTitle}
            >
              {guiding ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.9} />
              ) : (
                <ArrowUp className="h-4 w-4" strokeWidth={1.8} />
              )}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  )
}
