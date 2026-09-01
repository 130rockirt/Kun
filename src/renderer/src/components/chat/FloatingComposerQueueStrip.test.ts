import { createElement } from 'react'
import { act, create as createRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { FloatingComposerQueueStrip } from './FloatingComposerQueueStrip'

async function renderStrip(
  overrides: Partial<Parameters<typeof FloatingComposerQueueStrip>[0]> = {}
) {
  const onEdit = vi.fn()
  const onRemove = vi.fn()
  const onGuide = vi.fn()
  const props: Parameters<typeof FloatingComposerQueueStrip>[0] = {
    rootRef: { current: null },
    previewButtonRef: { current: null },
    previewText: 'Tighten the spacing',
    count: 1,
    open: false,
    guiding: false,
    canEdit: true,
    canGuide: true,
    queueLabel: '1 queued',
    editLabel: 'Edit message',
    removeLabel: 'Remove queued message',
    guideLabel: 'Guide',
    guideTitle: 'Guide the active turn',
    guidingLabel: 'Guiding',
    onOpen: vi.fn(),
    onCloseSoon: vi.fn(),
    onEdit,
    onRemove,
    onGuide,
    ...overrides
  }
  let renderer: ReturnType<typeof createRenderer>
  await act(async () => {
    renderer = createRenderer(createElement(FloatingComposerQueueStrip, props))
  })
  return { onEdit, onRemove, onGuide, renderer: renderer! }
}

describe('FloatingComposerQueueStrip', () => {
  it('previews the next message and exposes the three inline actions', async () => {
    const { onEdit, onRemove, onGuide, renderer } = await renderStrip()
    try {
      expect(JSON.stringify(renderer.toJSON())).toContain('Tighten the spacing')

      for (const action of ['edit', 'remove', 'guide']) {
        await act(async () => {
          renderer.root.findByProps({ 'data-queued-message-strip-action': action }).props.onClick()
        })
      }
      expect(onEdit).toHaveBeenCalledOnce()
      expect(onRemove).toHaveBeenCalledOnce()
      expect(onGuide).toHaveBeenCalledOnce()
    } finally {
      renderer.unmount()
    }
  })

  it('shows the remaining count and disables unavailable guidance', async () => {
    const { renderer } = await renderStrip({ count: 3, canEdit: false, canGuide: false })
    try {
      expect(renderer.root.findByProps({ 'data-queued-message-overflow-count': 2 }).children)
        .toEqual(['+', '2'])
      expect(renderer.root.findAllByProps({ 'data-queued-message-strip-action': 'edit' }))
        .toHaveLength(0)
      expect(renderer.root.findByProps({ 'data-queued-message-strip-action': 'guide' }).props.disabled)
        .toBe(true)
    } finally {
      renderer.unmount()
    }
  })
})
