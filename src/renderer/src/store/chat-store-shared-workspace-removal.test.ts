/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NormalizedThread } from '../agent/types'
import {
  REMOVED_CODE_WORKSPACES_STORAGE_KEY,
  emptyRemovedCodeWorkspacesRegistry
} from '../lib/removed-code-workspaces'
import {
  SHARED_BUSINESS_STORAGE_CHANGED_EVENT,
  type SharedBusinessStorageChangedDetail
} from '../lib/shared-business-storage'
import { useChatStore } from './chat-store'

function thread(id: string, workspace: string): NormalizedThread {
  return {
    id,
    title: id,
    updatedAt: '2026-08-28T00:00:00.000Z',
    model: 'deepseek-v4-pro',
    mode: 'agent',
    workspace
  }
}

describe('chat store shared workspace removals', () => {
  afterEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
  })

  it('applies a remote tombstone to current roots and selection immediately', () => {
    const hidden = thread('thr-hidden', '/project')
    useChatStore.setState({
      activeThreadId: hidden.id,
      lastCodeThreadId: hidden.id,
      workspaceRoot: '/project',
      workspaceLabel: 'project',
      codeWorkspaceRoots: ['/project'],
      removedCodeWorkspaces: emptyRemovedCodeWorkspacesRegistry(),
      runtimeConnection: 'offline',
      threads: [hidden]
    })
    localStorage.setItem(REMOVED_CODE_WORKSPACES_STORAGE_KEY, JSON.stringify({
      version: 1,
      removed: [{ projectPath: '/project', aliases: [], removedAt: 'now' }]
    }))

    window.dispatchEvent(new CustomEvent<SharedBusinessStorageChangedDetail>(
      SHARED_BUSINESS_STORAGE_CHANGED_EVENT,
      { detail: { keys: [REMOVED_CODE_WORKSPACES_STORAGE_KEY] } }
    ))

    const state = useChatStore.getState()
    expect(state.workspaceRoot).toBe('')
    expect(state.activeThreadId).toBeNull()
    expect(state.lastCodeThreadId).toBeNull()
    expect(state.codeWorkspaceRoots).toEqual([])
    expect(state.threads).toEqual([hidden])
  })
})
