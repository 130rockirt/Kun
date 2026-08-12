import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatBlock, NormalizedThread } from '../../agent/types'
import { useWriteWorkspaceStore } from '../../write/write-workspace-store'
import { useWorkbenchPptWhiteboardRouter } from './useWorkbenchPptWhiteboardRouter'

type FindPptBoardInput = Parameters<ReturnType<typeof useWriteWorkspaceStore.getState>['findOrCreatePptWhiteboard']>[0]
const originalFindOrCreatePptWhiteboard = useWriteWorkspaceStore.getState().findOrCreatePptWhiteboard
const originalUpdateWhiteboardPptState = useWriteWorkspaceStore.getState().updateWhiteboardPptState

function directionBundle(workflowId: string) {
  return {
    schemaVersion: 1, workflowId, childId: `child-${workflowId}`,
    manifestPath: 'deck/.kun-ppt-review/manifest.json', previewMode: 'image-first',
    deckTitle: 'Direction deck', phase: 'awaiting_direction', recommendedDirectionId: 'signal',
    slides: [{ slideId: 'slide-1', index: 0, title: 'Opening' }],
    directions: ['editorial', 'signal', 'warm'].map((directionId, index) => ({
      directionId, name: `${directionId} direction`,
      rationale: `A distinct ${directionId} visual direction for this presentation.`,
      revision: index + 1, recommended: directionId === 'signal',
      fonts: [`Display ${index}`, `Body ${index}`],
      colors: ['#0F172A', '#F8FAFC', '#22C55E', '#F59E0B'],
      layout: `${index + 2}-column grid`, background: 'solid', imagery: 'editorial photography',
      previews: ['cover', 'representative', 'complex'].map((role) => ({
        role, imagePath: `.kun/images/${directionId}-${role}.png`
      }))
    }))
  }
}

function tool(id: string, detail: Record<string, unknown>): ChatBlock {
  return {
    kind: 'tool', id, summary: 'PPT', status: 'success',
    meta: { toolName: 'ppt_agent' }, detail: JSON.stringify(detail)
  }
}

const activeThread: NormalizedThread = {
  id: 'thread-a', title: 'PPT', updatedAt: '2026-08-13T00:00:00.000Z',
  model: 'deepseek-v4-pro', mode: 'agent', workspace: '/work', status: 'running',
  agentSurface: 'write'
}

function RouterHarness({ blocks }: { blocks: ChatBlock[] }): null {
  useWorkbenchPptWhiteboardRouter({
    activeThreadId: activeThread.id,
    blocks,
    route: 'write',
    threads: [activeThread],
    workspaceRoot: '/work'
  })
  return null
}

describe('useWorkbenchPptWhiteboardRouter', () => {
  afterEach(() => {
    useWriteWorkspaceStore.getState().resetWorkspace()
    useWriteWorkspaceStore.setState({
      findOrCreatePptWhiteboard: originalFindOrCreatePptWhiteboard,
      updateWhiteboardPptState: originalUpdateWhiteboardPptState
    })
  })

  it('routes every recovered PPT result and updates each canonical board', async () => {
    const findOrCreatePptWhiteboard = vi.fn(async (input: FindPptBoardInput) => ({
      id: `board-${input.workflowId}`, title: 'Review', workspaceRoot: '/work',
      threadId: input.threadId, workflowId: input.workflowId, childId: input.childId,
      phase: 'blank' as const, revision: 0,
      createdAt: '2026-08-13T00:00:00.000Z', updatedAt: '2026-08-13T00:00:00.000Z'
    }))
    const updateWhiteboardPptState = vi.fn(async () => true)
    useWriteWorkspaceStore.setState({
      workspaceRoot: '/work',
      findOrCreatePptWhiteboard,
      updateWhiteboardPptState
    })
    const blocks = [
      tool('direction-a', { directionBundle: directionBundle('workflow-a') }),
      tool('direction-b', { directionBundle: directionBundle('workflow-b') })
    ]

    let renderer: ReturnType<typeof create> | undefined
    await act(async () => { renderer = create(createElement(RouterHarness, { blocks })) })
    await vi.waitFor(() => expect(updateWhiteboardPptState).toHaveBeenCalledTimes(2))

    expect(findOrCreatePptWhiteboard.mock.calls.map(([input]) => input.workflowId)).toEqual([
      'workflow-a', 'workflow-b'
    ])
    expect(updateWhiteboardPptState).toHaveBeenNthCalledWith(
      1, 'board-workflow-a', expect.objectContaining({ phase: 'directions', revision: 3 })
    )
    await act(async () => renderer?.unmount())
  })
})
