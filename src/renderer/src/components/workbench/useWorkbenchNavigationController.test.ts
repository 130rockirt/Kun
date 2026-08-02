import { describe, expect, it } from 'vitest'
import type { NormalizedThread } from '../../agent/types'
import {
  emptyDesignThreadRegistry,
  markDesignThread
} from '../../design/design-thread-registry'
import { isWorkbenchDesignThread } from './useWorkbenchNavigationController'

function thread(agentSurface?: NormalizedThread['agentSurface']): NormalizedThread {
  return {
    id: 'thr_design',
    title: 'A drawing',
    ...(agentSurface ? { agentSurface } : {}),
    updatedAt: '2026-08-01T00:00:00.000Z',
    model: 'gpt-5.6-luna',
    mode: 'agent',
    workspace: '/workspace/project'
  }
}

describe('workbench thread navigation surface', () => {
  it('routes a durably classified Design thread to Design without a local registry', () => {
    expect(isWorkbenchDesignThread(
      'thr_design',
      thread('design'),
      emptyDesignThreadRegistry()
    )).toBe(true)
  })

  it('keeps legacy registered Design threads on the Design route', () => {
    const registry = markDesignThread(
      '/workspace/project',
      'drawing-1',
      'thr_design',
      emptyDesignThreadRegistry()
    )

    expect(isWorkbenchDesignThread('thr_design', thread(), registry)).toBe(true)
  })

  it('leaves Code and Write threads on their own navigation paths', () => {
    expect(isWorkbenchDesignThread(
      'thr_design',
      thread('code'),
      emptyDesignThreadRegistry()
    )).toBe(false)
    expect(isWorkbenchDesignThread(
      'thr_design',
      thread('write'),
      emptyDesignThreadRegistry()
    )).toBe(false)
  })
})
