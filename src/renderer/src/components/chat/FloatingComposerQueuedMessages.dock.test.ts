/** @vitest-environment jsdom */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FloatingComposerQueuedMessages,
  type QueuedComposerMessage
} from './FloatingComposerQueuedMessages'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string | number>) => {
      const parts = Object.entries(values ?? {})
        .map(([name, value]) => `${name}=${String(value)}`)
      return parts.length > 0 ? `${key} ${parts.join(' ')}` : key
    }
  })
}))

type QueueProps = Parameters<typeof FloatingComposerQueuedMessages>[0]

function message(
  id: string,
  text: string,
  overrides: Partial<QueuedComposerMessage> = {}
): QueuedComposerMessage {
  return { id, text, ...overrides }
}

function deferred<T = void>(): {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
} {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((accept) => { resolve = accept })
  return { promise, resolve }
}

function setReactActEnvironment(value: boolean): void {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
    .IS_REACT_ACT_ENVIRONMENT = value
}

function queueRow(container: HTMLElement, id: string): HTMLLIElement {
  const row = container.querySelector<HTMLLIElement>(`[data-queued-message-id="${id}"]`)
  if (!row) throw new Error(`missing queued message row: ${id}`)
  return row
}

function dragHandle(row: Element): HTMLButtonElement {
  const handle = row.querySelector<HTMLButtonElement>('[data-queued-message-drag-handle]')
  if (!handle) throw new Error('missing queued message drag handle')
  return handle
}

function dispatchDrag(
  target: Element,
  type: 'dragstart' | 'dragover' | 'drop' | 'dragend',
  clientY = 0
): void {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperties(event, {
    clientY: { configurable: true, value: clientY },
    dataTransfer: {
      configurable: true,
      value: {
        effectAllowed: 'move',
        dropEffect: 'move',
        setData: vi.fn(),
        getData: vi.fn(() => '')
      }
    }
  })
  target.dispatchEvent(event)
}

function reorderControls(container: HTMLElement): HTMLButtonElement[] {
  return [...container.querySelectorAll<HTMLButtonElement>(
    '[data-queued-message-drag-handle]'
  )]
}

