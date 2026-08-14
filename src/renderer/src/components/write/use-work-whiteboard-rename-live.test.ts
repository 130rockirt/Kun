import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useChatStore } from '../../store/chat-store'
import { useWriteWorkspaceStore } from '../../write/write-workspace-store'
import {
  useWorkWhiteboardRenameLive,
  workWhiteboardRenameRequestFromBlock
} from './use-work-whiteboard-rename-live'

const mocks = vi.hoisted(() => ({ sendReceipt: vi.fn() }))

vi.mock('../../design/canvas/canvas-receipt-sender', () => ({
  sendCanvasTurnReceipt: (...args: unknown[]) => mocks.sendReceipt(...args)
}))

const now = '2026-08-14T00:00:00.000Z'

function Harness(): null {
  useWorkWhiteboardRenameLive({ boardId: 'board-1', threadId: 'thread-1' })
  return null
}

describe('useWorkWhiteboardRenameLive', () => {
  let renderer: ReactTestRenderer | undefined

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    mocks.sendReceipt.mockClear()
    useWriteWorkspaceStore.setState({
      workspaceRoot: '/work',
      whiteboards: {
        'board-1': {
          id: 'board-1', title: 'Old title', workspaceRoot: '/work', threadId: 'thread-1',
          phase: 'blank', revision: 0, createdAt: now, updatedAt: now
        }
      }
    })
    useChatStore.setState({
      activeThreadId: 'thread-1',
      currentTurnId: 'turn-1',
      threads: [{
        id: 'thread-1', title: 'Old title', updatedAt: now, model: 'auto',
        mode: 'agent', workspace: '/work', agentSurface: 'write'
      }],
      blocks: []
    })
  })

  afterEach(async () => {
    if (renderer) await act(async () => renderer?.unmount())
    renderer = undefined
    vi.unstubAllGlobals()
  })

  it('parses only accepted final Work rename results', () => {
    const block = {
      kind: 'tool' as const, id: 'tool-rename', turnId: 'turn-1', summary: 'rename',
      status: 'success' as const,
      meta: { toolName: 'work_rename_whiteboard', sourceItemKind: 'tool_result' as const },
      detail: JSON.stringify({
        tool: 'work_rename_whiteboard', action: 'rename_whiteboard',
        status: 'accepted', title: 'New title', receiptKey: 'design-receipt-1'
      })
    }
    expect(workWhiteboardRenameRequestFromBlock(block)).toEqual({
      title: 'New title', receiptKey: 'design-receipt-1', turnId: 'turn-1'
    })
    expect(workWhiteboardRenameRequestFromBlock({
      ...block,
      detail: JSON.stringify({
        tool: 'work_rename_whiteboard', action: 'rename_whiteboard',
        status: 'applied', title: 'New title', receiptKey: 'design-receipt-1'
      })
    })).toBeNull()
  })

  it('renames the bound conversation and board before acknowledging the tool', async () => {
    const renameWhiteboard = vi.fn(async (_boardId: string, title: string) => {
      useWriteWorkspaceStore.setState((state) => ({
        whiteboards: {
          ...state.whiteboards,
          'board-1': { ...state.whiteboards['board-1']!, title }
        }
      }))
      return true
    })
    const renameThread = vi.fn(async (_threadId: string, title: string) => {
      useChatStore.setState((state) => ({
        threads: state.threads.map((thread) =>
          thread.id === 'thread-1' ? { ...thread, title } : thread)
      }))
    })
    useWriteWorkspaceStore.setState({ renameWhiteboard })
    useChatStore.setState({ renameThread })
    await act(async () => { renderer = create(createElement(Harness)) })

    await act(async () => {
      useChatStore.setState({
        blocks: [{
          kind: 'tool', id: 'tool-rename', turnId: 'turn-1', summary: 'rename', status: 'success',
          meta: { toolName: 'work_rename_whiteboard', sourceItemKind: 'tool_result' },
          detail: JSON.stringify({
            tool: 'work_rename_whiteboard', action: 'rename_whiteboard', status: 'accepted',
            title: 'Service architecture', receiptKey: 'design-receipt-rename'
          })
        }]
      })
      await vi.waitFor(() => expect(mocks.sendReceipt).toHaveBeenCalledOnce())
    })

    expect(renameThread).toHaveBeenCalledWith('thread-1', 'Service architecture')
    expect(renameWhiteboard).toHaveBeenCalledWith('board-1', 'Service architecture')
    expect(mocks.sendReceipt).toHaveBeenCalledWith({
      threadId: 'thread-1', turnId: 'turn-1', receiptKey: 'design-receipt-rename',
      affectedIds: ['whiteboard:board-1'], errors: []
    })
  })
})
