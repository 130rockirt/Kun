/** @vitest-environment jsdom */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolBlock } from '../../agent/types'
import { useChatStore } from '../../store/chat-store'
import { useWriteWorkspaceStore } from '../../write/write-workspace-store'
import { subscribeKnowledgeSourceNavigation } from '../../lib/knowledge-source-navigation'
import { KnowledgeEvidenceDetail } from './KnowledgeEvidenceDetail'

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

describe('KnowledgeEvidenceDetail interactions', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    setReactActEnvironment(true)
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    useChatStore.setState(originalChatState, true)
    useWriteWorkspaceStore.setState(originalWriteState, true)
    vi.restoreAllMocks()
    setReactActEnvironment(false)
  })

  it('does not navigate or open a file when its Work workspace cannot be activated', async () => {
    const openWrite = vi.fn(async () => undefined)
    const setError = vi.fn()
    const openFile = vi.fn(async () => undefined)
    const selectWriteWorkspace = vi.fn(async () => {
      useWriteWorkspaceStore.setState({ settingsError: 'workspace activation failed' })
    })
    useChatStore.setState({
      activeThreadId: 'thr_1',
      threads: [{
        id: 'thr_1', title: 'Task', workspace: '/workspace/code', model: 'test',
        mode: 'agent', status: 'idle', updatedAt: 'now',
        knowledgeBases: [{
          id: 'kb_docs', root: '/workspace/docs', name: 'Docs',
          source: 'write-workspace', access: 'read-only'
        }]
      }],
      openWrite,
      setError
    })
    useWriteWorkspaceStore.setState({
      workspaceRoot: '/workspace/other',
      settingsError: null,
      selectWriteWorkspace,
      openFile
    })
    const block: ToolBlock = {
      kind: 'tool',
      id: 'tool_knowledge',
      summary: 'knowledge_read',
      status: 'success',
      detail: JSON.stringify({
        evidence: [{
          mountId: 'kb_docs',
          relativePath: 'guide.md',
          location: { kind: 'text', lineStart: 1, lineEnd: 2 },
          text: 'Guide',
          truncated: false
        }]
      })
    }
    const navigated = vi.fn(() => true)
    const unsubscribe = subscribeKnowledgeSourceNavigation('/workspace/docs/guide.md', navigated)
    await act(async () => root.render(createElement(KnowledgeEvidenceDetail, { block })))

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[title="knowledgeBaseOpenSource"]')?.click()
      await Promise.resolve()
    })

    expect(selectWriteWorkspace).toHaveBeenCalledWith('/workspace/docs')
    expect(openWrite).not.toHaveBeenCalled()
    expect(openFile).not.toHaveBeenCalled()
    expect(navigated).not.toHaveBeenCalled()
    expect(setError).toHaveBeenCalledWith('workspace activation failed')
    unsubscribe()
  })
})
