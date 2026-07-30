import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import i18n from '../../i18n'
import { GraphChildSessionBar } from './message-timeline-empty'

const context = {
  runTitle: 'Improve Geo',
  nodeTitle: 'Inspect current implementation',
  attemptNumber: 2,
  agentName: 'Explorer',
  statusLabel: 'Working',
  activityLabel: 'Scanning the repository · repo_map',
  elapsedLabel: '1:42',
  observerStatus: 'live' as const
}

describe('Graph child session bar', () => {
  beforeAll(async () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    await i18n.changeLanguage('en')
  })

  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT
  })

  it('shows Graph breadcrumbs, live state, activity, elapsed time, and return control', () => {
    const html = renderToStaticMarkup(createElement(GraphChildSessionBar, {
      context,
      onBack: () => undefined
    }))

    expect(html).toContain('Main session')
    expect(html).toContain('Improve Geo')
    expect(html).toContain('Inspect current implementation')
    expect(html).toContain('Attempt #2')
    expect(html).toContain('Scanning the repository · repo_map')
    expect(html).toContain('Graph live')
    expect(html).toContain('Return to Graph')
  })

  it('returns to the preserved Graph context from the child header', async () => {
    const onBack = vi.fn()
    let renderer: ReactTestRenderer
    await act(async () => {
      renderer = create(createElement(GraphChildSessionBar, { context, onBack }))
    })

    const button = renderer!.root.findByType('button')
    act(() => button.props.onClick())
    expect(onBack).toHaveBeenCalledTimes(1)

    await act(async () => renderer!.unmount())
  })
})
