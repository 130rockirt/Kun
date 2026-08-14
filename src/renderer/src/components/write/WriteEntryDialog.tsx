import type { FormEvent, ReactElement } from 'react'
import type { WorkspaceEntry } from '@shared/workspace-file'
import type { WorkWhiteboard } from '../../write/write-workspace-store'

export type WriteEntryDialogKind =
  | { kind: 'create-file'; parentDirectory?: string; value: string }
  | { kind: 'create-folder'; parentDirectory?: string; value: string }
  | { kind: 'rename'; entry: WorkspaceEntry; value: string }
  | { kind: 'delete'; entry: WorkspaceEntry }
  | { kind: 'rename-whiteboard'; board: WorkWhiteboard; value: string }
  | { kind: 'delete-whiteboard'; board: WorkWhiteboard }

export type WriteTranslate = (key: string, opts?: Record<string, unknown>) => string

function entryDialogTitle(dialog: WriteEntryDialogKind, t: WriteTranslate): string {
  if (dialog.kind === 'create-file') return t('writeCreateFile')
  if (dialog.kind === 'create-folder') return t('writeCreateFolder')
  if (dialog.kind === 'rename') return t('writeRenameEntry')
  if (dialog.kind === 'rename-whiteboard') return t('writeRenameEntry')
  if (dialog.kind === 'delete-whiteboard') return t('writeEntryDialogDelete')
  return dialog.entry.type === 'directory' ? t('writeDeleteFolder') : t('writeDeleteFile')
}

function entryDialogSubmitLabel(dialog: WriteEntryDialogKind, t: WriteTranslate): string {
  if (dialog.kind === 'rename' || dialog.kind === 'rename-whiteboard') return t('writeEntryDialogRename')
  if (dialog.kind === 'delete' || dialog.kind === 'delete-whiteboard') return t('writeEntryDialogDelete')
  return t('writeEntryDialogCreate')
}

function entryDialogDescription(dialog: WriteEntryDialogKind, t: WriteTranslate): string {
  if (dialog.kind === 'delete-whiteboard') {
    return t('writeDeleteWhiteboardConfirm', { name: dialog.board.title, defaultValue: `Delete “${dialog.board.title}”? Source documents and exported presentations will be kept.` })
  }
  if (dialog.kind === 'delete') {
    return dialog.entry.type === 'directory'
      ? t('writeDeleteFolderConfirm', { name: dialog.entry.name })
      : t('writeDeleteFileConfirm', { name: dialog.entry.name })
  }
  if (dialog.kind === 'rename' || dialog.kind === 'rename-whiteboard') return t('writeRenameEntryPrompt')
  if (dialog.kind === 'create-file') return t('writeCreateFilePrompt')
  return t('writeCreateFolderPrompt')
}

export function WriteEntryDialog({
  dialog,
  onClose,
  onValueChange,
  onSubmit,
  t
}: {
  dialog: WriteEntryDialogKind
  onClose: () => void
  onValueChange: (value: string) => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
  t: WriteTranslate
}): ReactElement {
  const deleting = dialog.kind === 'delete' || dialog.kind === 'delete-whiteboard'
  return (
    <div
      className="ds-no-drag fixed inset-0 z-[80] flex items-center justify-center bg-slate-950/18 px-4 backdrop-blur-[2px] dark:bg-black/35"
      onMouseDown={onClose}
    >
      <form
        onSubmit={onSubmit}
        onMouseDown={(event) => event.stopPropagation()}
        className="w-full max-w-sm rounded-[24px] border border-ds-border bg-ds-card p-5 shadow-[0_24px_72px_rgba(20,47,95,0.22)]"
      >
        <h2 className="text-[18px] font-semibold tracking-[-0.035em] text-ds-ink">
          {entryDialogTitle(dialog, t)}
        </h2>
        <p className="mt-2 text-[13px] leading-6 text-ds-muted">
          {entryDialogDescription(dialog, t)}
        </p>
        {!deleting ? (
          <input
            autoFocus
            value={dialog.value}
            onChange={(event) => onValueChange(event.target.value)}
            className="mt-4 w-full rounded-xl border border-ds-border bg-ds-main/65 px-3 py-2 text-[14px] text-ds-ink outline-none transition focus:border-accent/40 focus:ring-1 focus:ring-accent/25"
          />
        ) : null}
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl border border-ds-border bg-ds-card px-3 py-2 text-[13px] font-medium text-ds-muted transition hover:bg-ds-hover hover:text-ds-ink"
          >
            {t('writeEntryDialogCancel')}
          </button>
          <button
            type="submit"
            className={`rounded-xl px-3 py-2 text-[13px] font-semibold text-white transition hover:brightness-110 ${
              deleting ? 'bg-red-500' : 'bg-accent'
            }`}
          >
            {entryDialogSubmitLabel(dialog, t)}
          </button>
        </div>
      </form>
    </div>
  )
}
