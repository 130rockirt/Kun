/**
 * Tracks whether a Main-owned native dialog currently owns input.
 *
 * Native dialogs are modal to the window, so renderer surfaces that open on a
 * global chord must stay closed while one is up. The renderer cannot observe
 * Main's dialog queue directly, so callers that trigger a native dialog wrap
 * the call and this module answers the question for them.
 */
let openNativeDialogs = 0

export function isNativeDialogOpen(): boolean {
  return openNativeDialogs > 0
}

/** Marks a native dialog as owning input for the lifetime of `operation`. */
export async function withNativeDialog<T>(operation: () => Promise<T>): Promise<T> {
  openNativeDialogs += 1
  try {
    return await operation()
  } finally {
    openNativeDialogs = Math.max(0, openNativeDialogs - 1)
  }
}
