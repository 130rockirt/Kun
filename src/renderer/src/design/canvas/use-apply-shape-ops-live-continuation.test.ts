import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatBlock, NormalizedThread, ToolBlock } from '../../agent/types'
import { useChatStore } from '../../store/chat-store'
import { useDesignWorkspaceStore } from '../design-workspace-store'
import type { DesignArtifact } from '../design-types'
import { canvasDocumentKey } from './canvas-persistence'
import { useCanvasSelectionStore } from './canvas-selection-store'
import { useCanvasShapeStore } from './canvas-shape-store'
import { createEmptyDocument, createHtmlFrameShape } from './canvas-types'
import type { SvgArtifactRequestHandler } from './svg-artifact-tool-replay'
import {
  useApplyShapeOpsLive,
  type CanvasScreenCreatedHandler
} from './use-apply-shape-ops-live'

const threadId = 'thread-design'
const turnId = 'turn-design'
const target = { documentId: 'doc-design', boardArtifactId: 'board-design' }
const documentKey = canvasDocumentKey('/workspace', target.boardArtifactId, `.kun-design/${target.documentId}`)

let onScreenCreated: CanvasScreenCreatedHandler | undefined
let onSvgArtifactRequested: SvgArtifactRequestHandler | undefined
let renderers: ReactTestRenderer[] = []
let previousChat: ReturnType<typeof useChatStore.getState>
let previousArtifacts: DesignArtifact[]

function Harness(): null {
  useApplyShapeOpsLive(
    true,
    onScreenCreated,
    undefined,
    undefined,
    threadId,
    onSvgArtifactRequested,
    undefined,
    target,
    documentKey
  )
  return null
}

function designThread(latestTurnStatus?: string): NormalizedThread {
  return {
    id: threadId,
    title: 'Design thread',
    updatedAt: '2026-08-26T00:00:00.000Z',
    model: 'test-model',
    mode: 'agent',
    status: latestTurnStatus === 'running' ? 'running' : 'idle',
    latestTurnId: turnId,
    ...(latestTurnStatus ? { latestTurnStatus } : {})
  }
}

function pendingHtmlArtifact(id: string): DesignArtifact {
  const relativePath = `.kun-design/${target.documentId}/${id}/v1.html`
  return {
    id,
    kind: 'html',
    title: 'Gateway 6',
    relativePath,
    createdAt: '2026-08-26T00:00:00.000Z',
    updatedAt: '2026-08-26T00:00:00.000Z',
    versions: [],
    previewStatus: 'pending'
  }
}

function screenTurnBlocks(frameId: string): ChatBlock[] {
  return [
    {
      kind: 'user',
      id: 'user-design',
      turnId,
      text: 'Build the Gateway page',
      meta: { designDocumentTarget: target }
    },
    {
      kind: 'tool',
      id: 'tool-screen',
      turnId,
      summary: 'Update Gateway screen',
      status: 'success',
      meta: { toolName: 'design_update_shapes', sourceItemKind: 'tool_result' },
      detail: JSON.stringify({
        ops: [{ op: 'update', id: frameId, patch: { name: 'Gateway 6 restored' } }]
      })
    }
  ]
}

function svgTurnBlocks(): ChatBlock[] {
  const artifactId = 'svg-aabbccddeeff'
  const tool: ToolBlock = {
    kind: 'tool',
    id: 'tool-svg-create',
    turnId,
    summary: 'Create SVG',
    status: 'success',
    meta: { toolName: 'design_svg_create', sourceItemKind: 'tool_result' },
    detail: JSON.stringify({
      ok: true,
      ops: [{ op: 'add-svg-artifact', artifactId, name: 'Orbit', brief: 'Animated orbit' }]
    })
  }
  return [
    {
      kind: 'user', id: 'user-design', turnId, text: 'Create an animated orbit',
      meta: { designDocumentTarget: target }
    },
    tool
  ]
}

async function mountHarness(): Promise<ReactTestRenderer> {
  let renderer: ReactTestRenderer | undefined
  await act(async () => {
    renderer = create(createElement(Harness))
    await Promise.resolve()
  })
  renderers.push(renderer!)
  return renderer!
}

