import { describe, expect, it } from 'vitest'
import { readStylesheetBundle } from '../testing/stylesheet-bundle'

describe('Kun startup motion styles', () => {
  it('pauses all decorative motion for recovery and reduced-motion users', async () => {
    const css = await readStylesheetBundle(new URL('./startup-gate.css', import.meta.url))

    expect(css).toMatch(/\.kun-startup__artwork\[data-motion='paused'\][\s\S]*?animation: none !important;/)
    expect(css).toMatch(/\.kun-startup-artwork__console-core\s*{[\s\S]*?transform: translate\(-50%, -50%\);/)
    expect(css).toContain('@media (prefers-reduced-motion: reduce)')
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.kun-startup__motion\s*{[\s\S]*?animation: none !important;/)
  })
})
