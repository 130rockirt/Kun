import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import type { ToolBlock } from '../../agent/types'
import { useChatStore } from '../../store/chat-store'
import { useCanvasSelectionStore } from './canvas-selection-store'
import { useCanvasShapeStore } from './canvas-shape-store'
import { createEmptyDocument } from './canvas-types'
import { useApplyShapeOpsLive } from './use-apply-shape-ops-live'

function directionBundle(workflowId = 'workflow-a'): Record<string, unknown> {
  return {
    schemaVersion: 1, workflowId, childId: 'child-a',
    manifestPath: 'deck/.kun-ppt-review/manifest.json', previewMode: 'image-first',
    deckTitle: 'Direction deck', phase: 'awaiting_direction', recommendedDirectionId: 'signal',
    slides: [{ slideId: 'slide-1', index: 0, title: 'Opening' }],
    directions: ['editorial', 'signal', 'warm'].map((directionId, index) => ({
      directionId, name: `${directionId} direction`,
      rationale: `A distinct ${directionId} visual direction for this presentation.`,
      revision: 1, recommended: directionId === 'signal',
      fonts: [`Display ${index}`, `Body ${index}`],
      colors: ['#0F172A', '#F8FAFC', '#22C55E', '#F59E0B'],
      layout: `${index + 2}-column grid`, background: 'solid', imagery: 'editorial photography',
      previews: ['cover', 'representative', 'complex'].map((role) => ({
        role, imagePath: `.kun/images/${directionId}-${role}.png`
      }))
    }))
  }
}

function DirectionReplayHarness(): null {
  useApplyShapeOpsLive(true, undefined, undefined, undefined, 'thread-a')
  return null
}

function FilteredDirectionReplayHarness({
  workflowId,
  expectedDocumentKey,
  onOpenRequested
}: {
  workflowId: string
  expectedDocumentKey?: string
  onOpenRequested: (request: {
    blockId: string
    childId: string
    workflowId: string
    phase: 'direction' | 'review'
  }) => void
}): null {
  useApplyShapeOpsLive(
    true, undefined, undefined, undefined, 'thread-a',
    undefined, undefined, undefined, expectedDocumentKey,
    { workflowId, onOpenRequested }
  )
  return null
}

async function restoreAfterReplay(
  renderer: ReturnType<typeof create> | undefined,
  previous: ReturnType<typeof useChatStore.getState>
): Promise<void> {
  await act(async () => renderer?.unmount())
  useCanvasShapeStore.getState().resetDocument()
  useCanvasSelectionStore.getState().clearSelection()
  useChatStore.setState({
    activeThreadId: previous.activeThreadId,
    currentTurnId: previous.currentTurnId,
    busy: previous.busy,
    blocks: previous.blocks
  })
}

describe('PPT canvas projection replay', () => {
  it('applies a direction bundle and leaves recommendation fallback unselected', async () => {
    const previous = useChatStore.getState()
    const block: ToolBlock = {
      kind: 'tool', id: 'direction-tool', summary: 'PPT directions', status: 'success',
      meta: { toolName: 'ppt_agent', sourceItemKind: 'tool_result' },
      detail: JSON.stringify({ directionBundle: directionBundle() })
    }
    useCanvasShapeStore.getState().resetDocument()
    useCanvasSelectionStore.getState().select(['stale-selection'])
    useChatStore.setState({
      activeThreadId: 'thread-a', currentTurnId: null, busy: false, blocks: [block]
    })

    let renderer: ReturnType<typeof create> | undefined
    await act(async () => { renderer = create(createElement(DirectionReplayHarness)) })
    const shapes = Object.values(useCanvasShapeStore.getState().document.objects)
    expect(shapes.filter((shape) => shape.pptDirectionRef?.role === 'direction-card')).toHaveLength(3)
    expect(shapes.filter((shape) => shape.pptDirectionRef?.role === 'preview-image')).toHaveLength(9)
    expect(useCanvasSelectionStore.getState().selectedIds.size).toBe(0)
    await restoreAfterReplay(renderer, previous)
  })

  it('projects only the Work board workflow and uses its open callback', async () => {
    const previous = useChatStore.getState()
    const tool = (id: string, workflowId: string): ToolBlock => ({
      kind: 'tool', id, summary: 'Directions', status: 'success',
      meta: { toolName: 'ppt_agent', sourceItemKind: 'tool_result' },
      detail: JSON.stringify({ directionBundle: directionBundle(workflowId) })
    })
    const onOpenRequested = vi.fn()
    useCanvasShapeStore.getState().loadDocument(createEmptyDocument(), 'work-board-a')
    useChatStore.setState({
      activeThreadId: 'thread-a', currentTurnId: null, busy: false,
      blocks: [tool('direction-foreign', 'workflow-b'), tool('direction-target', 'workflow-a')]
    })

    let renderer: ReturnType<typeof create> | undefined
    await act(async () => {
      renderer = create(createElement(FilteredDirectionReplayHarness, {
        workflowId: 'workflow-a', expectedDocumentKey: 'work-board-a', onOpenRequested
      }))
    })
    const cards = Object.values(useCanvasShapeStore.getState().document.objects)
      .filter((shape) => shape.pptDirectionRef?.role === 'direction-card')
    expect(cards).toHaveLength(3)
    expect(cards.every((shape) => shape.pptDirectionRef?.workflowId === 'workflow-a')).toBe(true)
    expect(onOpenRequested).toHaveBeenCalledWith({
      blockId: 'direction-target', childId: 'child-a', workflowId: 'workflow-a', phase: 'direction'
    })
    await restoreAfterReplay(renderer, previous)
  })

  it('does not replay PPT output into a stale Work canvas document key', async () => {
    const previous = useChatStore.getState()
    const block: ToolBlock = {
      kind: 'tool', id: 'direction-target', summary: 'Target directions', status: 'success',
      meta: { toolName: 'ppt_agent', sourceItemKind: 'tool_result' },
      detail: JSON.stringify({ directionBundle: directionBundle('workflow-a') })
    }
    const onOpenRequested = vi.fn()
    useCanvasShapeStore.getState().loadDocument(createEmptyDocument(), 'work-board-other')
    useChatStore.setState({
      activeThreadId: 'thread-a', currentTurnId: null, busy: false, blocks: [block]
    })

    let renderer: ReturnType<typeof create> | undefined
    await act(async () => {
      renderer = create(createElement(FilteredDirectionReplayHarness, {
        workflowId: 'workflow-a', expectedDocumentKey: 'work-board-a', onOpenRequested
      }))
    })
    expect(Object.values(useCanvasShapeStore.getState().document.objects)
      .filter((shape) => shape.pptDirectionRef)).toEqual([])
    expect(onOpenRequested).not.toHaveBeenCalled()
    await restoreAfterReplay(renderer, previous)
  })
})