async function flushContinuationTimers(): Promise<void> {
  await act(async () => {
    await vi.runAllTimersAsync()
    await Promise.resolve()
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  previousChat = useChatStore.getState()
  previousArtifacts = useDesignWorkspaceStore.getState().artifacts
  onScreenCreated = undefined
  onSvgArtifactRequested = undefined
  renderers = []
  useCanvasShapeStore.getState().loadDocument(createEmptyDocument(), documentKey)
  useCanvasSelectionStore.getState().clearSelection()
  useDesignWorkspaceStore.setState({ artifacts: [] })
})

afterEach(async () => {
  await act(async () => {
    for (const renderer of renderers) renderer.unmount()
  })
  useCanvasShapeStore.getState().resetDocument()
  useCanvasSelectionStore.getState().clearSelection()
  useDesignWorkspaceStore.setState({ artifacts: previousArtifacts })
  useChatStore.setState({
    activeThreadId: previousChat.activeThreadId,
    currentTurnId: previousChat.currentTurnId,
    currentTurnUserId: previousChat.currentTurnUserId,
    busy: previousChat.busy,
    blocks: previousChat.blocks,
    threads: previousChat.threads,
    liveAssistant: previousChat.liveAssistant
  })
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('Design Canvas continuation terminal outcomes', () => {
  it.each(['aborted', 'failed'])('keeps replayed output but suppresses a %s HTML follow-up', async (status) => {
    const frame = createHtmlFrameShape('Gateway 6', 0, 0, 'html-gateway', 'desktop')
    useCanvasShapeStore.getState().addShape(frame)
    useDesignWorkspaceStore.setState({ artifacts: [pendingHtmlArtifact('html-gateway')] })
    const callback = vi.fn(() => true)
    onScreenCreated = callback
    useChatStore.setState({
      activeThreadId: threadId,
      currentTurnId: null,
      currentTurnUserId: null,
      busy: false,
      blocks: screenTurnBlocks(frame.id),
      threads: [designThread(status)],
      liveAssistant: ''
    })

    const renderer = await mountHarness()
    await flushContinuationTimers()

    expect(useCanvasShapeStore.getState().document.objects[frame.id]?.name)
      .toBe('Gateway 6 restored')
    expect(callback).not.toHaveBeenCalled()
    expect(useCanvasShapeStore.getState().document.rendererReplayWatermarkTurnId).toBe(turnId)

    await act(async () => renderer.unmount())
    renderers = renderers.filter((candidate) => candidate !== renderer)
    await mountHarness()
    await flushContinuationTimers()
    expect(callback).not.toHaveBeenCalled()
  })

  it.each(['completed', undefined])('keeps the existing follow-up behavior for %s history', async (status) => {
    const frame = createHtmlFrameShape('Gateway 6', 0, 0, 'html-gateway', 'desktop')
    useCanvasShapeStore.getState().addShape(frame)
    useDesignWorkspaceStore.setState({ artifacts: [pendingHtmlArtifact('html-gateway')] })
    const callback = vi.fn(() => true)
    onScreenCreated = callback
    useChatStore.setState({
      activeThreadId: threadId,
      currentTurnId: null,
      currentTurnUserId: null,
      busy: false,
      blocks: screenTurnBlocks(frame.id),
      threads: [designThread(status)],
      liveAssistant: ''
    })

    await mountHarness()
    await flushContinuationTimers()

    expect(callback).toHaveBeenCalledTimes(1)
    expect(callback).toHaveBeenCalledWith(frame.id, 'Build the Gateway page', undefined)
    expect(useCanvasShapeStore.getState().document.rendererReplayWatermarkTurnId).toBe(turnId)
  })

  it('does not start a follow-up when a live Design turn is stopped', async () => {
    const frame = createHtmlFrameShape('Gateway 6', 0, 0, 'html-gateway', 'desktop')
    useCanvasShapeStore.getState().addShape(frame)
    useDesignWorkspaceStore.setState({ artifacts: [pendingHtmlArtifact('html-gateway')] })
    const callback = vi.fn(() => true)
    onScreenCreated = callback
    const blocks = screenTurnBlocks(frame.id)
    useChatStore.setState({
      activeThreadId: threadId,
      currentTurnId: turnId,
      currentTurnUserId: 'user-design',
      busy: true,
      blocks,
      threads: [designThread('running')],
      liveAssistant: ''
    })
    const renderer = await mountHarness()

    await act(async () => {
      useChatStore.setState({
        currentTurnId: null,
        currentTurnUserId: null,
        busy: false,
        threads: [designThread('aborted')]
      })
    })
    await flushContinuationTimers()

    expect(useCanvasShapeStore.getState().document.objects[frame.id]?.name)
      .toBe('Gateway 6 restored')
    expect(callback).not.toHaveBeenCalled()
    expect(useCanvasShapeStore.getState().document.rendererReplayWatermarkTurnId).toBe(turnId)

    await act(async () => renderer.unmount())
    renderers = renderers.filter((candidate) => candidate !== renderer)
    await mountHarness()
    await flushContinuationTimers()
    expect(callback).not.toHaveBeenCalled()
  })

  it.each([
    ['aborted', 0],
    ['completed', 1]
  ] as const)('dispatches SVG continuation according to %s outcome', async (status, calls) => {
    const callback = vi.fn(async () => ({
      artifactId: 'svg-aabbccddeeff',
      shapeId: 'shape-svg'
    }))
    onSvgArtifactRequested = callback
    useChatStore.setState({
      activeThreadId: threadId,
      currentTurnId: null,
      currentTurnUserId: null,
      busy: false,
      blocks: svgTurnBlocks(),
      threads: [designThread(status)],
      liveAssistant: ''
    })

    await mountHarness()
    await flushContinuationTimers()

    expect(callback).toHaveBeenCalledTimes(calls)
    expect(useCanvasShapeStore.getState().document.rendererReplayWatermarkTurnId).toBe(turnId)
  })
})
