import { describe, expect, it } from 'vitest'
import type { NormalizedThread } from '../../agent/types'
import {
  markSddAssistantThread,
  normalizeSddThreadRegistry
} from '../../sdd/sdd-thread-registry'
import { shouldRestoreRequirementDraftForSidebarThread } from './useWorkbenchSddThreadController'

const requirementThread: NormalizedThread = {
  id: 'thread-sdd-1',
  title: 'Requirement draft',
  updatedAt: '2026-01-01T00:00:00.000Z',
  model: 'deepseek-v4-pro',
  mode: 'agent',
  workspace: '/tmp/app'
}

describe('requirement sidebar thread destination', () => {
  it('restores the requirement before Plan release and opens Code afterward', () => {
    const requirementRegistry = markSddAssistantThread({
      id: 'draft-1',
      workspaceRoot: '/tmp/app',
      relativePath: '.kunsdd/requirements/draft-1/requirement.md'
    }, requirementThread.id, null)
    const visibleRequirementRegistry = normalizeSddThreadRegistry({
      ...requirementRegistry,
      drafts: Object.fromEntries(
        Object.entries(requirementRegistry.drafts).map(([draftId, record]) => [
          draftId,
          { ...record, visibleThreadIds: [requirementThread.id] }
        ])
      )
    })
    const releasedRegistry = normalizeSddThreadRegistry({
      ...visibleRequirementRegistry,
      drafts: Object.fromEntries(
        Object.entries(visibleRequirementRegistry.drafts).map(([draftId, record]) => [
          draftId,
          { ...record, publicThreadIds: [requirementThread.id] }
        ])
      )
    })

    expect(shouldRestoreRequirementDraftForSidebarThread(
      requirementThread.id,
      requirementThread,
      visibleRequirementRegistry
    )).toBe(true)
    expect(shouldRestoreRequirementDraftForSidebarThread(
      requirementThread.id,
      requirementThread,
      releasedRegistry
    )).toBe(false)
  })
})
