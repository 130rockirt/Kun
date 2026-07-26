import { describe, expect, it } from 'vitest'
import { cellWidth, sanitizeTerminalText, truncateCells, wrapText } from './layout.js'

describe('terminal cell layout', () => {
  it('measures and wraps CJK, emoji, and combining text by cells', () => {
    expect(cellWidth('a你😀e\u0301')).toBe(6)
    expect(cellWidth('👩‍💻')).toBe(2)
    expect(wrapText('ab你cd', 4)).toEqual(['ab你', 'cd'])
    expect(wrapText('a👩‍💻b', 3)).toEqual(['a👩‍💻', 'b'])
    expect(truncateCells('abc你def', 6)).toBe('abc你…')
  })

  it('strips hostile control and ANSI sequences from model content', () => {
    expect(sanitizeTerminalText(
      'safe\x1b[2Jbad\x00text' +
      '\x1b]52;c;clipboard\x07' +
      '\x1bP1;2|device-control\x1b\\' +
      '\x1b_application-command\x1b\\'
    )).toBe('safebadtext')
  })
})
