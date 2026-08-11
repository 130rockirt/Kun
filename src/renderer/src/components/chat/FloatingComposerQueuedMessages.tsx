import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement
} from 'react'
import {
  CornerDownRight,
  GripVertical,
  ImageIcon,
  ListPlus,
  Loader2,
  MoreHorizontal,
  Pencil,
  Trash2
} from 'lucide-react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { queuedMessageGuidancePayload } from '../../store/queued-message-guidance'

const QUEUED_MENU_WIDTH = 176
const QUEUED_MENU_HEIGHT = 48
const QUEUED_MENU_MARGIN = 8
const QUEUED_MENU_GAP = 6

export type QueuedMessageMenuPlacement = {
  left: number
  top: number
  width: number
}

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
  const normalizedViewportHeight = viewportHeight / scale
  const normalizedViewportWidth = viewportWidth / scale
  const normalizedRight = anchorRect.right / scale
  const normalizedTop = anchorRect.top / scale
  const normalizedBottom = anchorRect.bottom / scale
  const width = Math.min(
    QUEUED_MENU_WIDTH,
    Math.max(1, normalizedViewportWidth - QUEUED_MENU_MARGIN * 2)
  )
  const left = Math.min(
    Math.max(QUEUED_MENU_MARGIN, normalizedRight - width),
    Math.max(QUEUED_MENU_MARGIN, normalizedViewportWidth - QUEUED_MENU_MARGIN - width)
  )
  const belowTop = normalizedBottom + QUEUED_MENU_GAP
  const top = belowTop + QUEUED_MENU_HEIGHT <= normalizedViewportHeight - QUEUED_MENU_MARGIN
    ? belowTop
    : Math.max(QUEUED_MENU_MARGIN, normalizedTop - QUEUED_MENU_GAP - QUEUED_MENU_HEIGHT)
  return { left, top, width }
}

function currentBodyZoom(): number {
  if (typeof window === 'undefined') return 1
  const parsed = Number.parseFloat(window.getComputedStyle(document.body).zoom)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1
}

