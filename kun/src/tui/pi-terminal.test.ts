import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import {
  InlineStreamTerminal,
  ScrollbackPreservingTerminal,
  stripMouseTrackingEnable,
  stripScrollbackErase,
  type TerminalInput,
  type TerminalOutput
} from './pi-terminal.js'

describe('InlineStreamTerminal', () => {
  it('restores raw mode and never enters the alternate screen', () => {
    const input = Object.assign(new EventEmitter(), {
      isRaw: false,
      setRawMode: vi.fn(),
      setEncoding: vi.fn(),
      resume: vi.fn(),
      pause: vi.fn()
    }) as unknown as TerminalInput
    let outputText = ''
    const output = Object.assign(new EventEmitter(), {
      columns: 100,
      rows: 30,
      write: (chunk: string) => { outputText += chunk }
    }) as unknown as TerminalOutput
    const terminal = new InlineStreamTerminal(input, output)

    terminal.start(vi.fn(), vi.fn())
    terminal.stop()

    expect(input.setRawMode).toHaveBeenNthCalledWith(1, true)
    expect(input.setRawMode).toHaveBeenNthCalledWith(2, false)
    expect(outputText).not.toContain('\x1b[?1049h')
    expect(outputText).not.toContain('\x1b[?1049l')
    expect(outputText).toContain('\x1b[?2004h')
    expect(outputText).toContain('\x1b[?2004l')
  })

  it('preserves native scrollback when pi-tui requests a full viewport redraw', () => {
    const input = Object.assign(new EventEmitter(), {
      isRaw: false, setRawMode: vi.fn(), setEncoding: vi.fn(), resume: vi.fn(), pause: vi.fn()
    }) as unknown as TerminalInput
    let outputText = ''
    const output = Object.assign(new EventEmitter(), {
      columns: 80, rows: 24, write: (chunk: string) => { outputText += chunk }
    }) as unknown as TerminalOutput
    const terminal = new ScrollbackPreservingTerminal(new InlineStreamTerminal(input, output))

    terminal.write(`before\x1b[2J\x1b[H\x1b[3Jafter`)

    expect(outputText).toBe(`before\x1b[2J\x1b[Hafter`)
    expect(stripScrollbackErase('safe text')).toBe('safe text')
    expect(outputText).not.toContain('\x1b[3J')
  })

  it('blocks implicit mouse capture until pointer mode explicitly allows it', () => {
    const input = Object.assign(new EventEmitter(), {
      isRaw: false, setRawMode: vi.fn(), setEncoding: vi.fn(), resume: vi.fn(), pause: vi.fn()
    }) as unknown as TerminalInput
    let outputText = ''
    const output = Object.assign(new EventEmitter(), {
      columns: 80, rows: 24, write: (chunk: string) => { outputText += chunk }
    }) as unknown as TerminalOutput
    const terminal = new ScrollbackPreservingTerminal(new InlineStreamTerminal(input, output))

    terminal.write('\x1b[?1000h\x1b[?1006hdefault')
    expect(outputText).toBe('default')

    terminal.setMouseTrackingAllowed(true)
    terminal.write('\x1b[?1000h\x1b[?1006hpointer')
    expect(outputText).toContain('\x1b[?1000h\x1b[?1006hpointer')
    expect(stripMouseTrackingEnable('\x1b[?1002h\x1b[?1003h')).toBe('')
  })
})
