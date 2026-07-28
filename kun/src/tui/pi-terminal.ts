import type { Terminal } from '@earendil-works/pi-tui'

export type TerminalInput = NodeJS.ReadableStream & {
  isTTY?: boolean
  isRaw?: boolean
  setRawMode?(mode: boolean): unknown
  setEncoding?(encoding: BufferEncoding): unknown
  resume?(): unknown
  pause?(): unknown
}

export type TerminalOutput = {
  isTTY?: boolean
  columns?: number
  rows?: number
  write(chunk: string): unknown
  on?(event: 'resize', listener: () => void): unknown
  off?(event: 'resize', listener: () => void): unknown
}

/**
 * pi-tui's ProcessTerminal intentionally owns process.stdin/stdout. Tests and
 * embedders use this equivalent stream-backed terminal so the production app
 * can stay on pi-tui without giving up deterministic terminal tests.
 */
export class InlineStreamTerminal implements Terminal {
  private readonly wasRaw: boolean
  private inputHandler?: (data: string) => void
  private resizeHandler?: () => void

  constructor(
    private readonly input: TerminalInput,
    private readonly output: TerminalOutput
  ) {
    this.wasRaw = Boolean(input.isRaw)
  }

  get columns(): number { return this.output.columns ?? 80 }
  get rows(): number { return this.output.rows ?? 24 }
  get kittyProtocolActive(): boolean { return false }

  start(onInput: (data: string) => void, onResize: () => void): void {
    this.inputHandler = onInput
    this.resizeHandler = onResize
    this.input.setRawMode?.(true)
    this.input.setEncoding?.('utf8')
    this.input.resume?.()
    this.input.on('data', onInput)
    this.output.on?.('resize', onResize)
    this.write('\x1b[?2004h')
  }

  async drainInput(_maxMs = 1_000, _idleMs = 50): Promise<void> {
    // Synthetic streams have no Kitty key-release tail to drain.
  }

  stop(): void {
    this.write('\x1b[?2004l')
    if (this.inputHandler) this.input.off('data', this.inputHandler)
    if (this.resizeHandler) this.output.off?.('resize', this.resizeHandler)
    this.inputHandler = undefined
    this.resizeHandler = undefined
    this.input.setRawMode?.(this.wasRaw)
    if (!this.wasRaw) this.input.pause?.()
  }

  write(data: string): void { this.output.write(data) }
  moveBy(lines: number): void {
    if (lines > 0) this.write(`\x1b[${lines}B`)
    else if (lines < 0) this.write(`\x1b[${-lines}A`)
  }
  hideCursor(): void { this.write('\x1b[?25l') }
  showCursor(): void { this.write('\x1b[?25h') }
  clearLine(): void { this.write('\x1b[K') }
  clearFromCursor(): void { this.write('\x1b[J') }
  clearScreen(): void { this.write('\x1b[2J\x1b[H') }
  setTitle(title: string): void { this.write(`\x1b]0;${terminalTitle(title)}\x07`) }
  setProgress(_active: boolean): void {}
}

/**
 * pi-tui occasionally needs a full viewport redraw when changed rows have
 * scrolled above the visible window. Its upstream redraw sequence includes
 * CSI 3 J, which erases terminal scrollback in addition to repainting the
 * viewport. Kun is intentionally an inline application, so filter only that
 * destructive operation while forwarding every other terminal capability.
 */
export class ScrollbackPreservingTerminal implements Terminal {
  private mouseTrackingAllowed = false

  constructor(private readonly delegate: Terminal) {}

  get columns(): number { return this.delegate.columns }
  get rows(): number { return this.delegate.rows }
  get kittyProtocolActive(): boolean { return this.delegate.kittyProtocolActive }

  start(onInput: (data: string) => void, onResize: () => void): void { this.delegate.start(onInput, onResize) }
  stop(): void { this.delegate.stop() }
  drainInput(maxMs?: number, idleMs?: number): Promise<void> { return this.delegate.drainInput(maxMs, idleMs) }
  setMouseTrackingAllowed(allowed: boolean): void {
    this.mouseTrackingAllowed = allowed
  }

  write(data: string): void {
    const scrollbackSafe = stripScrollbackErase(data)
    this.delegate.write(this.mouseTrackingAllowed
      ? scrollbackSafe
      : stripMouseTrackingEnable(scrollbackSafe))
  }
  moveBy(lines: number): void { this.delegate.moveBy(lines) }
  hideCursor(): void { this.delegate.hideCursor() }
  showCursor(): void { this.delegate.showCursor() }
  clearLine(): void { this.delegate.clearLine() }
  clearFromCursor(): void { this.delegate.clearFromCursor() }
  clearScreen(): void { this.delegate.clearScreen() }
  setTitle(title: string): void { this.delegate.setTitle(title) }
  setProgress(active: boolean): void { this.delegate.setProgress(active) }
}

export function stripScrollbackErase(data: string): string {
  return data.replaceAll('\x1b[3J', '')
}

export function stripMouseTrackingEnable(data: string): string {
  return data.replace(/\x1b\[\?(?:1000|1002|1003|1006)h/gu, '')
}

function terminalTitle(value: string): string {
  return value.replace(new RegExp(String.raw`[\u0000-\u001F\u007F]`, 'gu'), '').slice(0, 120)
}
