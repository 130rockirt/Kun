import { describe, expect, it } from 'vitest'
import { workbenchDividerClassName } from './workbench-divider'

describe('workbenchDividerClassName', () => {
  it('uses a layout-neutral hairline for the Work three-pane shell', () => {
    expect(workbenchDividerClassName('write')).toContain('ds-workbench-divider--flush')
    expect(workbenchDividerClassName('chat')).not.toContain('ds-workbench-divider--flush')
  })
})
