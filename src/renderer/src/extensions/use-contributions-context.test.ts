import { describe, expect, it } from 'vitest'
import { workbenchContextForRoute } from './use-contributions'

describe('workbench contribution context', () => {
  it('advertises a Design task without requiring the legacy Design route', () => {
    expect(workbenchContextForRoute('chat', '/workspace', {}, 'design')).toMatchObject({
      workspaceOpen: true,
      'workbench.mode': 'design',
      'workbench.code': false,
      'workbench.design': true
    })
  })

  it('keeps Code as the default chat task surface', () => {
    expect(workbenchContextForRoute('chat', '/workspace')).toMatchObject({
      'workbench.mode': 'code',
      'workbench.code': true,
      'workbench.design': false
    })
  })
})
