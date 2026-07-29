import { describe, expect, it } from 'vitest'

describe('SddAssistantPanel scroll ownership', () => {
  it('lets the shared timeline own conversation scrolling without an animated ancestor', async () => {
    const nodeFs = 'node:fs/promises'
    const { readFile } = await import(/* @vite-ignore */ nodeFs)
    const [source, css] = await Promise.all([
      readFile(new URL('./SddAssistantPanel.tsx', import.meta.url), 'utf8'),
      readFile(new URL('../../styles/base-shell.css', import.meta.url), 'utf8')
    ])

    expect(source).toContain(
      'sdd-assistant-body ds-sidebar-surface-body flex min-h-0 flex-1 flex-col overflow-hidden'
    )
    expect(source).toContain(
      'sdd-assistant-timeline flex min-h-0 flex-1 flex-col overflow-hidden'
    )
    expect(css).not.toMatch(
      /\.sdd-assistant-body\s*\{[^}]*scroll-behavior:\s*smooth/s
    )
  })

  it('keeps the empty-state framework list scrollable in a short panel', async () => {
    const nodeFs = 'node:fs/promises'
    const { readFile } = await import(/* @vite-ignore */ nodeFs)
    const source = await readFile(new URL('./SddAssistantPanel.tsx', import.meta.url), 'utf8')

    expect(source).toContain(
      'sdd-assistant-empty flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden'
    )
  })

  it('binds structured user input to the SDD thread composer', async () => {
    const nodeFs = 'node:fs/promises'
    const { readFile } = await import(/* @vite-ignore */ nodeFs)
    const source = await readFile(new URL('./SddAssistantPanel.tsx', import.meta.url), 'utf8')

    expect(source).toContain('activeThreadIdOverride={activeThreadId}')
    expect(source).toContain('userInputBlocksOverride={blocks}')
    expect(source).toContain('onResolveUserInput={resolveUserInput}')
  })

  it('uses the shared sidebar palette instead of a panel-specific white palette', async () => {
    const nodeFs = 'node:fs/promises'
    const { readFile } = await import(/* @vite-ignore */ nodeFs)
    const [source, css] = await Promise.all([
      readFile(new URL('./SddAssistantPanel.tsx', import.meta.url), 'utf8'),
      readFile(new URL('../../styles/base-shell.css', import.meta.url), 'utf8')
    ])

    expect(source).toContain('sdd-assistant-panel ds-sidebar-surface')
    expect(source).toContain('sdd-assistant-header ds-sidebar-surface-chrome')
    expect(source).toContain('sdd-assistant-body ds-sidebar-surface-body')
    expect(source).toContain('sdd-assistant-title-pill flex min-w-0 flex-1 items-center gap-2 rounded-[12px] border border-ds-border-muted bg-ds-card/70')
    expect(source).toContain('truncate rounded-full border border-ds-border-muted bg-ds-card/70')
    expect(source).toContain('sdd-assistant-composer ds-sidebar-surface-chrome')
    expect(source).not.toMatch(/\bbg-white(?:\/\d+)?\b/)
    expect(css).toMatch(
      /\.sdd-assistant-panel \.ds-chat-composer\s*\{[^}]*background:\s*var\(--ds-surface-card\)/s
    )
  })
})
