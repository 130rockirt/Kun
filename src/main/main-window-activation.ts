export interface ActivatableMainWindow {
  isDestroyed(): boolean
}

export class MainWindowActivationCoordinator {
  private pendingReveal = false

  constructor(
    private readonly getWindow: () => ActivatableMainWindow | null,
    private readonly reveal: () => void
  ) {}

  requestReveal(): void {
    const window = this.getWindow()
    if (!window || window.isDestroyed()) {
      this.pendingReveal = true
      return
    }
    this.pendingReveal = false
    this.reveal()
  }

  windowAvailable(): void {
    if (!this.pendingReveal) return
    this.pendingReveal = false
    this.requestReveal()
  }

  hasPendingReveal(): boolean {
    return this.pendingReveal
  }
}
