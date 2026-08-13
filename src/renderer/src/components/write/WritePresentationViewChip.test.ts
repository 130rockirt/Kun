import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import '../../i18n'
import { WritePresentationViewChip } from './WritePresentationViewChip'

describe('WritePresentationViewChip', () => {
  it('shows a non-removable presentation location', () => {
    const html = renderToStaticMarkup(createElement(WritePresentationViewChip, {
      view: {
        kind: 'presentation',
        path: '/workspace/deck.pptx',
        sourceName: 'deck.pptx',
        sourceFormat: 'pptx',
        sourceSha256: 'a'.repeat(64),
        slide: 3,
        slideCount: 9
      }
    }))

    expect(html).toContain('data-write-presentation-view="true"')
    expect(html).toContain('Current view')
    expect(html).toContain('deck.pptx')
    expect(html).toContain('Slide 3 of 9')
    expect(html).not.toContain('<button')
  })
})
