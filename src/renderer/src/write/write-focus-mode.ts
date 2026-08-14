export function writeFocusModeShellClassName(active: boolean): string {
  return active
    ? 'write-document-shell write-focus-mode-shell ds-no-drag ds-titlebar-fixed-overlay fixed inset-x-0 bottom-0 top-0 z-[60] overflow-hidden bg-white p-3 dark:bg-ds-canvas sm:p-6'
    : 'write-document-shell min-w-0 flex-1 overflow-hidden bg-ds-card pb-3 sm:pb-4'
}

/** Keep Write-owned floating feedback above the z-60 focus shell and below dialogs. */
export function writeFocusModeFloatingLayerClassName(
  active: boolean,
  defaultLayer: 'z-40' | 'z-50'
): string {
  return active ? 'z-[65]' : defaultLayer
}

export function isWriteFocusModeFormControl(target: EventTarget | null): boolean {
  if (!target || typeof target !== 'object') return false
  const tagName = (target as { tagName?: unknown }).tagName
  if (typeof tagName !== 'string') return false
  return tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT'
}

export function isWriteFocusModeShortcut(
  event: Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey' | 'repeat' | 'isComposing' | 'defaultPrevented'>
): boolean {
  return event.code === 'KeyF' &&
    event.shiftKey &&
    (event.ctrlKey || event.metaKey) &&
    !event.altKey &&
    !event.repeat &&
    !event.isComposing &&
    !event.defaultPrevented
}
