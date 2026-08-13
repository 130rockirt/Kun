/** @vitest-environment jsdom */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { rendererRuntimeClient } from '../../agent/runtime-client'
import { useChatStore } from '../../store/chat-store'
import { useWriteWorkspaceStore } from '../../write/write-workspace-store'
import { KnowledgeBasePicker } from './KnowledgeBasePicker'

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key })
}))

const originalChatState = useChatStore.getState()
const originalWriteState = useWriteWorkspaceStore.getState()

function setReactActEnvironment(value: boolean): void {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
    .IS_REACT_ACT_ENVIRONMENT = value
}

describe('KnowledgeBasePicker interactions', () => {
  let container: HTMLDivElement
  let root: Root
  let setError: ReturnType<typeof vi.fn>
  let setMounts: ReturnType<typeof vi.fn>
  let openWrite: ReturnType<typeof vi.fn>

  beforeEach(() => {
    setReactActEnvironment(true)
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    setError = vi.fn()
    setMounts = vi.fn(async () => true)
    openWrite = vi.fn(async () => undefined)
    useChatStore.setState({
      activeThreadId: 'thr_1',
      threads: [{
        id: 'thr_1',
        title: 'Knowledge task',
        workspace: '/workspace/code',
        model: 'test',
        mode: 'agent',
        status: 'idle',
        updatedAt: 'now',
        knowledgeBases: [{
          id: 'kb_docs',
          root: '/workspace/docs',
          name: 'Docs',
          source: 'write-workspace',
          access: 'read-only'
        }]
      }],
      knowledgeBaseStatuses: {},
      busy: false,
      runtimeConnection: 'ready',
      refreshThreadKnowledgeBases: vi.fn(async () => undefined),
      setThreadKnowledgeBases: setMounts,
      reindexThreadKnowledgeBase: vi.fn(async () => true),
      openWrite,
      setError
    })
    useWriteWorkspaceStore.setState({
      workspaceRoot: '/workspace/other',
      workspaceRoots: ['/workspace/other'],
      settingsError: null
    })
    Object.defineProperty(window, 'kunGui', {
      configurable: true,
      value: {
        pickWorkspaceDirectory: vi.fn(async () => ({ canceled: true }))
      }
    })
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    useChatStore.setState(originalChatState, true)
    useWriteWorkspaceStore.setState(originalWriteState, true)
    vi.restoreAllMocks()
    setReactActEnvironment(false)
  })

  it('keeps mounted roots visible and contains configured-workspace load failures', async () => {
    vi.spyOn(rendererRuntimeClient, 'getSettings').mockRejectedValue(new Error('settings unavailable'))
    await act(async () => root.render(createElement(KnowledgeBasePicker)))

    const trigger = container.querySelector<HTMLButtonElement>('[title="knowledgeBaseTitle"]')
    await act(async () => {
      trigger?.click()
      await Promise.resolve()
    })

    expect(container.textContent).toContain('/workspace/docs')
    expect(setError).toHaveBeenCalledWith('settings unavailable')
  })

  it('does not mount a picked directory when adding it to Work fails', async () => {
    vi.spyOn(rendererRuntimeClient, 'getSettings').mockResolvedValue({
      write: {
        defaultWorkspaceRoot: '/workspace/other',
        activeWorkspaceRoot: '/workspace/other',
        workspaces: ['/workspace/other']
      }
    } as never)
    vi.mocked(window.kunGui.pickWorkspaceDirectory).mockResolvedValue({
      canceled: false,
      path: '/workspace/new-docs'
    })
    const addWriteWorkspace = vi.fn(async () => {
      useWriteWorkspaceStore.setState({ settingsError: 'could not save Work settings' })
    })
    useWriteWorkspaceStore.setState({ addWriteWorkspace })
    await act(async () => root.render(createElement(KnowledgeBasePicker)))
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[title="knowledgeBaseTitle"]')?.click()
      await Promise.resolve()
    })
    const addButton = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('knowledgeBaseAddDirectory'))

    await act(async () => {
      addButton?.click()
      await Promise.resolve()
    })

    expect(addWriteWorkspace).toHaveBeenCalledWith('/workspace/new-docs')
    expect(setMounts).not.toHaveBeenCalled()
    expect(setError).toHaveBeenCalledWith('could not save Work settings')
  })

  it('does not leave the picker or open Work when workspace activation fails', async () => {
    vi.spyOn(rendererRuntimeClient, 'getSettings').mockResolvedValue({
      write: {
        defaultWorkspaceRoot: '/workspace/other',
        activeWorkspaceRoot: '/workspace/other',
        workspaces: ['/workspace/other', '/workspace/docs']
      }
    } as never)
    const selectWriteWorkspace = vi.fn(async () => {
      useWriteWorkspaceStore.setState({ settingsError: 'could not activate Work workspace' })
    })
    useWriteWorkspaceStore.setState({ selectWriteWorkspace })
    await act(async () => root.render(createElement(KnowledgeBasePicker)))
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[title="knowledgeBaseTitle"]')?.click()
      await Promise.resolve()
    })

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[title="knowledgeBaseOpenWrite"]')?.click()
      await Promise.resolve()
    })

    expect(selectWriteWorkspace).toHaveBeenCalledWith('/workspace/docs')
    expect(openWrite).not.toHaveBeenCalled()
    expect(container.textContent).toContain('/workspace/docs')
    expect(setError).toHaveBeenCalledWith('could not activate Work workspace')
  })
})
