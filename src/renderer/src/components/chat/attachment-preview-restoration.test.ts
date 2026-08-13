import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatBlock, NormalizedThread, ToolBlock } from '../../agent/types'
import { resetProviderCacheForTests } from '../../agent/registry'
import { useChatStore } from '../../store/chat-store'
import { attachmentPreviewLoader } from './attachment-preview-loader'
import { GeneratedFilesPanel, MessageBubble } from './message-timeline-bubbles'
import { TimelineFilePreviewWorkspaceProvider } from './timeline-file-preview-workspace'

const activeThread: NormalizedThread = {
  id: 'thr_1',
  title: 'Thread',
  updatedAt: '2026-07-26T00:00:00.000Z',
  model: 'deepseek-chat',
  mode: 'code',
  workspace: '/tmp/project'
}

const historicalImageBlock: ChatBlock = {
  kind: 'user',
  id: 'user_1',
  text: '重新打开这张图片',
  meta: {
    attachmentIds: ['att_1']
  }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve
  })
  return { promise, resolve }
}

function generatedImageBlock(input: {
  attachmentId: string
  name: string
  relativePath: string
}): ToolBlock {
  return {
    kind: 'tool',
    id: `tool_${input.attachmentId}`,
    summary: 'generate_image',
    status: 'success',
    meta: {
      toolName: 'generate_image',
      generatedFiles: [{
        name: input.name,
        relativePath: input.relativePath,
        mimeType: 'image/png'
      }],
      attachments: [{
        id: input.attachmentId,
        name: input.name,
        mimeType: 'image/png'
      }]
    }
  }
}

function attachmentContentBody(input: {
  attachmentId: string
  name: string
  threadId: string
  dataBase64: string
}): string {
  return JSON.stringify({
    attachment: {
      id: input.attachmentId,
      kind: 'image',
      name: input.name,
      mimeType: 'image/png',
      byteSize: 3,
      hash: `hash_${input.attachmentId}`,
      width: 16,
      height: 9,
      threadIds: [input.threadId],
      workspaces: ['/tmp/project'],
      createdAt: '2026-07-26T00:00:00.000Z',
      updatedAt: '2026-07-26T00:00:00.000Z'
    },
    dataBase64: input.dataBase64
  })
}

function generatedImagePanel(threadId: string, block: ToolBlock) {
  return createElement(
    TimelineFilePreviewWorkspaceProvider,
    {
      workspaceRoot: '/tmp/project',
      threadId,
      children: createElement(GeneratedFilesPanel, { blocks: [block] })
    }
  )
}

function mediaNodeMock() {
  return {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    scrollBy: vi.fn(),
    clientWidth: 640,
    scrollWidth: 640,
    scrollLeft: 0
  }
}

