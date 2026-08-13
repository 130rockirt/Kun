import { describe, expect, it } from 'vitest'
import { normalizeWorkbenchRoute } from './workbench-route'

describe('normalizeWorkbenchRoute', () => {
  it('projects the legacy standalone Design route through Code', () => {
    expect(normalizeWorkbenchRoute('design')).toBe('chat')
  })

  it.each(['chat', 'write', 'plugins', 'extensions', 'schedule', 'workflow'])(
    'preserves the active %s route',
    (route) => {
      expect(normalizeWorkbenchRoute(route)).toBe(route)
    }
  )
})
