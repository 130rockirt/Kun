import type { BrowserWindow } from 'electron'
import type { DesktopStartupPhase } from '../shared/desktop-startup-state'

type MainWindowState = Pick<BrowserWindow, 'isDestroyed'> & {
  webContents: Pick<BrowserWindow['webContents'], 'isDestroyed' | 'send'>
}

const NORMAL_TRANSITIONS: Record<DesktopStartupPhase, readonly DesktopStartupPhase[]> = {
  bootstrapping: ['runtime_handoff', 'recovery_required'],
  runtime_handoff: ['runtime_starting', 'recovery_required'],
  runtime_starting: ['ready', 'recovery_required'],
  ready: [],
  recovery_required: []
}

export class DesktopStartupState {
  private phaseValue: DesktopStartupPhase = 'bootstrapping'

  constructor(private readonly getMainWindow: () => MainWindowState | null) {}

  get phase(): DesktopStartupPhase {
    return this.phaseValue
  }

  isReady(): boolean {
    return this.phaseValue === 'ready'
  }

  transition(next: DesktopStartupPhase): void {
    if (next === this.phaseValue) return
    if (!NORMAL_TRANSITIONS[this.phaseValue].includes(next)) {
      throw new Error(`Invalid desktop startup transition: ${this.phaseValue} -> ${next}`)
    }
    this.phaseValue = next
    this.publish()
  }

  assertReady(): void {
    if (this.isReady()) return
    throw new Error(`Kun desktop startup is not ready (phase: ${this.phaseValue}).`)
  }

  publish(): void {
    const window = this.getMainWindow()
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return
    window.webContents.send('startup:state', this.phaseValue)
  }
}