export type QueuedComposerMessage = {
  id: string
  text: string
  deliveryState?: 'pending' | 'paused' | 'starting' | 'in_flight'
  deliveryTurnId?: string
  deliveryUserMessageItemId?: string
  displayText?: string
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

/** True when the steer contract can preserve the whole queued payload. */
export function canGuideQueuedComposerMessage(message: QueuedComposerMessage): boolean {
  return queuedMessageGuidancePayload(message) !== null
}

/** Editing dequeues the item, so only payloads that can be fully restored as text are eligible. */
export function canEditQueuedComposerMessage(message: QueuedComposerMessage): boolean {
  return Boolean(
    message.guidanceEligible !== false &&
    message.mode !== 'plan' &&
    !message.attachmentIds?.length &&
    !message.attachments?.length &&
    canGuideQueuedComposerMessage(message)
  )
}

type Props = {
  messages: QueuedComposerMessage[]
  guidanceTarget?: 'turn' | 'graph'
  onRemove: (id: string) => void
  onGuide?: (id: string) => void | Promise<unknown>
  onEdit?: (message: QueuedComposerMessage) => void
  onReorder?: (id: string, targetId: string, position: 'before' | 'after') => void
}

export function FloatingComposerQueuedMessages({
  messages,
  guidanceTarget = 'turn',
  onRemove,
  onGuide,
  onEdit,
  onReorder
}: Props): ReactElement | null {
  const { t } = useTranslation('common')
  const visibleMessages = messages.filter(
    (message) => !message.deliveryState || message.deliveryState === 'pending' || message.deliveryState === 'paused'
  )
  const rootRef = useRef<HTMLDivElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const menuButtonRefs = useRef(new Map<string, HTMLButtonElement>())
  const guidingIdsRef = useRef(new Set<string>())
  const [guidingIds, setGuidingIds] = useState<Set<string>>(() => new Set())
  const [openMenuId, setOpenMenuId] = useState<string | null>(null)
  const [menuPlacement, setMenuPlacement] = useState<QueuedMessageMenuPlacement | null>(null)
  const [draggedMessageId, setDraggedMessageId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<{
    id: string
    position: 'before' | 'after'
  } | null>(null)

  useEffect(() => {
    if (!openMenuId || typeof window === 'undefined') return
    const closeOnOutsidePointer = (event: PointerEvent): void => {
      const target = event.target
      if (target instanceof Node && (
        rootRef.current?.contains(target) || menuRef.current?.contains(target)
      )) return
      setOpenMenuId(null)
    }
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpenMenuId(null)
    }
    window.addEventListener('pointerdown', closeOnOutsidePointer)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      window.removeEventListener('pointerdown', closeOnOutsidePointer)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [openMenuId])

  useEffect(() => {
    if (!openMenuId || typeof window === 'undefined') {
      setMenuPlacement(null)
      return
    }
    const updatePlacement = (): void => {
      const button = menuButtonRefs.current.get(openMenuId)
      if (!button) return
      setMenuPlacement(calculateQueuedMessageMenuPlacement({
        anchorRect: button.getBoundingClientRect(),
        viewportHeight: window.innerHeight,
        viewportWidth: window.innerWidth,
        coordinateScale: currentBodyZoom()
      }))
    }
    updatePlacement()
    const frame = window.requestAnimationFrame(updatePlacement)
    window.addEventListener('resize', updatePlacement)
    window.addEventListener('scroll', updatePlacement, true)
    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener('resize', updatePlacement)
      window.removeEventListener('scroll', updatePlacement, true)
    }
  }, [openMenuId])

  if (visibleMessages.length === 0) return null

  const guide = async (id: string): Promise<void> => {
    if (!onGuide || guidingIdsRef.current.has(id)) return
    guidingIdsRef.current.add(id)
    setGuidingIds(new Set(guidingIdsRef.current))
    try {
      await onGuide(id)
    } finally {
      guidingIdsRef.current.delete(id)
      setGuidingIds(new Set(guidingIdsRef.current))
    }
  }

  const clearDragState = (): void => {
    setDraggedMessageId(null)
    setDropTarget(null)
  }

  const dragOverMessage = (
    event: ReactDragEvent<HTMLDivElement>,
    targetId: string
  ): void => {
    if (!draggedMessageId || draggedMessageId === targetId || !onReorder) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    const rect = event.currentTarget.getBoundingClientRect()
    const position = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
    setDropTarget((current) => current?.id === targetId && current.position === position
      ? current
      : { id: targetId, position })
  }

  const dropMessage = (
    event: ReactDragEvent<HTMLDivElement>,
    targetId: string
  ): void => {
    if (!draggedMessageId || draggedMessageId === targetId || !onReorder) {
      clearDragState()
      return
    }
    event.preventDefault()
    const position = dropTarget?.id === targetId ? dropTarget.position : 'before'
    onReorder(draggedMessageId, targetId, position)
    clearDragState()
  }

  const moveMessageWithKeyboard = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    messageId: string,
    messageIndex: number
  ): void => {
    if (!onReorder) return
    if (event.key === 'ArrowUp' && messageIndex > 0) {
      event.preventDefault()
      onReorder(messageId, visibleMessages[messageIndex - 1]!.id, 'before')
    } else if (event.key === 'ArrowDown' && messageIndex < visibleMessages.length - 1) {
      event.preventDefault()
      onReorder(messageId, visibleMessages[messageIndex + 1]!.id, 'after')
    }
  }

  const openMenuMessage = openMenuId
    ? visibleMessages.find((message) => message.id === openMenuId) ?? null
    : null
  const menuStyle: CSSProperties = menuPlacement
    ? {
        left: `${menuPlacement.left}px`,
        top: `${menuPlacement.top}px`,
        width: `${menuPlacement.width}px`
      }
    : {
        left: 0,
        top: 0,
        width: `${QUEUED_MENU_WIDTH}px`,
        visibility: 'hidden'
      }
  const editMenu = openMenuMessage && onEdit && canEditQueuedComposerMessage(openMenuMessage) ? (
    <div
      ref={menuRef}
      role="menu"
      data-queued-message-menu
      style={menuStyle}
      className="ds-no-drag fixed z-[1000] overflow-hidden rounded-[16px] border border-ds-border bg-white p-1.5 text-[13px] text-ds-ink shadow-[0_18px_48px_rgba(20,47,95,0.16)] dark:bg-ds-card"
    >
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          setOpenMenuId(null)
          onEdit(openMenuMessage)
        }}
        className="flex h-9 w-full items-center gap-2 rounded-xl px-2.5 text-left font-medium transition hover:bg-ds-hover"
      >
        <Pencil className="h-3.5 w-3.5 shrink-0" strokeWidth={1.8} />
        <span>{t('queuedMessageEdit')}</span>
      </button>
    </div>
  ) : null

  return (
    <>
      <div
        ref={rootRef}
        data-composer-queue
        className="w-full space-y-2"
        aria-label={t('queuedMessagesTitle', { count: visibleMessages.length })}
      >
        {visibleMessages.map((message, messageIndex) => {
          const guiding = guidingIds.has(message.id)
          const guidanceEligible =
            message.guidanceEligible !== false && canGuideQueuedComposerMessage(message)
          const paused = message.deliveryState === 'paused'
          const guideLabel = paused
            ? t('sendPausedQueuedMessage')
            : guidanceTarget === 'graph'
              ? t('guideQueuedMessageGraph')
              : t('guideQueuedMessage')
          const guideTitle = paused
            ? t('sendPausedQueuedMessage')
            : guidanceEligible
              ? guidanceTarget === 'graph'
                ? t('guideQueuedMessageGraphHint')
                : t('guideQueuedMessageHint')
              : t('guideQueuedMessageTextOnly')
          const editMessage = onEdit && canEditQueuedComposerMessage(message) ? onEdit : null
          const imageAttachments = message.attachments?.filter(
            (attachment) => attachment.kind !== 'document'
          ) ?? []
          const imageCount = imageAttachments.length > 0
            ? imageAttachments.length
            : message.attachments?.length
              ? 0
              : message.attachmentIds?.length ?? 0
          const imageNames = imageAttachments
            ?.map((attachment) => attachment.name?.trim())
            .filter((name): name is string => Boolean(name)) ?? []
          const canReorder = Boolean(onReorder && visibleMessages.length > 1 && !guiding)
          const messageDropTarget = dropTarget?.id === message.id ? dropTarget : null
          return (
            <div
              key={message.id}
              data-queued-message-id={message.id}
              onDragOver={(event) => dragOverMessage(event, message.id)}
              onDrop={(event) => dropMessage(event, message.id)}
              className={`group relative flex min-h-12 min-w-0 items-center gap-2 rounded-[20px] border border-ds-border bg-white/92 px-3 py-2 shadow-[0_8px_26px_rgba(20,47,95,0.07)] backdrop-blur-xl transition-[opacity,transform] dark:bg-ds-card/94 ${draggedMessageId === message.id ? 'opacity-60' : ''}`}
            >
              {messageDropTarget ? (
                <span
                  data-queued-message-drop-indicator={messageDropTarget.position}
                  className={`pointer-events-none absolute left-4 right-4 z-10 h-0.5 rounded-full bg-ds-ink ${messageDropTarget.position === 'before' ? '-top-[5px]' : '-bottom-[5px]'}`}
                  aria-hidden="true"
                />
              ) : null}
              {canReorder ? (
                <button
                  type="button"
                  draggable
                  data-queued-message-drag-handle
                  onDragStart={(event) => {
                    setOpenMenuId(null)
                    setDraggedMessageId(message.id)
                    event.dataTransfer.effectAllowed = 'move'
                    event.dataTransfer.setData('text/plain', message.id)
                  }}
                  onDragEnd={clearDragState}
                  onKeyDown={(event) => moveMessageWithKeyboard(event, message.id, messageIndex)}
                  className="ds-no-drag flex h-7 w-7 shrink-0 cursor-grab items-center justify-center rounded-full text-ds-faint transition hover:bg-ds-hover hover:text-ds-ink active:cursor-grabbing"
                  aria-label={t('queuedMessageReorder')}
                  title={t('queuedMessageReorder')}
                >
                  <GripVertical className="h-4 w-4" strokeWidth={1.8} />
                </button>
              ) : (
                <span
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-ds-faint"
                  aria-hidden="true"
                >
                  <ListPlus className="h-4 w-4" strokeWidth={1.8} />
                </span>
              )}
              <div className="min-w-0 flex-1">
                <div className="truncate text-[14px] leading-5 text-ds-ink">
                  {message.displayText ?? message.text}
                </div>
                {imageCount > 0 ? (
                  <div
                    data-queued-message-images={imageCount}
                    className="mt-0.5 flex min-w-0 items-center gap-1 text-[11px] leading-4 text-ds-faint"
                    aria-label={`${t('composerImageOnlyDisplay')} (${imageCount})`}
                    title={imageNames.join(', ') || undefined}
                  >
                    <ImageIcon className="h-3 w-3 shrink-0" strokeWidth={1.8} />
                    <span>{imageCount}</span>
                    {imageNames[0] ? <span className="truncate">{imageNames[0]}</span> : null}
                  </div>
                ) : null}
                {paused ? (
                  <div className="truncate text-[11px] leading-4 text-ds-faint">
                    {t('queuedMessagePaused')}
                  </div>
                ) : guidanceTarget === 'graph' ? (
                  <div className="truncate text-[11px] leading-4 text-ds-faint">
                    {t('queuedMessageAfterGraph')}
                  </div>
                ) : null}
              </div>
              {onGuide ? (
                <button
                  type="button"
                  onClick={() => void guide(message.id)}
                  disabled={(!guidanceEligible && !paused) || guiding}
                  className="ds-no-drag inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[13px] font-medium text-ds-muted transition hover:bg-ds-hover hover:text-ds-ink disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent disabled:hover:text-ds-muted"
                  aria-label={guiding ? t('guideQueuedMessagePending') : guideLabel}
                  title={guiding ? t('guideQueuedMessagePending') : guideTitle}
                >
                  {guiding ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.9} />
                  ) : (
                    <CornerDownRight className="h-3.5 w-3.5" strokeWidth={1.9} />
                  )}
                  <span>{guiding ? t('guideQueuedMessagePending') : guideLabel}</span>
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => onRemove(message.id)}
                disabled={guiding}
                className="ds-no-drag flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-ds-faint transition hover:bg-ds-hover hover:text-ds-ink disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent"
                aria-label={t('queuedMessageRemove')}
                title={t('queuedMessageRemove')}
              >
                <Trash2 className="h-3.5 w-3.5" strokeWidth={1.8} />
              </button>
              {editMessage ? (
                <div className="shrink-0">
                  <button
                    ref={(node) => {
                      if (node) menuButtonRefs.current.set(message.id, node)
                      else menuButtonRefs.current.delete(message.id)
                    }}
                    type="button"
                    onClick={() => setOpenMenuId((current) => current === message.id ? null : message.id)}
                    disabled={guiding}
                    className="ds-no-drag flex h-8 w-8 items-center justify-center rounded-full text-ds-faint transition hover:bg-ds-hover hover:text-ds-ink disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent"
                    aria-label={t('queuedMessageMoreActions')}
                    title={t('queuedMessageMoreActions')}
                    aria-haspopup="menu"
                    aria-expanded={openMenuId === message.id}
                  >
                    <MoreHorizontal className="h-4 w-4" strokeWidth={1.8} />
                  </button>
                </div>
              ) : null}
            </div>
          )
        })}
      </div>
      {editMenu && typeof document !== 'undefined'
        ? createPortal(editMenu, document.body)
        : editMenu}
    </>
  )
}
