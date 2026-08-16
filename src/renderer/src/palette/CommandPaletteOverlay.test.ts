import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { act, create as createRenderer, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '../i18n'
import { CommandPaletteOverlay } from './CommandPaletteOverlay'
import type { PaletteEntry } from './palette-model'

function entry(id: string, overrides: Partial<PaletteEntry> = {}): PaletteEntry {
  return {
    id,
    source: 'route',
    title: 'Title ' + id,
    keywords: [],
    activation: { kind: 'route', route: 'chat' },
    ...overrides
  }
}

type OverlayProps = {
  query?: string
  matchTerm?: string
  scope?: 'all' | 'commands' | 'conversations' | 'settings' | 'slash'
  scopeLabel?: string | null
  groups?: Array<{ key: string; label: string; entries: PaletteEntry[] }> | null
  results?: PaletteEntry[]
  onActivate?: (entry: PaletteEntry) => void
  onClose?: () => void
  onQueryChange?: (query: string) => void
}

async function render(props: OverlayProps = {}): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer
  await act(async () => {
    renderer = createRenderer(
      createElement(CommandPaletteOverlay, {
        query: props.query ?? '',
        matchTerm: props.matchTerm ?? props.query ?? '',
        scope: props.scope ?? 'all',
        scopeLabel: props.scopeLabel ?? null,
        groups: props.groups ?? null,
        results: props.results ?? [],
        sourceLabel: (source) => 'src:' + source.source,
        onQueryChange: props.onQueryChange ?? vi.fn(),
        onActivate: props.onActivate ?? vi.fn(),
        onClose: props.onClose ?? vi.fn()
      })
    )
  })
  return renderer
}

