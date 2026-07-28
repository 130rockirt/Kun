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
      'sdd-assistant-body flex min-h-0 flex-1 flex-col overflow-hidden'
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
})
