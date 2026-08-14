import { describe, expect, it, vi } from 'vitest'
import type { ChatBlock, ToolBlock } from '../../agent/types'
import { createEmptyDocument } from './canvas-types'
import { replayDurableCodeCanvasToolBlocks } from './canvas-code-turn-replay'

function tool(id: string): ToolBlock {
  return {
    kind: 'tool', id, summary: id, status: 'success',
    meta: { toolName: 'design_update_shapes', sourceItemKind: 'tool_result' },
    detail: '{"ops":[]}'
  }
}

describe('durable Code canvas tool replay', () => {
  it('does not replay a Design-targeted turn into the Code whiteboard', () => {
    const targeted = tool('tool-design-targeted')
    const blocks: ChatBlock[] = [
      {
        kind: 'user', id: 'user-design', turnId: 'turn-design', text: 'Draw it',
        meta: {
          designDocumentTarget: {
            documentId: 'doc-design',
            boardArtifactId: 'board-design'
          }
        }
      },
      targeted
    ]
    const onToolBlock = vi.fn()
    const onTurnComplete = vi.fn()

    replayDurableCodeCanvasToolBlocks({
      threadId: 'thread-code',
      blocks,
      document: createEmptyDocument(),
      onTurnStart: vi.fn(),
      onToolBlock,
      onTurnComplete
    })

    expect(onToolBlock).not.toHaveBeenCalled()
    expect(onTurnComplete).not.toHaveBeenCalled()
  })

  it('resumes after a legacy journaled result within the same turn', () => {
    const alreadyApplied = tool('tool-applied')
    const missed = tool('tool-missed')
    const blocks: ChatBlock[] = [
      { kind: 'user', id: 'user-1', turnId: 'turn-1', text: 'Update the board' },
      alreadyApplied,
      missed
    ]
    const document = createEmptyDocument()
    document.operationJournal = [{
      id: 'journal-1',
      label: 'tool:tool-applied:0',
      status: 'applied',
      createdAt: '2026-08-13T00:00:00.000Z',
      operations: [],
      affectedIds: [],
      errors: []
    }]
    const onToolBlock = vi.fn()
    const onTurnComplete = vi.fn()

    replayDurableCodeCanvasToolBlocks({
      threadId: 'thread-code',
      blocks,
      document,
      onTurnStart: vi.fn(),
      onToolBlock,
      onTurnComplete
    })

    expect(onToolBlock).toHaveBeenCalledOnce()
    expect(onToolBlock).toHaveBeenCalledWith(
      missed,
      blocks,
      'thread-code\0turn-1\0code-canvas\0tool:tool-missed',
      'turn-1'
    )
    expect(onTurnComplete).toHaveBeenCalledWith('turn-1')
  })
})
