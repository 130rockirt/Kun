/**
 * Serializes Main-owned native dialogs for one Electron WebContents.
 *
 * Native dialogs are modal on Windows. Keeping a small, Main-owned queue
 * prevents independent Main-process flows from competing for the same parent
 * window. The queue also exposes an idle promise so callers that must reload a
 * WebContents can wait until a coordinated native dialog has finished first.
 */
type DialogState = {
  tail: Promise<void>
  pending: number
}

export class NativeDialogCoordinator {
  private readonly states = new WeakMap<object, DialogState>()

  async run<T>(owner: object, operation: () => Promise<T>): Promise<T> {
    const state = this.stateFor(owner)
    const previous = state.tail
    let release!: () => void
    const completed = new Promise<void>((resolve) => {
      release = resolve
    })

    state.pending += 1
    state.tail = previous.catch(() => undefined).then(() => completed)
    await previous.catch(() => undefined)
    try {
      return await operation()
    } finally {
      state.pending -= 1
      release()
    }
  }

  /**
   * Returns the current queue only while a dialog is active or queued. A
   * caller can use the value to defer destructive WebContents work without
   * adding any polling or timing assumptions around native dialogs.
   */
  deferUntilIdle(owner: object): Promise<void> | undefined {
    const state = this.states.get(owner)
    return state && state.pending > 0 ? state.tail : undefined
  }

  private stateFor(owner: object): DialogState {
    const existing = this.states.get(owner)
    if (existing) return existing
    const state: DialogState = { tail: Promise.resolve(), pending: 0 }
    this.states.set(owner, state)
    return state
  }
}