describe('FloatingComposerQueuedMessages DSH queue dock interactions', () => {
  let container: HTMLDivElement
  let root: Root
  let props: QueueProps

  const render = async (overrides: Partial<QueueProps> = {}): Promise<void> => {
    props = { ...props, ...overrides }
    await act(async () => {
      root.render(createElement(FloatingComposerQueuedMessages, props))
    })
  }

  const action = (kind: string, row?: Element): HTMLButtonElement => {
    const scope = row ?? container
    const button = scope.querySelector<HTMLButtonElement>(
      `[data-queued-message-action="${kind}"]`
    )
    if (!button) throw new Error(`missing queue action: ${kind}`)
    return button
  }

  const setEditorValue = async (value: string): Promise<HTMLInputElement> => {
    const editor = container.querySelector<HTMLInputElement>('[data-queued-message-editor]')
    if (!editor) throw new Error('missing queued message editor')
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value'
    )?.set
    await act(async () => {
      setter?.call(editor, value)
      editor.dispatchEvent(new Event('input', { bubbles: true }))
    })
    return editor
  }

  beforeEach(() => {
    setReactActEnvironment(true)
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    props = {
      messages: [],
      running: true,
      onRemove: vi.fn(),
      onGuide: vi.fn(),
      onEdit: vi.fn(() => true),
      onReorder: vi.fn()
    }
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    setReactActEnvironment(false)
    vi.restoreAllMocks()
  })

  it('renders nothing for an empty queue and one direct row without a header or portal', async () => {
    await render()
    expect(container.innerHTML).toBe('')

    await render({ messages: [message('q-1', 'first follow-up')] })
    expect(container.querySelector('[data-queue-dock]')).not.toBeNull()
    expect(container.querySelector('[data-queued-message-header]')).toBeNull()
    expect(container.querySelector('[data-queued-message-id="q-1"]')?.textContent)
      .toContain('first follow-up')
    expect(document.body.querySelectorAll('[data-composer-queue]')).toHaveLength(1)
    expect(container.querySelector('[data-composer-queue]')).not.toBeNull()
    expect(reorderControls(container)).toHaveLength(0)
    expect(queueRow(container, 'q-1').draggable).toBe(false)
  })

  it('defaults multiple rows to a collapsed, labelled list and toggles it from the header', async () => {
    await render({
      messages: [message('q-1', 'first'), message('q-2', 'second')]
    })

    const header = container.querySelector<HTMLButtonElement>('[data-queued-message-header]')
    expect(header).not.toBeNull()
    expect(header?.getAttribute('aria-expanded')).toBe('false')
    const listId = header?.getAttribute('aria-controls')
    expect(listId).toBeTruthy()
    expect(document.getElementById(listId!)?.getAttribute('aria-label'))
      .toBe('queuedMessagesTitle count=2')
    expect(container.querySelector('[data-queued-message-id="q-1"]')).toBeNull()
    expect(reorderControls(container)).toHaveLength(0)

    await act(async () => header?.click())
    expect(header?.getAttribute('aria-expanded')).toBe('true')
    expect(container.querySelectorAll('[data-queued-message-id]')).toHaveLength(2)
    expect(reorderControls(container)).toHaveLength(2)
    expect(dragHandle(queueRow(container, 'q-1')).draggable).toBe(true)
    expect(dragHandle(queueRow(container, 'q-2')).draggable).toBe(true)

    await act(async () => header?.click())
    expect(header?.getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelectorAll('[data-queued-message-id]')).toHaveLength(0)
  })

  it('drops by stable ids before or after the target midpoint and clears the indicator', async () => {
    const onReorder = vi.fn()
    await render({
      messages: [message('q-source', 'source'), message('q-target', 'target')],
      onReorder
    })
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-queued-message-header]')?.click()
    })

    const source = queueRow(container, 'q-source')
    const target = queueRow(container, 'q-target')
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({
      top: 100,
      bottom: 140,
      height: 40,
      left: 0,
      right: 400,
      width: 400,
      x: 0,
      y: 100,
      toJSON: () => ({})
    })

    await act(async () => dispatchDrag(dragHandle(source), 'dragstart'))
    await act(async () => dispatchDrag(target, 'dragover', 110))
    expect(target.getAttribute('data-drop-position')).toBe('before')

    await act(async () => dispatchDrag(target, 'drop', 110))
    expect(onReorder).toHaveBeenLastCalledWith('q-source', 'q-target', 'before')
    expect(container.querySelector('[data-drop-position]')).toBeNull()

    await act(async () => dispatchDrag(dragHandle(source), 'dragstart'))
    await act(async () => dispatchDrag(target, 'dragover', 135))
    expect(target.getAttribute('data-drop-position')).toBe('after')

    await act(async () => dispatchDrag(target, 'drop', 135))
    expect(onReorder).toHaveBeenLastCalledWith('q-source', 'q-target', 'after')
    expect(container.querySelector('[data-drop-position]')).toBeNull()
  })

  it('clears transient drag state on drag end without reordering', async () => {
    const onReorder = vi.fn()
    await render({
      messages: [message('q-1', 'one'), message('q-2', 'two')],
      onReorder
    })
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-queued-message-header]')?.click()
    })
    const source = queueRow(container, 'q-1')
    const target = queueRow(container, 'q-2')
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({
      top: 0,
      bottom: 40,
      height: 40,
      left: 0,
      right: 400,
      width: 400,
      x: 0,
      y: 0,
      toJSON: () => ({})
    })

    await act(async () => dispatchDrag(dragHandle(source), 'dragstart'))
    await act(async () => dispatchDrag(target, 'dragover', 35))
    expect(target.getAttribute('data-drop-position')).toBe('after')

    await act(async () => dispatchDrag(dragHandle(source), 'dragend'))
    expect(container.querySelector('[data-drop-position]')).toBeNull()
    expect(container.querySelector('[data-queue-dragging]')).toBeNull()
    expect(onReorder).not.toHaveBeenCalled()
  })

  it('reorders one visible neighbor with ArrowUp or ArrowDown and no-ops at boundaries', async () => {
    const onReorder = vi.fn()
    await render({
      messages: [message('q-1', 'one'), message('q-2', 'two'), message('q-3', 'three')],
      onReorder
    })
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-queued-message-header]')?.click()
    })

    const middleHandle = dragHandle(queueRow(container, 'q-2'))
    middleHandle.focus()
    await act(async () => {
      middleHandle.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'ArrowUp',
        bubbles: true
      }))
    })
    expect(onReorder).toHaveBeenLastCalledWith('q-2', 'q-1', 'before')
    expect(document.activeElement).toBe(middleHandle)

    await act(async () => {
      middleHandle.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'ArrowDown',
        bubbles: true
      }))
    })
    expect(onReorder).toHaveBeenLastCalledWith('q-2', 'q-3', 'after')
    expect(document.activeElement).toBe(middleHandle)

    onReorder.mockClear()
    await act(async () => {
      dragHandle(queueRow(container, 'q-1')).dispatchEvent(new KeyboardEvent('keydown', {
        key: 'ArrowUp',
        bubbles: true
      }))
      dragHandle(queueRow(container, 'q-3')).dispatchEvent(new KeyboardEvent('keydown', {
        key: 'ArrowDown',
        bubbles: true
      }))
    })
    expect(onReorder).not.toHaveBeenCalled()
  })

  it('forces the list open while editing and saves the changed text under the same id', async () => {
    const onEdit = vi.fn(() => true)
    const onReorder = vi.fn()
    await render({ messages: [message('q-edit', 'before')], onEdit, onReorder })
    await act(async () => action('edit').click())
    await setEditorValue('after')

    await render({
      messages: [message('q-edit', 'before'), message('q-tail', 'tail')]
    })
    const header = container.querySelector<HTMLButtonElement>('[data-queued-message-header]')
    expect(header?.getAttribute('aria-expanded')).toBe('true')
    expect(header?.disabled).toBe(true)
    expect(container.querySelector<HTMLInputElement>('[data-queued-message-editor]')?.value)
      .toBe('after')
    expect(reorderControls(container)).toHaveLength(0)
    expect(reorderControls(container).every((handle) => (
      handle.disabled || handle.hidden || handle.getAttribute('aria-disabled') === 'true'
    ))).toBe(true)

    const editor = container.querySelector<HTMLInputElement>('[data-queued-message-editor]')!
    await act(async () => {
      editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await Promise.resolve()
    })
    expect(onEdit).toHaveBeenCalledWith('q-edit', 'after')
    expect(onReorder).not.toHaveBeenCalled()
  })

  it('cancels with Escape, ignores composing Enter, and disables blank saves', async () => {
    const onEdit = vi.fn(() => true)
    await render({ messages: [message('q-edit', 'before')], onEdit })
    await act(async () => action('edit').click())
    let editor = await setEditorValue('输入中')

    await act(async () => {
      editor.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        isComposing: true
      }))
    })
    expect(onEdit).not.toHaveBeenCalled()
    expect(container.querySelector('[data-queued-message-editor]')).not.toBeNull()

    editor = await setEditorValue('   ')
    expect(action('save').disabled).toBe(true)
    await act(async () => {
      editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(container.querySelector('[data-queued-message-editor]')).toBeNull()
    expect(container.textContent).toContain('before')
    expect(onEdit).not.toHaveBeenCalled()
  })

  it('keeps structured rows visible but disables inline editing', async () => {
    await render({
      messages: [message('q-structured', 'inspect the file', {
        attachmentIds: ['attachment-1']
      })]
    })
    const row = container.querySelector('[data-queued-message-id="q-structured"]')!
    expect(row.textContent).toContain('inspect the file')
    expect(action('edit', row).disabled).toBe(true)
    expect(action('guide', row).disabled).toBe(false)
  })

  it('interlocks every row action and forces expansion while one operation is busy', async () => {
    const pending = deferred<void>()
    const onGuide = vi.fn(() => pending.promise)
    const onReorder = vi.fn()
    await render({ messages: [message('q-1', 'one')], onGuide, onReorder })
    await act(async () => action('guide').click())

    await render({
      messages: [message('q-1', 'one'), message('q-2', 'two')]
    })
    const header = container.querySelector<HTMLButtonElement>('[data-queued-message-header]')
    expect(header?.getAttribute('aria-expanded')).toBe('true')
    expect(header?.disabled).toBe(true)
    expect([...container.querySelectorAll<HTMLButtonElement>('[data-queued-message-action]')]
      .every((button) => button.disabled)).toBe(true)
    expect(queueRow(container, 'q-1').draggable).toBe(false)
    expect(queueRow(container, 'q-2').draggable).toBe(false)
    expect(reorderControls(container).every((handle) => (
      handle.disabled || handle.hidden || handle.getAttribute('aria-disabled') === 'true'
    ))).toBe(true)
    expect(onReorder).not.toHaveBeenCalled()

    await act(async () => {
      pending.resolve()
      await pending.promise
    })
    expect(header?.disabled).toBe(false)
    expect(header?.getAttribute('aria-expanded')).toBe('false')
  })

  it('cancels a drag when live queue delivery retires its source', async () => {
    const onReorder = vi.fn()
    await render({
      messages: [
        message('q-stays-first', 'first'),
        message('q-retires', 'retiring'),
        message('q-stays-last', 'last')
      ],
      onReorder
    })
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-queued-message-header]')?.click()
    })

    const retiringRow = queueRow(container, 'q-retires')
    const target = queueRow(container, 'q-stays-last')
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({
      top: 0,
      bottom: 40,
      height: 40,
      left: 0,
      right: 400,
      width: 400,
      x: 0,
      y: 0,
      toJSON: () => ({})
    })
    await act(async () => dispatchDrag(dragHandle(retiringRow), 'dragstart'))
    await act(async () => dispatchDrag(target, 'dragover', 10))
    expect(target.getAttribute('data-drop-position')).toBe('before')

    await render({
      messages: [
        message('q-stays-first', 'first'),
        message('q-stays-last', 'last')
      ]
    })
    expect(container.querySelector('[data-drop-position]')).toBeNull()
    expect(container.querySelector('[data-queue-dragging]')).toBeNull()

    await act(async () => dispatchDrag(queueRow(container, 'q-stays-last'), 'drop', 10))
    expect(onReorder).not.toHaveBeenCalled()
  })

  it('shows paused and failed rows with Retry while hiding claimed delivery states', async () => {
    const onGuide = vi.fn()
    await render({
      messages: [
        message('q-paused', 'paused', { deliveryState: 'paused' }),
        message('q-failed', 'failed', { deliveryState: 'failed', errorMessage: 'network' }),
        message('q-admission', 'provisional', {
          deliveryState: 'failed', waitForRuntimeAdmission: true
        }),
        message('q-starting', 'starting', { deliveryState: 'starting' }),
        message('q-flight', 'in flight', { deliveryState: 'in_flight' })
      ],
      running: false,
      onGuide
    })
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-queued-message-header]')?.click()
    })

    expect(container.querySelector('[data-queued-message-id="q-paused"]')).not.toBeNull()
    expect(container.querySelector('[data-queued-message-id="q-failed"]')).not.toBeNull()
    expect(action(
      'guide',
      container.querySelector('[data-queued-message-id="q-admission"]')!
    ).disabled).toBe(true)
    expect(container.querySelector('[data-queued-message-id="q-starting"]')).toBeNull()
    expect(container.querySelector('[data-queued-message-id="q-flight"]')).toBeNull()

    const failed = container.querySelector('[data-queued-message-id="q-failed"]')!
    const retry = action('guide', failed)
    expect(retry.textContent).toBe('')
    expect(retry.getAttribute('aria-label')).toBe('queuedMessageRetry')
    await act(async () => retry.click())
    expect(onGuide).toHaveBeenCalledWith('q-failed')
  })

  it('labels each drag handle with its position and summary plus the keyboard hint', async () => {
    const longText = 'a queued message summary that is much longer than the limit'
    await render({
      messages: [
        message('q-1', 'first'),
        message('q-2', 'second'),
        message('q-3', longText)
      ]
    })
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-queued-message-header]')?.click()
    })

    const firstHandle = dragHandle(queueRow(container, 'q-1'))
    expect(firstHandle.getAttribute('aria-label'))
      .toBe('queuedMessageReorderHandle index=1 count=3 summary=first')
    const describedBy = firstHandle.getAttribute('aria-describedby')
    expect(describedBy).toBeTruthy()
    expect(document.getElementById(describedBy!)?.textContent)
      .toBe('queuedMessageReorder')

    const longHandle = dragHandle(queueRow(container, 'q-3'))
    expect(longHandle.getAttribute('aria-label'))
      .toBe(`queuedMessageReorderHandle index=3 count=3 summary=${longText.slice(0, 24)}...`)
    expect(longHandle.getAttribute('title'))
      .toBe(longHandle.getAttribute('aria-label'))
  })

  it('announces the new position in a polite live region after keyboard moves', async () => {
    await render({
      messages: [message('q-1', 'one'), message('q-2', 'two'), message('q-3', 'three')]
    })
    const liveRegion = container.querySelector<HTMLElement>('[role="status"]')
    expect(liveRegion?.getAttribute('aria-live')).toBe('polite')
    expect(liveRegion?.textContent).toBe('')
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-queued-message-header]')?.click()
    })

    const middleHandle = dragHandle(queueRow(container, 'q-2'))
    await act(async () => {
      middleHandle.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'ArrowUp',
        bubbles: true
      }))
    })
    expect(container.querySelector('[role="status"]')?.textContent)
      .toBe('queuedMessageMovedToPosition position=1')

    await act(async () => {
      middleHandle.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'ArrowDown',
        bubbles: true
      }))
    })
    expect(container.querySelector('[role="status"]')?.textContent)
      .toBe('queuedMessageMovedToPosition position=3')
  })

  it('shows a down chevron when collapsed and an up chevron when expanded', async () => {
    await render({
      messages: [message('q-1', 'one'), message('q-2', 'two')]
    })
    const header = container.querySelector<HTMLButtonElement>('[data-queued-message-header]')!
    expect(header.querySelector('.lucide-chevron-down')).not.toBeNull()
    expect(header.querySelector('.lucide-chevron-up')).toBeNull()

    await act(async () => header.click())
    expect(header.querySelector('.lucide-chevron-up')).not.toBeNull()
    expect(header.querySelector('.lucide-chevron-down')).toBeNull()
  })

  it('retires live rows and resets expansion before a later queue arrives', async () => {
    await render({ messages: [message('q-1', 'one'), message('q-2', 'two')] })
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-queued-message-header]')?.click()
    })
    expect(container.querySelectorAll('[data-queued-message-id]')).toHaveLength(2)

    await render({ messages: [] })
    expect(container.innerHTML).toBe('')

    await render({ messages: [message('q-3', 'three'), message('q-4', 'four')] })
    const header = container.querySelector<HTMLButtonElement>('[data-queued-message-header]')
    expect(header?.getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelectorAll('[data-queued-message-id]')).toHaveLength(0)
  })
})
