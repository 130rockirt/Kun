// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NormalizedThread } from '../../agent/types'
import { useChatStore } from '../../store/chat-store'
import { MessageTimeline } from './MessageTimeline'

const activeThread: NormalizedThread = {
  id: 'thread-target',
  title: 'Target',
  updatedAt: '2026-08-23T00:00:00.000Z',
  model: 'deepseek-v4-pro',
  mode: 'agent',
  workspace: '/workspace/deepseek-gui',
  status: 'idle'
}

describe('MessageTimeline hydration presentation', () => {
  let container: HTMLDivElement
  let root: Root | null = null

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    vi.stubGlobal('ResizeObserver', class {
      observe(): void {}
      disconnect(): void {}
    })
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(0)
      return 1
    })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined)
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn()
    })
    useChatStore.setState({
      route: 'chat',
      workspaceRoot: '/workspace/deepseek-gui',
      activeThreadId: activeThread.id,
      threadLoadingId: activeThread.id,
      threads: [activeThread],
      busy: false,
      busyUnconfirmed: false,
      currentTurnId: null,
      currentTurnUserId: null,
      turnStartedAtByUserId: {},
      turnDurationByUserId: {},
      turnReasoningFirstAtByUserId: {},
      turnReasoningLastAtByUserId: {},
      clawChannels: [],
      activeClawChannelId: ''
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    if (root) await act(async () => root?.unmount())
    root = null
    container.remove()
    delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('mounts only loading until the target projection becomes ready', async () => {
    const element = createElement(MessageTimeline, {
      blocks: [{ kind: 'assistant', id: 'target-answer', text: 'target-ready-content' }],
      liveReasoning: '',
      live: '',
      activeThreadId: activeThread.id,
      runtimeConnection: 'ready',
      onRetryConnection: () => undefined,
      onOpenSettings: () => undefined
    })
    await act(async () => root!.render(element))

    expect(container.querySelector('[data-testid="thread-hydration-loading"]')).not.toBeNull()
    expect(container.textContent).not.toContain('target-ready-content')
    expect(container.querySelector('.timeline-jump-rail')).toBeNull()

    await act(async () => useChatStore.setState({ threadLoadingId: null }))

    expect(container.querySelector('[data-testid="thread-hydration-loading"]')).toBeNull()
    expect(container.textContent).toContain('target-ready-content')
  })
})
