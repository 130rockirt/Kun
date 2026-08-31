import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { act, create as createRenderer } from 'react-test-renderer'
import i18n from '../../i18n'
import {
  canEditQueuedComposerMessage,
  FloatingComposerQueuedMessages
} from './FloatingComposerQueuedMessages'

describe('FloatingComposer attached queue dock', () => {
  let previousLanguage: string

  beforeEach(async () => {
    previousLanguage = i18n.language
    await i18n.changeLanguage('en')
  })

  afterEach(async () => {
    await i18n.changeLanguage(previousLanguage)
  })

  it('renders one item directly as an attached dock without a portal trigger', () => {
    const html = renderToStaticMarkup(createElement(FloatingComposerQueuedMessages, {
      messages: [{ id: 'q-one', text: 'Follow up' }],
      running: true,
      onRemove: () => undefined
    }))

    expect(html).toContain('data-composer-attached-dock="queue"')
    expect(html).toContain('data-composer-stack-item="queue"')
    expect(html).toContain('Follow up')
    expect(html).not.toContain('role="dialog"')
    expect(html).not.toContain('1 queued')
  })

  it('collapses multiple items and expands them from the count header', async () => {
    let renderer: ReturnType<typeof createRenderer>
    await act(async () => {
      renderer = createRenderer(createElement(FloatingComposerQueuedMessages, {
        messages: [{ id: 'q-one', text: 'First' }, { id: 'q-two', text: 'Second' }],
        running: true,
        onRemove: () => undefined
      }))
    })
    const header = renderer!.root.findAllByType('button').find(
      (button) => button.props['aria-controls'] !== undefined
    )!
    expect(header.props['aria-expanded']).toBe(false)
    expect(JSON.stringify(renderer!.toJSON())).not.toContain('First')
    await act(async () => { header.props.onClick() })
    expect(header.props['aria-expanded']).toBe(true)
    expect(JSON.stringify(renderer!.toJSON())).toContain('First')
    renderer!.unmount()
  })

  it('edits plain text inline and saves with the same identity', async () => {
    const onEdit = vi.fn(() => true)
    let renderer: ReturnType<typeof createRenderer>
    await act(async () => {
      renderer = createRenderer(createElement(FloatingComposerQueuedMessages, {
        messages: [{ id: 'q-edit', text: 'Before' }],
        running: true,
        onEdit,
        onRemove: () => undefined
      }))
    })
    const edit = renderer!.root.findAllByType('button').find(
      (button) => button.props['aria-label'] === 'Edit queued message'
    )!
    await act(async () => { edit.props.onClick() })
    const input = renderer!.root.findByType('input')
    await act(async () => { input.props.onChange({ currentTarget: { value: 'After' } }) })
    const save = renderer!.root.findAllByType('button').find(
      (button) => button.props['aria-label'] === 'Save queued message'
    )!
    await act(async () => { save.props.onClick() })
    expect(onEdit).toHaveBeenCalledWith('q-edit', 'After')
    renderer!.unmount()
  })

  it('disables steer outside a running turn and rejects structured edits', () => {
    const html = renderToStaticMarkup(createElement(FloatingComposerQueuedMessages, {
      messages: [{ id: 'q-image', text: 'Inspect', attachmentIds: ['image-1'] }],
      running: false,
      onEdit: () => true,
      onGuide: () => undefined,
      onRemove: () => undefined
    }))
    expect(html).toContain('Steer')
    expect(html).toContain('disabled=""')
    expect(canEditQueuedComposerMessage({
      id: 'q-image', text: 'Inspect', attachmentIds: ['image-1']
    })).toBe(false)
  })
})
