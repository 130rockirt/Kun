import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useChatStore } from '../store/chat-store'
import { attachWorkspaceDocumentQuote } from './attach-workspace-document-quote'

const initialChatState = useChatStore.getState()

describe('attachWorkspaceDocumentQuote', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { requestAnimationFrame: vi.fn() })
    useChatStore.setState({
      ...initialChatState,
      route: 'chat',
      activeThreadId: 'thread-1',
      workspaceRoot: '/workspace/a',
      threads: [{
        id: 'thread-1',
        title: 'Document discussion',
        updatedAt: '2026-08-12T00:00:00.000Z',
        model: 'deepseek-chat',
        mode: 'chat',
        workspace: '/workspace/a'
      }],
      extensionComposerContexts: []
    })
  })

  afterEach(() => {
    useChatStore.setState(initialChatState)
    vi.unstubAllGlobals()
  })

  it('attaches the quote to the active thread and workspace', async () => {
    await expect(attachWorkspaceDocumentQuote({
      workspaceRoot: '/workspace/a',
      draft: {
        sourceName: 'weekly-report.docx',
        documentFormat: 'docx',
        sourceSha256: 'a'.repeat(64),
        pageStart: 1,
        pageEnd: 1,
        text: 'A selected passage'
      }
    })).resolves.toBe(true)

    expect(useChatStore.getState().extensionComposerContexts).toEqual([
      expect.objectContaining({
        workspaceRoot: '/workspace/a',
        threadId: 'thread-1',
        attachment: expect.objectContaining({
          title: 'weekly-report.docx',
          provenance: expect.objectContaining({ source: 'workspace-selection' }),
          reference: expect.objectContaining({ text: 'A selected passage' })
        })
      })
    ])
  })

  it('does not attach across workspace boundaries', async () => {
    await expect(attachWorkspaceDocumentQuote({
      workspaceRoot: '/workspace/b',
      draft: {
        sourceName: 'weekly-report.docx',
        documentFormat: 'docx',
        sourceSha256: 'a'.repeat(64),
        pageStart: 1,
        pageEnd: 1,
        text: 'A selected passage'
      }
    })).resolves.toBe(false)
    expect(useChatStore.getState().extensionComposerContexts).toEqual([])
  })
})
