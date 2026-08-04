/** Owns application quit intent and single-flight managed-runtime shutdown. */
export class ManagedRuntimeShutdownCoordinator {
  private quitRequested = false
  private updateInstallQuit = false
  private updateInstallPrepared = false
  private storageRelocationQuit = false
  private stoppedForQuit = false
  private stopPromise: Promise<void> | null = null
  private stopIncludesUpdateIntent = false

  constructor(private readonly stopManagedRuntimes: () => Promise<void>) {}

  get isQuitRequested(): boolean {
    return this.quitRequested
  }

  get isUpdateInstallQuit(): boolean {
    return this.updateInstallQuit
  }

  get isStoppedForQuit(): boolean {
    return this.stoppedForQuit
  }

  get isQuitInProgress(): boolean {
    return this.quitRequested || this.updateInstallQuit || this.storageRelocationQuit
  }

  requestQuit(): void {
    this.quitRequested = true
  }

  setUpdateInstallQuit(active: boolean): void {
    if (this.updateInstallQuit === active) return
    this.updateInstallQuit = active
    if (!active) this.updateInstallPrepared = false
  }

  get isStorageRelocationQuit(): boolean {
    return this.storageRelocationQuit
  }

  setStorageRelocationQuit(active: boolean): void {
    this.storageRelocationQuit = active
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise
    const includesUpdateIntent = this.updateInstallQuit
    let tracked: Promise<void>
    tracked = this.stopManagedRuntimes().finally(() => {
      if (this.stopPromise === tracked) {
        this.stopPromise = null
        this.stopIncludesUpdateIntent = false
      }
    })
    this.stopPromise = tracked
    this.stopIncludesUpdateIntent = includesUpdateIntent
    return tracked
  }

  /**
   * Stop managed runtimes before an updater asks Electron to quit. Unlike a
   * normal quit this remains retryable: an updater can reject synchronously
   * after preflight, and the GUI must not be left in a terminal shutdown state.
   */
  async prepareForUpdate(): Promise<void> {
    this.setUpdateInstallQuit(true)
    if (this.updateInstallPrepared) return
    try {
      // A normal window-close stop may already be in flight. It started
      // without update intent, so wait for it and perform a second, explicit
      // update stop rather than treating it as sufficient for file unlocks.
      const activeStop = this.stopPromise
      if (activeStop && !this.stopIncludesUpdateIntent) await activeStop
      await this.stop()
      this.updateInstallPrepared = true
    } catch (error) {
      this.setUpdateInstallQuit(false)
      throw error
    }
  }

  async stopForQuit(): Promise<void> {
    this.requestQuit()
    if (this.stoppedForQuit) return
    try {
      // A successful update preflight already stopped the same resources. Do
      // not run it twice when Electron subsequently emits `before-quit`.
      if (!this.updateInstallPrepared) await this.stop()
    } finally {
      // Quit remains terminal even when one adapter reports a stop error: the
      // supervisor must never spawn a replacement child after this point.
      this.stoppedForQuit = true
    }
  }
}
