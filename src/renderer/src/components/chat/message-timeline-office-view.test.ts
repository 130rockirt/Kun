import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it } from 'vitest'
import i18n from '../../i18n'
import {
  metaComposerContextLabels,
  metaOfficeViewPositions,
  RuntimeMetaChips
} from './message-timeline-bubble-support'

const officeView = {
  schemaVersion: 1 as const,
  id: 'office-view-position',
  title: 'deck.pptx',
  summary: 'Current view · Slide 3 of 9',
  reference: {
    kind: 'office-view-position', schemaVersion: 1, sourceName: 'deck.pptx',
    sourceFormat: 'pptx', sourceSha256: 'a'.repeat(64),
    location: { kind: 'presentation', slide: 3, slideCount: 9 }
  },
  revision: 1,
  generation: 0,
  attachmentId: `workspace-view-context:${'b'.repeat(64)}`,
  provenance: { source: 'workspace-view' as const, workspaceId: 'c'.repeat(64) }
}

describe('presentation current-view history metadata', () => {
  it('parses the captured coordinates separately from generic contexts', () => {
    const meta = { composerContexts: [officeView] }
    expect(metaOfficeViewPositions(meta)).toEqual([{
      kind: 'presentation', sourceName: 'deck.pptx', sourceFormat: 'pptx',
      sourceSha256: 'a'.repeat(64), slide: 3, slideCount: 9
    }])
    expect(metaComposerContextLabels(meta)).toEqual([])
  })

  it('renders the source and slide coordinates on the historical message', async () => {
    await i18n.changeLanguage('en')
    let renderer: ReactTestRenderer
    await act(async () => {
      renderer = create(createElement(RuntimeMetaChips, {
        meta: { composerContexts: [officeView] }, align: 'right'
      }))
    })
    const chip = renderer!.root.findByProps({ 'data-office-view-position': true })
    expect(chip.props.title).toContain('deck.pptx')
    expect(chip.props.title).toMatch(/3.*9/)
    expect(JSON.stringify(renderer!.toJSON())).toContain('deck.pptx')
    act(() => renderer!.unmount())
  })
})
