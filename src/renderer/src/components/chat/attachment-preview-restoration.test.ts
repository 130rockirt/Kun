import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatBlock, NormalizedThread } from '../../agent/types'
import { resetProviderCacheForTests } from '../../agent/registry'
import { useChatStore } from '../../store/chat-store'
import { attachmentPreviewLoader } from './attachment-preview-loader'
import { MessageBubble } from './message-timeline-bubbles'

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

describe('historical attachment preview restoration', () => {
  beforeEach(() => {
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    vi.stubGlobal('window', globalThis)
    vi.stubGlobal('IntersectionObserver', undefined)
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
})
