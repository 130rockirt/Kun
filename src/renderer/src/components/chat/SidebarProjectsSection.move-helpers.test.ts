import { describe, expect, it } from 'vitest'
import type { NormalizedThread } from '../../agent/types'
import {
  buildSidebarThreadMoveTargets,
  buildSidebarWorkspaceGroups,
  isSidebarThreadMoveBlocked,
  sddDraftHistorySavedRevision
} from './SidebarProjectsSection'

function thread(
  overrides: Partial<NormalizedThread> & Pick<NormalizedThread, 'id' | 'workspace'>
): NormalizedThread {
  return {
    id: overrides.id,
    title: overrides.title ?? overrides.id,
    updatedAt: overrides.updatedAt ?? '2026-06-01T00:00:00.000Z',
    model: overrides.model ?? 'reasonix',
    mode: overrides.mode ?? 'agent',
    workspace: overrides.workspace,
    ...(overrides.status ? { status: overrides.status } : {})
  }
}

describe('requirement history saved revision', () => {
  it('changes when a requirement is created or successfully saved', () => {
    const created = {
      id: 'draft-a',
      updatedAt: '2026-07-30T01:00:00.000Z'
    }
    const saved = {
      ...created,
      updatedAt: '2026-07-30T01:01:00.000Z'
    }

    expect(sddDraftHistorySavedRevision(null)).toBe('')
    expect(sddDraftHistorySavedRevision(created)).not.toBe('')
    expect(sddDraftHistorySavedRevision(saved)).not.toBe(
      sddDraftHistorySavedRevision(created)
    )
  })

  it('does not depend on unsaved requirement content', () => {
    const draftRevision = {
      id: 'draft-a',
      updatedAt: '2026-07-30T01:00:00.000Z'
    }

    expect(sddDraftHistorySavedRevision(draftRevision)).toBe(
      sddDraftHistorySavedRevision({ ...draftRevision })
    )
  })
})

describe('sidebar thread move helpers', () => {
  it('excludes the current workspace from move targets', () => {
    const groups = buildSidebarWorkspaceGroups({
      threads: [thread({ id: 'thread-a', workspace: '/Users/zxy/project-a' })],
      searchQuery: '',
      showArchived: false,
      workspaceRoot: '/Users/zxy/project-a',
      conversationRoot: '',
      workspaceRoots: ['/Users/zxy/project-a', '/Users/zxy/project-b']
    })

    expect(
      buildSidebarThreadMoveTargets({
        thread: thread({ id: 'thread-a', workspace: '/Users/zxy/project-a' }),
        groups
      })
    ).toEqual(['/Users/zxy/project-b'])
  })

  it('includes remembered empty project workspaces as move targets', () => {
    const groups = buildSidebarWorkspaceGroups({
      threads: [thread({ id: 'thread-a', workspace: '/Users/zxy/project-a' })],
      searchQuery: '',
      showArchived: false,
      workspaceRoot: '/Users/zxy/project-a',
      conversationRoot: '',
      workspaceRoots: [
        '/Users/zxy/project-a',
        '/Users/zxy/project-b',
        '/Users/zxy/project-c'
      ]
    })

    expect(
      buildSidebarThreadMoveTargets({
        thread: thread({ id: 'thread-a', workspace: '/Users/zxy/project-a' }),
        groups
      })
    ).toEqual(['/Users/zxy/project-b', '/Users/zxy/project-c'])
  })

  it('blocks moving a running thread', () => {
    expect(
      isSidebarThreadMoveBlocked({
        thread: thread({ id: 'thread-running', workspace: '/Users/zxy/project-a', status: 'running' })
      })
    ).toBe(true)
  })

  it('blocks moving a watched thread', () => {
    expect(
      isSidebarThreadMoveBlocked({
        thread: thread({ id: 'thread-watch', workspace: '/Users/zxy/project-a' }),
        watchTurnCompletion: { 'thread-watch': true }
      })
    ).toBe(true)
  })

  it('blocks moving the active thread while globally busy', () => {
    expect(
      isSidebarThreadMoveBlocked({
        thread: thread({ id: 'thread-active', workspace: '/Users/zxy/project-a' }),
        activeThreadId: 'thread-active',
        busy: true
      })
    ).toBe(true)
  })

  it('blocks moving a worktree-linked thread', () => {
    expect(
      isSidebarThreadMoveBlocked({
        thread: thread({ id: 'thread-worktree', workspace: '/Users/zxy/.kun/worktrees/abcd/project-a' }),
        worktreeRecord: {
          projectPath: '/Users/zxy/project-a',
          worktreePath: '/Users/zxy/.kun/worktrees/abcd/project-a'
        }
      })
    ).toBe(true)
  })
})
