const ANSI_PATTERN = new RegExp(String.raw`\u001B\[[0-?]*[ -/]*[@-~]`, 'g')
const TERMINAL_ESCAPE_PATTERN = new RegExp(
  String.raw`\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\)?|[P_^][\s\S]*?\u001B\\)`,
  'g'
)
const CONTROL_PATTERN = new RegExp(
  String.raw`[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u009B]`,
  'g'
)
const segmenter = typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  : undefined

export function cellWidth(value: string): number {
  let width = 0
  for (const grapheme of graphemes(stripAnsi(value))) {
    let graphemeWidth = 0
    let emojiPresentation = false
    for (const char of grapheme) {
    const point = char.codePointAt(0) ?? 0
      if (isControl(point) || isCombining(point) || isZeroWidth(point)) continue
      if (isEmoji(point)) emojiPresentation = true
      graphemeWidth = Math.max(graphemeWidth, isWide(point) ? 2 : 1)
    }
    width += emojiPresentation || grapheme.includes('\ufe0f') || grapheme.includes('\u20e3')
      ? 2
      : graphemeWidth
  }
  return width
}

export function truncateCells(value: string, width: number, suffix = '…'): string {
  if (width <= 0) return ''
  const plain = stripAnsi(value)
  if (cellWidth(plain) <= width) return plain
  const suffixWidth = cellWidth(suffix)
  const target = Math.max(0, width - suffixWidth)
  let output = ''
  let used = 0
  for (const grapheme of graphemes(plain)) {
    const next = cellWidth(grapheme)
    if (used + next > target) break
    output += grapheme
    used += next
  }
  return output + (suffixWidth <= width ? suffix : '')
}

export function padCells(value: string, width: number): string {
  const clipped = truncateCells(value, width, '')
  return clipped + ' '.repeat(Math.max(0, width - cellWidth(clipped)))
}

export function wrapText(value: string, width: number): string[] {
  const safeWidth = Math.max(1, width)
  const lines: string[] = []
  for (const sourceLine of sanitizeTerminalText(value).split('\n')) {
    if (!sourceLine) {
      lines.push('')
      continue
    }
    let line = ''
    let lineWidth = 0
    for (const grapheme of graphemes(sourceLine)) {
      const charWidth = cellWidth(grapheme)
      if (line && lineWidth + charWidth > safeWidth) {
        lines.push(line)
        line = ''
        lineWidth = 0
      }
      if (charWidth > safeWidth) continue
      line += grapheme
      lineWidth += charWidth
    }
    lines.push(line)
  }
  return lines.length ? lines : ['']
}

export function sanitizeTerminalText(value: string): string {
  return value
    .replaceAll('\r\n', '\n')
    .replaceAll('\r', '\n')
    .replace(TERMINAL_ESCAPE_PATTERN, '')
    .replace(CONTROL_PATTERN, '')
}

export function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, '')
}

function isControl(point: number): boolean {
  return point < 32 || (point >= 0x7f && point < 0xa0)
}

function isCombining(point: number): boolean {
  return (
    (point >= 0x0300 && point <= 0x036f) ||
    (point >= 0x1ab0 && point <= 0x1aff) ||
    (point >= 0x1dc0 && point <= 0x1dff) ||
    (point >= 0x20d0 && point <= 0x20ff) ||
    (point >= 0xfe20 && point <= 0xfe2f) ||
    point === 0xfe0f
  )
}

function isZeroWidth(point: number): boolean {
  return point === 0x200c || point === 0x200d || point === 0xfeff
}

function isEmoji(point: number): boolean {
  return (
    (point >= 0x1f1e6 && point <= 0x1faff) ||
    (point >= 0x2600 && point <= 0x27bf)
  )
}

function graphemes(value: string): string[] {
  return segmenter
    ? Array.from(segmenter.segment(value), (part) => part.segment)
    : Array.from(value)
}

function isWide(point: number): boolean {
  return (
    point >= 0x1100 && (
      point <= 0x115f ||
      point === 0x2329 || point === 0x232a ||
      (point >= 0x2e80 && point <= 0xa4cf && point !== 0x303f) ||
      (point >= 0xac00 && point <= 0xd7a3) ||
      (point >= 0xf900 && point <= 0xfaff) ||
      (point >= 0xfe10 && point <= 0xfe19) ||
      (point >= 0xfe30 && point <= 0xfe6f) ||
      (point >= 0xff00 && point <= 0xff60) ||
      (point >= 0xffe0 && point <= 0xffe6) ||
      (point >= 0x1f300 && point <= 0x1faff) ||
      (point >= 0x20000 && point <= 0x3fffd)
    )
  )
}
