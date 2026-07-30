import { describe, expect, it } from 'vitest'
import { sanitizeTerminalText } from './layout.js'
import {
  codeFenceLanguage,
  highlightTerminalCode,
  normalizeTerminalCodeFences,
  terminalAssistantMarkdown
} from './markdown-code.js'

describe('terminal Markdown code blocks', () => {
  it('normalizes language aliases used by common assistant fences', () => {
    expect(codeFenceLanguage('ts title=demo')).toBe('typescript')
    expect(codeFenceLanguage('C++')).toBe('cpp')
    expect(codeFenceLanguage('unknown-lang')).toBe('unknown-lang')
  })

  it('highlights supported languages and preserves escaped code text', () => {
    const rendered = highlightTerminalCode('const value = "<tag>"', 'typescript').join('\n')
    expect(rendered).toContain('\x1b[')
    expect(sanitizeTerminalText(rendered)).toBe('const value = "<tag>"')
  })

  it('uses unchanged plain text for untagged and unsupported languages', () => {
    const code = 'alpha < beta && gamma > delta'
    expect(highlightTerminalCode(code)).toEqual([code])
    expect(highlightTerminalCode(code, 'made-up-language')).toEqual([code])
  })

  it('labels only bare opening fences and preserves closing fences', () => {
    expect(normalizeTerminalCodeFences([
      '```',
      'const value = 1',
      '```',
      '',
      '~~~',
      'plain',
      '~~~'
    ].join('\n'))).toBe([
      '```text',
      'const value = 1',
      '```',
      '',
      '~~~text',
      'plain',
      '~~~'
    ].join('\n'))
  })

  it('puts the streaming cursor inside partial code but after a fence-only line', () => {
    expect(terminalAssistantMarkdown('```ts', true)).toBe('```ts\n▍')
    expect(terminalAssistantMarkdown('```ts\nconst value = 1', true)).toBe('```ts\nconst value = 1 ▍')
    expect(terminalAssistantMarkdown('```ts\nconst value = 1\n```', true))
      .toBe('```ts\nconst value = 1\n```\n▍')
  })
})
