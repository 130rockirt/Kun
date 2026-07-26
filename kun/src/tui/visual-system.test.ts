import { describe, expect, it } from 'vitest'
import { stripAnsi } from './layout.js'
import {
  breadcrumb,
  contextualFooter,
  pageFrame,
  sectionLabel,
  selectionRow,
  statusGlyph,
  visualDensity
} from './visual-system.js'

describe('TUI visual system', () => {
  it('uses content-priority density breakpoints', () => {
    expect(visualDensity(120)).toBe('wide')
    expect(visualDensity(80)).toBe('compact')
    expect(visualDensity(52)).toBe('narrow')
  })

  it('renders breadcrumbs, rails, dividers and contextual actions without inverse rows', () => {
    const header = breadcrumb(['KUN', 'Sessions'], 50, '4 saved')
    const row = selectionRow('Fix provider routing', 'running · 2m', 50, true)
    const divider = sectionLabel('Today', 50)
    const footer = contextualFooter([
      { key: 'Enter', label: 'open' },
      { key: 'Esc', label: 'back' }
    ], 50)

    expect(stripAnsi(header)).toContain('KUN / Sessions')
    expect(stripAnsi(row)).toContain('│ Fix provider routing')
    expect(stripAnsi(divider)).toContain('Today')
    expect(stripAnsi(footer)).toContain('Enter open')
    expect([header, row, divider, footer].join('')).not.toContain('\x1b[7m')
  })

  it('builds a sparse page with one header and one contextual footer', () => {
    const lines = pageFrame({
      path: ['KUN', 'Models'],
      body: [selectionRow('gpt-5.6', 'current', 64, true)],
      footer: [{ key: 'Enter', label: 'select' }, { key: 'Esc', label: 'back' }],
      width: 64
    }).map(stripAnsi)
    expect(lines[0]).toContain('KUN / Models')
    expect(lines.filter((line) => line.includes('Enter select'))).toHaveLength(1)
    expect(lines.join('\n')).not.toContain('┌')
  })

  it('uses stable semantic status glyphs', () => {
    expect(stripAnsi(statusGlyph('running', 0))).toBe('◐')
    expect(stripAnsi(statusGlyph('success'))).toBe('✓')
    expect(stripAnsi(statusGlyph('failed'))).toBe('×')
  })

  it('keeps the full route identity before narrow secondary status', () => {
    const line = stripAnsi(breadcrumb(['KUN', 'Question', 'Release channel'], 48, 'Question 1 of 1'))
    expect(line).toContain('KUN / Question / Release channel')
    expect(line).not.toContain('Question 1 of 1')
  })

  it.each([120, 80, 42])('keeps selector, workflow and decision priorities at %i columns', (width) => {
    const lines = pageFrame({
      path: ['KUN', 'Connect', 'OAuth return'],
      right: 'Step 3/4',
      description: 'Return from the browser and paste the masked authorization value.',
      body: [
        sectionLabel('Authorization', width),
        selectionRow('••••••••', 'masked', width, true),
        ' ! The callback expired.'
      ],
      footer: [
        { key: 'Enter', label: 'submit' },
        { key: 'Esc', label: 'cancel' }
      ],
      width
    }).map(stripAnsi)

    expect(lines[0]).toContain('KUN / Connect / OAuth return')
    expect(lines.join('\n')).toContain('│ ••••••••')
    expect(lines.at(-1)).toContain('Enter submit')
    expect(lines.at(-1)).toContain('Esc cancel')
    expect(lines.every((line) => line.length <= width)).toBe(true)
  })
})
