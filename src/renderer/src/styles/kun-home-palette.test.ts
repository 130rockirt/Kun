import { describe, expect, it } from 'vitest'
import { readStylesheetBundle } from '../testing/stylesheet-bundle'

describe('Kun default light palette', () => {
  it('uses the approved warm canvas, cool sidebar, and quiet border colors', async () => {
    const css = await readStylesheetBundle(
      new URL('./base-shell/tokens-window-workspace.css', import.meta.url)
    )

    expect(css).toContain('--bg-app: #fcfcfd')
    expect(css).toContain('--bg-sidebar: #f5f6f8')
    expect(css).toContain('--bg-canvas: #fcfcfd')
    expect(css).toContain('--border-soft: #e7e9ee')
    expect(css).toContain('--ds-accent: #5b78ff')
  })

  it('adds the empty-task blue wash and elevated white composer only in light mode', async () => {
    const css = await readStylesheetBundle(new URL('./neutral-polish.css', import.meta.url))

    expect(css).toMatch(
      /html:not\(\[data-theme='dark'\]\)[\s\S]*?data-empty-task-layout='true'[\s\S]*?radial-gradient\([\s\S]*?rgba\(194, 218, 255, 0\.33\)/
    )
    expect(css).toMatch(
      /data-empty-task-layout='true'[\s\S]*?\.ds-composer-shell\.ds-chat-composer\s*\{[\s\S]*?border-radius:\s*24px;[\s\S]*?0 16px 42px rgba\(32, 55, 90, 0\.09\)/
    )
    expect(css).toMatch(
      /\.ds-composer-shell\.ds-chat-composer\.ds-chat-composer-focus\s*\{[\s\S]*?border-color:\s*#cfd8f3;[\s\S]*?rgba\(111, 139, 255, 0\.08\)/
    )
  })
})