describe('CommandPaletteOverlay', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
  })

  it('exposes combobox, listbox, and option ARIA semantics with a live result count', () => {
    const results = [
      entry('one'),
      entry('two', {
        source: 'extension-view',
        activation: { kind: 'extension-view', entryId: 'ext-x', locked: true },
        badge: 'Review'
      }),
      entry('three', { disabled: true, disabledReason: 'Unavailable in the current context' })
    ]
    const html = renderToStaticMarkup(
      createElement(CommandPaletteOverlay, {
        query: 'ti',
        matchTerm: 'ti',
        scope: 'all',
        scopeLabel: null,
        groups: null,
        results,
        sourceLabel: (source) => 'src:' + source.source,
        onQueryChange: vi.fn(),
        onActivate: vi.fn(),
        onClose: vi.fn()
      })
    )
    expect(html).toContain('role="dialog"')
    expect(html).toContain('aria-modal="true"')
    expect(html).toContain('role="combobox"')
    expect(html).toContain('role="listbox"')
    expect(html).toContain('role="option"')
    expect(html).toContain('aria-activedescendant="ds-command-palette-option-0"')
    expect(html).toContain('aria-live="polite"')
    expect(html).toContain('>3 results</div>')
    expect(html).toContain('aria-disabled="true"')
    expect(html).toContain('Unavailable in the current context')
    expect(html).toContain('src:route')
    expect(html).toContain('src:extension-view')
    expect(html).toContain('Review')
  })

  it('renders a scoped empty state without widening the scope', () => {
    const html = renderToStaticMarkup(
      createElement(CommandPaletteOverlay, {
        query: '#nope',
        matchTerm: 'nope',
        scope: 'settings',
        scopeLabel: 'Settings',
        groups: null,
        results: [],
        sourceLabel: vi.fn(),
        onQueryChange: vi.fn(),
        onActivate: vi.fn(),
        onClose: vi.fn()
      })
    )
    expect(html).toContain('No matching results in Settings.')
    expect(html).not.toContain('role="option"')
  })

  it('shows a searching indicator instead of the empty state while a deep search runs', () => {
    const html = renderToStaticMarkup(
      createElement(CommandPaletteOverlay, {
        query: 'checkout',
        matchTerm: 'checkout',
        scope: 'all',
        scopeLabel: null,
        groups: null,
        results: [],
        contentSearchPending: true,
        sourceLabel: vi.fn(),
        onQueryChange: vi.fn(),
        onActivate: vi.fn(),
        onClose: vi.fn()
      })
    )
    expect(html).toContain('Searching conversations')
    // Claiming "no results" while results are still arriving is the bug this
    // guards: a slow search read as a failed search.
    expect(html).not.toContain('No matching results')
  })

  it('keeps a searching hint visible when some results already rendered', () => {
    const html = renderToStaticMarkup(
      createElement(CommandPaletteOverlay, {
        query: 'checkout',
        matchTerm: 'checkout',
        scope: 'all',
        scopeLabel: null,
        groups: null,
        results: [entry('r1')],
        contentSearchPending: true,
        sourceLabel: vi.fn(),
        onQueryChange: vi.fn(),
        onActivate: vi.fn(),
        onClose: vi.fn()
      })
    )
    expect(html).toContain('Searching conversations')
    expect(html).toContain('role="option"')
  })

  it('reports the empty state once the deep search has settled', () => {
    const html = renderToStaticMarkup(
      createElement(CommandPaletteOverlay, {
        query: 'checkout',
        matchTerm: 'checkout',
        scope: 'all',
        scopeLabel: null,
        groups: null,
        results: [],
        contentSearchPending: false,
        sourceLabel: vi.fn(),
        onQueryChange: vi.fn(),
        onActivate: vi.fn(),
        onClose: vi.fn()
      })
    )
    expect(html).toContain('No matching results')
    expect(html).not.toContain('Searching conversations')
  })

  it('renders recents and default destination groups for the empty query', () => {
    const html = renderToStaticMarkup(
      createElement(CommandPaletteOverlay, {
        query: '',
        matchTerm: '',
        scope: 'all',
        scopeLabel: null,
        groups: [
          { key: 'recent', label: 'Recent', entries: [entry('r1')] },
          { key: 'default', label: 'Quick actions', entries: [entry('d1'), entry('d2')] }
        ],
        results: [],
        sourceLabel: vi.fn(),
        onQueryChange: vi.fn(),
        onActivate: vi.fn(),
        onClose: vi.fn()
      })
    )
    expect(html).toContain('Recent')
    expect(html).toContain('Quick actions')
    expect(html).toContain('>3 results</div>')
  })

  it('moves the active option with arrow keys and Home/End', async () => {
    const onActivate = vi.fn()
    const onClose = vi.fn()
    const tree = await render({
      results: [entry('a'), entry('b'), entry('c')],
      onActivate,
      onClose
    })
    const panel = tree.root.findAll((node) => node.props.onKeyDown)[0]
    const fireKey = (key: string): void => {
      act(() => {
        panel.props.onKeyDown({ key, nativeEvent: { isComposing: false }, preventDefault: vi.fn() })
      })
    }

    fireKey('ArrowDown')
    let options = tree.root.findAllByType('li')
    expect(options[1].props['aria-selected']).toBe(true)

    fireKey('End')
    options = tree.root.findAllByType('li')
    expect(options[2].props['aria-selected']).toBe(true)

    fireKey('Home')
    options = tree.root.findAllByType('li')
    expect(options[0].props['aria-selected']).toBe(true)

    fireKey('ArrowUp')
    options = tree.root.findAllByType('li')
    // Movement clamps at the first option; it does not wrap around.
    expect(options[0].props['aria-selected']).toBe(true)

    fireKey('ArrowDown')
    options = tree.root.findAllByType('li')
    expect(options[1].props['aria-selected']).toBe(true)
    expect(onActivate).not.toHaveBeenCalled()
  })

  it('activates the active option on Enter and leaves disabled entries inert', async () => {
    const onActivate = vi.fn()
    const onClose = vi.fn()
    const disabled = entry('disabled', { disabled: true })
    const tree = await render({
      results: [disabled, entry('enabled')],
      onActivate,
      onClose
    })
    const panel = tree.root.findAll((node) => node.props.onKeyDown)[0]
    const fireKey = (key: string): void => {
      act(() => {
        panel.props.onKeyDown({ key, nativeEvent: { isComposing: false }, preventDefault: vi.fn() })
      })
    }

    fireKey('Enter')
    expect(onActivate).not.toHaveBeenCalled()

    fireKey('ArrowDown')
    fireKey('Enter')
    expect(onActivate).toHaveBeenCalledTimes(1)
    expect(onActivate.mock.calls[0][0].id).toBe('enabled')
  })

  it('dismisses on Escape without activating', async () => {
    const onActivate = vi.fn()
    const onClose = vi.fn()
    const tree = await render({ results: [entry('a')], onActivate, onClose })
    const panel = tree.root.findAll((node) => node.props.onKeyDown)[0]
    act(() => {
      panel.props.onKeyDown({ key: 'Escape', nativeEvent: { isComposing: false }, preventDefault: vi.fn() })
    })
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onActivate).not.toHaveBeenCalled()
  })

  it('activates a result on pointer down unless it is disabled', async () => {
    const onActivate = vi.fn()
    const disabled = entry('disabled', { disabled: true })
    const tree = await render({ results: [disabled, entry('ok')], onActivate })
    const options = tree.root.findAllByType('li')
    act(() => options[0].props.onPointerDown({ preventDefault: vi.fn() }))
    expect(onActivate).not.toHaveBeenCalled()
    act(() => options[1].props.onPointerDown({ preventDefault: vi.fn() }))
    expect(onActivate).toHaveBeenCalledTimes(1)
    expect(onActivate.mock.calls[0][0].id).toBe('ok')
  })

  it('propagates input changes and shows the active scope hint', async () => {
    const onQueryChange = vi.fn()
    const tree = await render({
      query: '#pro',
      matchTerm: 'pro',
      scope: 'settings',
      scopeLabel: 'Settings',
      onQueryChange
    })
    const input = tree.root.findByType('input')
    act(() => input.props.onChange({ target: { value: '#prov' } }))
    expect(onQueryChange).toHaveBeenCalledWith('#prov')
    expect(tree.root.findByProps({ children: 'Settings' })).toBeTruthy()
  })
})
