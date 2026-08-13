import { afterEach, describe, expect, it, vi } from 'vitest'
import { KunRuntimeProvider } from './kun-runtime'
import { rendererRuntimeClient } from './runtime-client'

/**
 * Timeline user-anchor hydration tests: the runtime keeps the active turn's
 * opening user message visible even when a long running turn produced more
 * process items than the newest page budget, and the renderer resolves the
 * current-turn user id from that anchored page instead of a later
 * background/steering user item.
 */
function installRuntimeRequest(body: string): void {
  vi.stubGlobal('window', {
    kunGui: {
      runtimeRequest: vi.fn(async () => ({ ok: true, status: 200, body }))
    }
  })
}

afterEach(() => {
  rendererRuntimeClient.invalidateSettings()
  vi.unstubAllGlobals()
})

function threadBody(turns: unknown[]): string {
  return JSON.stringify({
    id: 'thr_anchor_user',
    title: 'Anchor user',
    workspace: '/tmp',
    model: 'deepseek-chat',
    mode: 'agent',
    status: 'running',
    createdAt: 't0',
    updatedAt: 't2',
    latestSeq: 5,
    turns
  })
}

function userItem(id: string, turnId: string, text: string, extra: Record<string, unknown> = {}): unknown {
  return {
    id,
    turnId,
    threadId: 'thr_anchor_user',
    role: 'user',
    status: 'completed',
    createdAt: 't1',
    kind: 'user_message',
    text,
    ...extra
  }
}

describe('KunRuntimeProvider timeline user anchor', () => {
  it('identifies the active turn opening user message even with later user items', async () => {
    installRuntimeRequest(threadBody([
      {
        id: 'turn_old',
        threadId: 'thr_anchor_user',
        status: 'completed',
        prompt: 'old',
        createdAt: 't0',
        items: [userItem('item_old_user', 'turn_old', 'older question')]
      },
      {
        id: 'turn_active',
        threadId: 'thr_anchor_user',
        status: 'running',
        prompt: 'fix the pipeline',
        createdAt: 't1',
        items: [
          userItem('item_active_user', 'turn_active', 'fix the pipeline'),
          {
            id: 'item_active_tool',
            turnId: 'turn_active',
            threadId: 'thr_anchor_user',
            role: 'tool',
            status: 'running',
            createdAt: 't1',
            kind: 'tool_call',
            toolName: 'bash',
            callId: 'call_1',
            arguments: {}
          },
          userItem('item_active_background', 'turn_active', 'background subagent finished', {
            messageSource: 'background_subagent'
          })
        ]
      }
    ]))

    const detail = await new KunRuntimeProvider().getThreadDetail('thr_anchor_user')
    // The reverse scan used to pick the last user item (the background
    // notice); the anchored contract must pick the active turn's opening
    // user message instead.
    expect(detail.latestTurnId).toBe('turn_active')
    expect(detail.latestUserMessageId).toBe('item_active_user')
  })

  it('falls back to the last user item when the latest turn has no user message in the page', async () => {
    installRuntimeRequest(threadBody([
      {
        id: 'turn_old',
        threadId: 'thr_anchor_user',
        status: 'completed',
        prompt: 'old',
        createdAt: 't0',
        items: [userItem('item_old_user', 'turn_old', 'legacy page without anchor')]
      },
      {
        id: 'turn_active',
        threadId: 'thr_anchor_user',
        status: 'running',
        prompt: 'continue',
        createdAt: 't0',
        items: [
          {
            id: 'item_active_tool',
            turnId: 'turn_active',
            threadId: 'thr_anchor_user',
            role: 'tool',
            status: 'running',
            createdAt: 't0',
            kind: 'tool_call',
            toolName: 'bash',
            callId: 'call_1',
            arguments: {}
          }
        ]
      }
    ]))

    const detail = await new KunRuntimeProvider().getThreadDetail('thr_anchor_user')
    // The active turn produced no user_message on this page (legacy runtime
    // without anchoring): keep the old reverse-scan fallback so the busy
    // renderer still resolves a user block id.
    expect(detail.latestTurnId).toBe('turn_active')
    expect(detail.latestUserMessageId).toBe('item_old_user')
  })
})
