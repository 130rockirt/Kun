import { describe, expect, it } from 'vitest'
import type { NormalizedThread } from '../agent/types'
import {
  emptyDesignThreadRegistry,
  markDesignThread
} from './design-thread-registry'
import {
  isDesignWorkbenchThread,
  isLegacyDesignWorkbenchThread
} from './design-task-classification'

function thread(overrides: Partial<NormalizedThread> = {}): NormalizedThread {
  return {
    id: 'thread-1',
    title: 'Task',
    updatedAt: '2026-08-13T00:00:00.000Z',
    model: 'test-model',
    mode: 'agent',
    workspace: '/workspace/project',
    ...overrides
  }
}

describe('Design workbench task classification', () => {
  it('recognizes legacy ownership from runtime or the document registry', () => {
    const registry = markDesignThread(
      '/workspace/project',
      'document-1',
      'registered-design',
      emptyDesignThreadRegistry()
    )

    expect(isLegacyDesignWorkbenchThread('runtime-design', thread({
      id: 'runtime-design', agentSurface: 'design'
    }), registry)).toBe(true)
    expect(isLegacyDesignWorkbenchThread(
      'registered-design', thread({ id: 'registered-design' }), registry
    )).toBe(true)
  })

  it('recognizes a locked Design profile on a Code-owned task', () => {
    expect(isDesignWorkbenchThread('profiled-design', thread({
      id: 'profiled-design', agentSurface: 'code', designProfile: {
        version: 1,
        documentTarget: { documentId: 'document-1', boardArtifactId: 'board-1' },
        outputMedium: 'html',
        target: 'web',
        preset: 'none',
        context: { tone: [] },
        lockedAtTurnId: 'turn-1'
      }
    }), emptyDesignThreadRegistry())).toBe(true)
    // A stale legacy lockedTaskSurface signal never classifies a Code-owned
    // conversation; only the Design profile drives its Design capability.
    expect(isDesignWorkbenchThread('locked-design', thread({
      id: 'locked-design', agentSurface: 'code', lockedTaskSurface: 'design'
    }), emptyDesignThreadRegistry())).toBe(false)
  })

  it('keeps a Code-owned conversation Design-capable through its profile', () => {
    expect(isDesignWorkbenchThread('code-task', thread({
      id: 'code-task',
      agentSurface: 'code',
      lockedTaskSurface: 'code',
      designProfile: {
        version: 1,
        documentTarget: { documentId: 'document-1', boardArtifactId: 'board-1' },
        outputMedium: 'html',
        target: 'web',
        preset: 'none',
        context: { tone: [] },
        lockedAtTurnId: 'turn-1'
      }
    }), emptyDesignThreadRegistry())).toBe(true)
  })
})