describe('historical attachment preview restoration', () => {
  beforeEach(() => {
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    vi.stubGlobal('window', globalThis)
    vi.stubGlobal('IntersectionObserver', undefined)
    vi.stubGlobal('ResizeObserver', class {
      observe(): void {}
      disconnect(): void {}
    })
    attachmentPreviewLoader.clear()
    resetProviderCacheForTests()
    useChatStore.setState({
      route: 'chat',
      workspaceRoot: '/tmp/project',
      activeThreadId: 'thr_1',
      threads: [activeThread],
      busy: false,
      currentTurnUserId: null,
      turnStartedAtByUserId: {},
      turnDurationByUserId: {},
      turnReasoningFirstAtByUserId: {},
      turnReasoningLastAtByUserId: {},
      clawChannels: [],
      activeClawChannelId: ''
    })
  })

  afterEach(() => {
    attachmentPreviewLoader.clear()
    resetProviderCacheForTests()
    delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT
    vi.unstubAllGlobals()
  })

  it('renders an ID-only image after runtime resolution and reuses its metadata after remount', async () => {
    const runtimeRequest = vi.fn(async () => ({
      ok: true,
      status: 200,
      body: JSON.stringify({
        attachment: {
          id: 'att_1',
          kind: 'image',
          name: 'restored-image.png',
          mimeType: 'image/png',
          byteSize: 3,
          hash: 'hash',
          width: 16,
          height: 9,
          threadIds: ['thr_1'],
          workspaces: ['/tmp/project'],
          createdAt: '2026-07-26T00:00:00.000Z',
          updatedAt: '2026-07-26T00:00:00.000Z'
        },
        dataBase64: 'AQID'
      })
    }))
    vi.stubGlobal('kunGui', {
      runtimeRequest
    })

    let renderer: ReactTestRenderer | undefined
    await act(async () => {
      renderer = create(createElement(MessageBubble, { block: historicalImageBlock }), {
        createNodeMock: () => ({})
      })
    })
    await act(async () => {
      await vi.waitFor(() => expect(renderer?.root.findAllByType('img')).toHaveLength(1))
    })

    const firstImage = renderer?.root.findByType('img')
    expect(firstImage?.props.src).toBe('data:image/png;base64,AQID')
    expect(firstImage?.props.alt).toBe('restored-image.png')
    expect(runtimeRequest).toHaveBeenCalledWith(
      '/v1/attachments/att_1/content?thread_id=thr_1&workspace=%2Ftmp%2Fproject',
      'GET'
    )

    await act(async () => renderer?.unmount())
    await act(async () => {
      renderer = create(createElement(MessageBubble, { block: historicalImageBlock }), {
        createNodeMock: () => ({})
      })
    })
    await act(async () => {
      await vi.waitFor(() => expect(renderer?.root.findAllByType('img')).toHaveLength(1))
    })

    expect(renderer?.root.findByType('img').props.alt).toBe('restored-image.png')
    expect(runtimeRequest).toHaveBeenCalledTimes(1)
    await act(async () => renderer?.unmount())
  })

  it('shows loading before resolution and unavailable only after a real failure', async () => {
    const gate = deferred<{ ok: boolean; status: number; body: string }>()
    const runtimeRequest = vi.fn(() => gate.promise)
    vi.stubGlobal('kunGui', { runtimeRequest })

    let renderer: ReactTestRenderer | undefined
    await act(async () => {
      renderer = create(createElement(MessageBubble, { block: historicalImageBlock }), {
        createNodeMock: () => ({})
      })
    })
    await act(async () => {
      await vi.waitFor(() => expect(runtimeRequest).toHaveBeenCalledTimes(1))
    })

    expect(renderer?.root.findAll(
      (node) => node.props['data-attachment-preview-state'] === 'loading'
    )).toHaveLength(1)
    expect(renderer?.root.findAll(
      (node) => node.props['data-attachment-preview-state'] === 'failed'
    )).toHaveLength(0)

    await act(async () => {
      gate.resolve({
        ok: false,
        status: 503,
        body: JSON.stringify({ error: { message: 'attachment unavailable' } })
      })
    })
    await act(async () => {
      await vi.waitFor(() => expect(renderer?.root.findAll(
        (node) => node.props['data-attachment-preview-state'] === 'failed'
      )).toHaveLength(1))
    })

    await act(async () => renderer?.unmount())
  })

  it('uses the rendered Work child thread when the parent remains globally selected', async () => {
    useChatStore.setState({ activeThreadId: 'write-parent' })
    const block = generatedImageBlock({
      attachmentId: 'att_work_child',
      name: 'work-child.png',
      relativePath: '.kun/images/work-child.png'
    })
    const runtimeRequest = vi.fn(async () => ({
      ok: true,
      status: 200,
      body: attachmentContentBody({
        attachmentId: 'att_work_child',
        name: 'work-child.png',
        threadId: 'write-child',
        dataBase64: 'Y2hpbGQ='
      })
    }))
    vi.stubGlobal('kunGui', { runtimeRequest })

    let renderer: ReactTestRenderer | undefined
    await act(async () => {
      renderer = create(generatedImagePanel('write-child', block), {
        createNodeMock: mediaNodeMock
      })
    })
    await act(async () => {
      await vi.waitFor(() => expect(renderer?.root.findAllByType('img')).toHaveLength(1))
    })

    expect(runtimeRequest).toHaveBeenCalledWith(
      '/v1/attachments/att_work_child/content?thread_id=write-child&workspace=%2Ftmp%2Fproject',
      'GET'
    )
    expect(useChatStore.getState().activeThreadId).toBe('write-parent')
    expect(renderer?.root.findByType('img').props.src).toBe('data:image/png;base64,Y2hpbGQ=')
    await act(async () => renderer?.unmount())
  })

  it('falls back to the generated workspace path when attachment access fails', async () => {
    const block = generatedImageBlock({
      attachmentId: 'att_workspace_fallback',
      name: 'workspace-fallback.png',
      relativePath: '.kun/images/workspace-fallback.png'
    })
    const runtimeRequest = vi.fn(async () => ({
      ok: false,
      status: 403,
      body: JSON.stringify({ error: { message: 'attachment scope mismatch' } })
    }))
    const readWorkspaceImage = vi.fn(async () => ({
      ok: true,
      dataUrl: 'data:image/png;base64,d29ya3NwYWNl'
    }))
    vi.stubGlobal('kunGui', { runtimeRequest, readWorkspaceImage })

    let renderer: ReactTestRenderer | undefined
    await act(async () => {
      renderer = create(generatedImagePanel('write-child', block), {
        createNodeMock: mediaNodeMock
      })
    })
    await act(async () => {
      await vi.waitFor(() => expect(renderer?.root.findAllByType('img')).toHaveLength(1))
    })

    expect(runtimeRequest).toHaveBeenCalledWith(
      '/v1/attachments/att_workspace_fallback/content?thread_id=write-child&workspace=%2Ftmp%2Fproject',
      'GET'
    )
    expect(readWorkspaceImage).toHaveBeenCalledWith({
      path: '.kun/images/workspace-fallback.png',
      workspaceRoot: '/tmp/project'
    })
    expect(renderer?.root.findByType('img').props.src).toBe(
      'data:image/png;base64,d29ya3NwYWNl'
    )
    await act(async () => renderer?.unmount())
  })

  it('retries the same generated image after the rendered thread scope changes', async () => {
    const block = generatedImageBlock({
      attachmentId: 'att_scope_retry',
      name: 'scope-retry.png',
      relativePath: '.kun/images/scope-retry.png'
    })
    const runtimeRequest = vi.fn(async (path: string) => {
      if (path.includes('thread_id=write-child-denied')) {
        return {
          ok: false,
          status: 403,
          body: JSON.stringify({ error: { message: 'attachment scope mismatch' } })
        }
      }
      return {
        ok: true,
        status: 200,
        body: attachmentContentBody({
          attachmentId: 'att_scope_retry',
          name: 'scope-retry.png',
          threadId: 'write-child-allowed',
          dataBase64: 'cmV0cnk='
        })
      }
    })
    vi.stubGlobal('kunGui', { runtimeRequest })

    let renderer: ReactTestRenderer | undefined
    await act(async () => {
      renderer = create(generatedImagePanel('write-child-denied', block), {
        createNodeMock: mediaNodeMock
      })
    })
    await act(async () => {
      await vi.waitFor(() => expect(renderer?.root.findAll(
        (node) => node.props['data-attachment-preview-state'] === 'failed'
      )).toHaveLength(1))
    })

    await act(async () => {
      renderer?.update(generatedImagePanel('write-child-allowed', block))
    })
    await act(async () => {
      await vi.waitFor(() => expect(renderer?.root.findAllByType('img')).toHaveLength(1))
    })

    expect(runtimeRequest).toHaveBeenNthCalledWith(
      1,
      '/v1/attachments/att_scope_retry/content?thread_id=write-child-denied&workspace=%2Ftmp%2Fproject',
      'GET'
    )
    expect(runtimeRequest).toHaveBeenNthCalledWith(
      2,
      '/v1/attachments/att_scope_retry/content?thread_id=write-child-allowed&workspace=%2Ftmp%2Fproject',
      'GET'
    )
    expect(renderer?.root.findByType('img').props.src).toBe('data:image/png;base64,cmV0cnk=')
    await act(async () => renderer?.unmount())
  })
})
