import {
  type Dispatch,
  type MutableRefObject,
  type ReactElement,
  type RefObject,
  type SetStateAction
} from 'react'
import { createPortal } from 'react-dom'
import type { WorkspaceFileTarget } from '@shared/workspace-file'
import {
  fileNameFromPath,
  targetKey,
  type CachedTextDraft
} from './workspace-file-preview-support'

type Translate = (key: string, values?: Record<string, unknown>) => string
type TabMenu = { target: WorkspaceFileTarget; x: number; y: number }

type WorkspaceFilePreviewDialogsProps = {
  t: Translate
  tabMenu: TabMenu | null
  tabMenuRef: RefObject<HTMLDivElement | null>
  pinnedTargetKeySet: Set<string>
  onTogglePinnedTarget?: (target: WorkspaceFileTarget) => void
  setTabMenu: Dispatch<SetStateAction<TabMenu | null>>
  tabMenuTriggerRef: MutableRefObject<HTMLElement | null>
  onCloseOtherTargets?: (target: WorkspaceFileTarget) => void
  visibleTargets: WorkspaceFileTarget[]
  pendingCloseTarget: WorkspaceFileTarget | null
  setPendingCloseTarget: Dispatch<SetStateAction<WorkspaceFileTarget | null>>
  textDraftsRef: MutableRefObject<Map<string, CachedTextDraft>>
  setDirtyTargetKeys: Dispatch<SetStateAction<Set<string>>>
  onCloseTarget?: (target: WorkspaceFileTarget) => void
  savingText: boolean
  savePendingCloseTarget: () => Promise<void>
}

export function WorkspaceFilePreviewDialogs(props: WorkspaceFilePreviewDialogsProps): ReactElement {
  const {
    t,
    tabMenu,
    tabMenuRef,
    pinnedTargetKeySet,
    onTogglePinnedTarget,
    setTabMenu,
    tabMenuTriggerRef,
    onCloseOtherTargets,
    visibleTargets,
    pendingCloseTarget,
    setPendingCloseTarget,
    textDraftsRef,
    setDirtyTargetKeys,
    onCloseTarget,
    savingText,
    savePendingCloseTarget
  } = props
  return (
    <>
      {tabMenu && typeof document !== 'undefined' ? createPortal(
        <div
          ref={tabMenuRef}
          role="menu"
          aria-label={t('filePreviewTabActions')}
          className="fixed z-[10000] min-w-[184px] rounded-lg border border-ds-border bg-ds-card p-1 shadow-xl"
          style={{ left: tabMenu.x, top: tabMenu.y }}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
            event.preventDefault()
            const items = Array.from(
              event.currentTarget.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)')
            )
            if (items.length === 0) return
            const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement)
            const direction = event.key === 'ArrowDown' ? 1 : -1
            items[(currentIndex + direction + items.length) % items.length]?.focus()
          }}
        >
          {onTogglePinnedTarget ? (
            <button
              type="button"
              role="menuitemcheckbox"
              aria-checked={pinnedTargetKeySet.has(targetKey(tabMenu.target))}
              className="block w-full rounded-md px-2.5 py-2 text-left text-[12px] text-ds-ink hover:bg-ds-hover"
              onClick={() => {
                onTogglePinnedTarget(tabMenu.target)
                setTabMenu(null)
                window.requestAnimationFrame(() => tabMenuTriggerRef.current?.focus())
              }}
            >
              {pinnedTargetKeySet.has(targetKey(tabMenu.target))
                ? t('filePreviewUnpinTab')
                : t('filePreviewPinTab')}
            </button>
          ) : null}
          {onCloseOtherTargets ? (
            <button
              type="button"
              role="menuitem"
              disabled={visibleTargets.length < 2}
              className="block w-full rounded-md px-2.5 py-2 text-left text-[12px] text-ds-ink hover:bg-ds-hover disabled:cursor-default disabled:opacity-45"
              onClick={() => {
                onCloseOtherTargets(tabMenu.target)
                setTabMenu(null)
                window.requestAnimationFrame(() => tabMenuTriggerRef.current?.focus())
              }}
            >
              {t('filePreviewCloseOtherTabs')}
            </button>
          ) : null}
        </div>,
        document.body
      ) : null}
      {pendingCloseTarget && typeof document !== 'undefined' ? createPortal(
        <div className="fixed inset-0 z-[12000] flex items-center justify-center bg-black/20 p-4 backdrop-blur-[1px]">
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="workspace-file-dirty-close-title"
            className="w-full max-w-[380px] rounded-xl border border-ds-border bg-ds-card p-4 shadow-2xl"
          >
            <h2 id="workspace-file-dirty-close-title" className="text-[14px] font-semibold text-ds-ink">
              {t('filePreviewCloseDirtyTitle', { defaultValue: 'Save changes before closing?' })}
            </h2>
            <p className="mt-2 text-[12px] leading-5 text-ds-muted">
              {t('filePreviewCloseDirtyBody', {
                defaultValue: '{{file}} has unsaved changes.',
                file: fileNameFromPath(pendingCloseTarget.path)
              })}
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                className="rounded-lg px-3 py-1.5 text-[12px] text-ds-muted transition hover:bg-ds-hover hover:text-ds-ink"
                onClick={() => setPendingCloseTarget(null)}
              >
                {t('cancel')}
              </button>
              <button
                type="button"
                className="rounded-lg px-3 py-1.5 text-[12px] text-red-700 transition hover:bg-red-50 dark:text-red-300 dark:hover:bg-red-950/40"
                onClick={() => {
                  const item = pendingCloseTarget
                  const key = targetKey(item)
                  textDraftsRef.current.delete(key)
                  setDirtyTargetKeys((current) => {
                    const updated = new Set(current)
                    updated.delete(key)
                    return updated
                  })
                  setPendingCloseTarget(null)
                  onCloseTarget?.(item)
                }}
              >
                {t('filePreviewDiscardChanges', { defaultValue: 'Discard' })}
              </button>
              <button
                type="button"
                disabled={savingText}
                className="rounded-lg bg-accent px-3 py-1.5 text-[12px] font-semibold text-white transition hover:brightness-105 disabled:opacity-50"
                onClick={() => void savePendingCloseTarget()}
              >
                {savingText ? t('saving', { defaultValue: 'Saving…' }) : t('save', { defaultValue: 'Save' })}
              </button>
            </div>
          </div>
        </div>,
        document.body
      ) : null}
    </>
  )
}
