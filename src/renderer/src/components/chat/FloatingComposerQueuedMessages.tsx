import { useEffect, useId, useRef, useState, type ReactElement } from 'react'
import {
  Check,
  ChevronDown,
  ChevronUp,
  CornerDownRight,
  ImageIcon,
  ListPlus,
  Loader2,
  Pencil,
  Trash2,
  X
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { queuedMessageGuidancePayload } from '../../store/queued-message-guidance'
import { parseWritePromptForDisplay } from '../../write/quoted-selection'
import type {
  ComposerPopoverAnchorRect,
  ComposerPopoverPlacement
} from './floating-composer-popover-placement'

export type QueuedMessagesPopoverPlacement = ComposerPopoverPlacement
export type QueuedMessageMenuPlacement = { left: number; top: number; width: number }

/** Kept for compatibility with existing geometry consumers; the attached dock no longer uses it. */
export function calculateQueuedMessagesPopoverPlacement({
  anchorRect,
  popoverHeight,
  viewportHeight,
  viewportWidth,
  coordinateScale = 1
}: {
  anchorRect: ComposerPopoverAnchorRect
  popoverHeight: number
  viewportHeight: number
  viewportWidth: number
  coordinateScale?: number
}): QueuedMessagesPopoverPlacement {
  const scale = Number.isFinite(coordinateScale) && coordinateScale > 0 ? coordinateScale : 1
  const width = Math.min(640, viewportWidth / scale - 24)
  return {
    left: Math.max(12, Math.min((anchorRect.left + anchorRect.right) / (2 * scale) - width / 2, viewportWidth / scale - width - 12)),
    top: Math.max(12, anchorRect.top / scale - popoverHeight - 8),
    width,
    maxHeight: Math.min(360, viewportHeight / scale - 24)
  }
}

/** Kept for compatibility with existing geometry consumers; inline editing replaces this menu. */
export function calculateQueuedMessageMenuPlacement({
  anchorRect,
  viewportHeight,
  viewportWidth,
  coordinateScale = 1
}: {
  anchorRect: Pick<DOMRect, 'bottom' | 'right' | 'top'>
  viewportHeight: number
  viewportWidth: number
  coordinateScale?: number
}): QueuedMessageMenuPlacement {
  const scale = Number.isFinite(coordinateScale) && coordinateScale > 0 ? coordinateScale : 1
  const height = 48
  const width = Math.min(176, Math.max(1, viewportWidth / scale - 16))
  const left = Math.min(Math.max(8, anchorRect.right / scale - width), Math.max(8, viewportWidth / scale - 8 - width))
  const below = anchorRect.bottom / scale + 6
  const top = below + height <= viewportHeight / scale - 8 ? below : Math.max(8, anchorRect.top / scale - 6 - height)
  return { left, top, width }
}

export type QueuedComposerMessage = {
  id: string
  text: string
  deliveryState?: 'pending' | 'paused' | 'starting' | 'in_flight' | 'failed'
  deliveryTurnId?: string
  deliveryUserMessageItemId?: string
  displayText?: string
  errorCode?: string
  errorMessage?: string
  guidanceEligible?: boolean
  mode?: string
  attachmentIds?: readonly string[]
  attachments?: readonly { name?: string; kind?: 'image' | 'document' }[]
  fileReferences?: readonly unknown[]
  composerContexts?: readonly unknown[]
  guiPlan?: unknown
  guiDesignCanvas?: boolean
  guiDesignMode?: boolean
  guiDesignArtifact?: unknown
  writeContext?: unknown
}

export function canGuideQueuedComposerMessage(message: QueuedComposerMessage): boolean {
  return queuedMessageGuidancePayload(message) !== null
}

export function canEditQueuedComposerMessage(message: QueuedComposerMessage): boolean {
  const displayText = message.displayText?.trim()
  return Boolean(
    message.text.trim() &&
    (!displayText || displayText === message.text.trim()) &&
    message.guidanceEligible !== false &&
    message.mode !== 'plan' &&
    !message.attachmentIds?.length && !message.attachments?.length &&
    !message.fileReferences?.length && !message.composerContexts?.length &&
    !message.guiPlan && !message.guiDesignCanvas && !message.guiDesignMode &&
    !message.guiDesignArtifact && !message.writeContext &&
    message.deliveryState !== 'starting' && message.deliveryState !== 'in_flight'
  )
}

function displayTextFor(message: QueuedComposerMessage): string {
  const displayText = message.displayText?.trim()
  if (displayText) return displayText
  if (message.writeContext) {
    const userInput = parseWritePromptForDisplay(message.text)?.userInput.trim()
    if (userInput) return userInput
  }
  return message.text
}

type Props = {
  messages: QueuedComposerMessage[]
  running?: boolean
  guidanceTarget?: 'turn' | 'graph'
  onRemove: (id: string) => void
  onGuide?: (id: string) => void | Promise<unknown>
  onEdit?: (id: string, text: string) => boolean | void
  onReorder?: (id: string, targetId: string, position: 'before' | 'after') => void
}

export function FloatingComposerQueuedMessages({
  messages,
  running = false,
  guidanceTarget = 'turn',
  onRemove,
  onGuide,
  onEdit
}: Props): ReactElement | null {
  const { t } = useTranslation('common')
  const visible = messages.filter((message) =>
    !message.deliveryState || message.deliveryState === 'pending' ||
    message.deliveryState === 'paused' || message.deliveryState === 'failed'
  )
  const [collapsed, setCollapsed] = useState(true)
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const listId = useId()
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (visible.length === 0) setCollapsed(true)
    if (editing && !visible.some((message) => message.id === editing.id)) setEditing(null)
  }, [editing, visible])
  useEffect(() => { inputRef.current?.focus() }, [editing?.id])

  if (visible.length === 0) return null
  const interactionActive = editing !== null || busyId !== null
  const expanded = visible.length === 1 || !collapsed || interactionActive

  const saveEdit = (): void => {
    if (!editing || !editing.text.trim() || !onEdit) return
    const accepted = (onEdit as (id: string, text: string) => boolean | void)(editing.id, editing.text)
    if (accepted !== false) setEditing(null)
  }
  const guide = async (id: string): Promise<void> => {
    if (!onGuide || busyId) return
    setBusyId(id)
    try {
      await onGuide(id)
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div
      data-composer-attached-dock="queue"
      data-composer-stack-item="queue"
      className="pointer-events-auto relative z-20 mx-4 -mb-[3px] overflow-hidden rounded-t-xl border border-b-0 border-ds-border bg-ds-subtle shadow-sm"
    >
      {visible.length > 1 ? (
        <button
          type="button"
          className="flex h-9 w-full items-center gap-2.5 px-3 text-left text-[13px] font-medium text-ds-ink transition-colors hover:bg-ds-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/30 disabled:cursor-default"
          aria-controls={listId}
          aria-expanded={expanded}
          disabled={interactionActive}
          onClick={() => setCollapsed((value) => !value)}
        >
          <ListPlus className="h-3.5 w-3.5 shrink-0 text-ds-faint" strokeWidth={1.9} />
          <span className="min-w-0 flex-1">{t('queuedMessagesTitle', { count: visible.length })}</span>
          {expanded
            ? <ChevronDown className="h-3.5 w-3.5 text-ds-faint" aria-hidden />
            : <ChevronUp className="h-3.5 w-3.5 text-ds-faint" aria-hidden />}
        </button>
      ) : null}
      <ul id={listId} hidden={!expanded} className="max-h-[180px] overflow-y-auto p-0.5">
        {expanded && visible.map((message) => {
          const rowBusy = busyId === message.id
          const editable = Boolean(onEdit && canEditQueuedComposerMessage(message))
          const resumable = message.deliveryState === 'paused' || message.deliveryState === 'failed'
          const canSteer = resumable ? !running : running && canGuideQueuedComposerMessage(message)
          const imageCount = message.attachments?.filter((item) => item.kind !== 'document').length
            ?? message.attachmentIds?.length ?? 0
          return (
            <li key={message.id} className="flex min-h-9 items-center gap-2.5 rounded-lg px-2.5 py-1 text-[13px] text-ds-ink [&+&]:border-t [&+&]:border-ds-border-muted">
              {visible.length === 1 ? <ListPlus className="h-3.5 w-3.5 shrink-0 text-ds-faint" aria-hidden /> : null}
              {editing?.id === message.id ? (
                <input
                  ref={inputRef}
                  value={editing.text}
                  aria-label={t('queuedMessageEdit')}
                  onChange={(event) => setEditing({ id: message.id, text: event.currentTarget.value })}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') setEditing(null)
                    if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                      event.preventDefault()
                      saveEdit()
                    }
                  }}
                  className="h-7 min-w-0 flex-1 rounded-md border border-ds-border bg-ds-card px-2 text-[13px] text-ds-ink outline-none focus:border-accent/50 focus:ring-1 focus:ring-accent/20"
                />
              ) : (
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate text-ds-muted">{displayTextFor(message)}</span>
                    {imageCount > 0 ? <span className="flex shrink-0 items-center gap-1 text-[11px] text-ds-faint"><ImageIcon className="h-3 w-3" />{imageCount}</span> : null}
                  </div>
                  {resumable ? <div className="text-[11px] text-ds-faint">{message.errorMessage || t('queuedMessagePaused')}</div> : null}
                </div>
              )}
              <div className="flex shrink-0 items-center gap-1">
                {editing?.id === message.id ? (
                  <>
                    <button type="button" onClick={saveEdit} disabled={!editing.text.trim()} className="grid h-7 w-7 place-items-center rounded-full text-ds-faint transition hover:bg-ds-hover hover:text-ds-ink disabled:opacity-40" aria-label={t('queuedMessageSave')} title={t('queuedMessageSave')}><Check className="h-3.5 w-3.5" /></button>
                    <button type="button" onClick={() => setEditing(null)} className="grid h-7 w-7 place-items-center rounded-full text-ds-faint transition hover:bg-ds-hover hover:text-ds-ink" aria-label={t('queuedMessageCancelEdit')} title={t('queuedMessageCancelEdit')}><X className="h-3.5 w-3.5" /></button>
                  </>
                ) : (
                  <>
                    <button type="button" disabled={!editable || busyId !== null} onClick={() => editable && setEditing({ id: message.id, text: message.text })} className="grid h-7 w-7 place-items-center rounded-full text-ds-faint transition hover:bg-ds-hover hover:text-ds-ink disabled:opacity-40" aria-label={t('queuedMessageEdit')} title={editable ? t('queuedMessageEdit') : t('queuedMessageEditUnsupported')}><Pencil className="h-3.5 w-3.5" /></button>
                    {onGuide ? <button type="button" disabled={!canSteer || busyId !== null} onClick={() => void guide(message.id)} className="grid h-7 w-7 place-items-center rounded-full text-ds-faint transition hover:bg-ds-hover hover:text-ds-ink disabled:opacity-40" aria-label={rowBusy ? t('guideQueuedMessagePending') : t('guideQueuedMessage')} title={canSteer ? t(guidanceTarget === 'graph' ? 'guideQueuedMessageGraphHint' : 'guideQueuedMessageHint') : t('guideQueuedMessageNoActiveTurn')}>{rowBusy ? <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" /> : <CornerDownRight className="h-3.5 w-3.5" />}</button> : null}
                    <button type="button" disabled={busyId !== null} onClick={() => onRemove(message.id)} className="grid h-7 w-7 place-items-center rounded-full text-ds-faint transition hover:bg-ds-hover hover:text-ds-ink disabled:opacity-40" aria-label={t('queuedMessageRemove')} title={t('queuedMessageRemove')}><Trash2 className="h-3.5 w-3.5" /></button>
                  </>
                )}
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
