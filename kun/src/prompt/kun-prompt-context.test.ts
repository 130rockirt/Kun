import { describe, expect, it } from 'vitest'
import {
  buildKunTurnContextInstructions,
  buildPersonaBlockContent
} from './kun-prompt-context.js'

describe('buildPersonaBlockContent', () => {
  it('states that the persona governs style but not capability', () => {
    const content = buildPersonaBlockContent('Be skeptical.')
    expect(content).toContain('Be skeptical.')
    expect(content).toContain('does not change which tools exist')
  })

  it('trims the persona body', () => {
    expect(buildPersonaBlockContent('  Be terse.  ')).toContain('\nBe terse.')
  })
})

describe('persona rendered as a turn context block', () => {
  it('renders with user authority and a persona kind', () => {
    const instructions = buildKunTurnContextInstructions([
      { kind: 'persona', authority: 'user', content: buildPersonaBlockContent('Be skeptical.') }
    ])
    const rendered = instructions.join('\n')
    expect(rendered).toContain('<kun_context_block kind="persona" authority="user">')
    expect(rendered).toContain('Be skeptical.')
  })

  it('emits nothing for blank content, so an unset persona costs no tokens', () => {
    expect(buildKunTurnContextInstructions([
      { kind: 'persona', authority: 'user', content: '   ' }
    ])).toEqual([])
  })
})
