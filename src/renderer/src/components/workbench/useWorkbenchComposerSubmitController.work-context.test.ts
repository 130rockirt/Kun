import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('react', async (importOriginal) => ({
  ...await importOriginal<typeof import('react')>(),
  useCallback: <T>(callback: T): T => callback
}))

vi.mock('react-i18next', () => ({
  initReactI18next: {
    type: '3rdParty',
    init: vi.fn()
  },
  useTranslation: () => ({
    t: (key: string): string => key
  })
}))

import type { ComposerContextAttachment } from '@kun/extension-api'
import { useChatStore } from '../../store/chat-store'
import { clearWriteWorkspaceSaveQueueForTests } from '../../write/write-save-coordinator'
import { useWriteWorkspaceStore } from '../../write/write-workspace-store'
import { useWorkbenchComposerSubmitController } from './useWorkbenchComposerSubmitController'
import {
  activateOfficeFile,
  activateTextFile,
  controllerParams,
  type ControllerParams
} from './useWorkbenchComposerSubmitController.test-helpers'

describe('useWorkbenchComposerSubmitController Work context', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { kunGui: {} })
    useChatStore.setState({ route: 'write', runtimeConnection: 'ready' })
    activateTextFile()
  })

  afterEach(() => {
    useWriteWorkspaceStore.getState().resetWorkspace()
    clearWriteWorkspaceSaveQueueForTests()
    vi.unstubAllGlobals()
  })

  it('uses bounded Office reference context without a quote and exact selection context with a quote', async () => {
    activateOfficeFile()
    const readWorkspaceOfficeSemantic = vi.fn(async () => ({
      ok: true as const,
      path: '/tmp/write/report.docx',
      name: 'report.docx',
      sourceFormat: 'docx' as const,
      sourceSha256: 'a'.repeat(64),
      text: 'Semantic Office body',
      truncated: false
    }))
    vi.stubGlobal('window', { kunGui: { readWorkspaceOfficeSemantic } })
    const sendMessage = vi.fn(async (..._args: Parameters<ControllerParams['sendMessage']>) => true)
    const controller = useWorkbenchComposerSubmitController(controllerParams({
      composerMode: 'plan',
      input: 'summarize',
      sendMessage,
      setInput: vi.fn()
    }))

    controller.sendWritePrompt('summarize')

    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce())
    expect(readWorkspaceOfficeSemantic).toHaveBeenCalledWith({
      path: '/tmp/write/report.docx',
      workspaceRoot: '/tmp/write',
      expectedSha256: 'a'.repeat(64)
    })
    const firstPrompt = sendMessage.mock.calls[0]?.[0] ?? ''
    const firstOptions = sendMessage.mock.calls[0]?.[2]
    expect(firstPrompt).toBe('summarize')
    const firstContexts = (firstOptions?.composerContexts ?? []) as ComposerContextAttachment[]
    expect(firstContexts.find((context) => (
      context.reference.kind === 'work-reference-resource'
    ))?.reference).toMatchObject({
      locator: 'report.docx',
      resourceKind: 'office',
      access: 'read-only'
    })
    const officeContext = firstContexts.find((context) => context.reference.kind === 'work-reference-office')
    expect(officeContext?.reference).toMatchObject({
      sourceName: 'report.docx',
      segments: ['Semantic Office body']
    })
    expect(useWriteWorkspaceStore.getState().documentsByPath['/tmp/write/report.docx']).toMatchObject({
      officeSemanticText: 'Semantic Office body',
      officeSemanticSha256: 'a'.repeat(64)
    })
    const quote = {
      id: 'word-quote',
      text: 'Only this paragraph',
      sourceKind: 'word' as const,
      sourceFormat: 'docx' as const,
      sourceTitle: 'report.docx',
      sourceFilePath: '/tmp/write/report.docx',
      pageStart: 2,
      pageEnd: 2,
      charCount: 19,
      createdAt: '2026-08-12T00:00:00.000Z'
    }
    const current = useWriteWorkspaceStore.getState()
    useWriteWorkspaceStore.setState({
      quotedSelections: [quote],
      documentsByPath: {
        ...current.documentsByPath,
        '/tmp/write/report.docx': {
          ...current.documentsByPath['/tmp/write/report.docx']!,
          quotedSelections: [quote]
        }
      }
    })
    readWorkspaceOfficeSemantic.mockClear()
    sendMessage.mockClear()
    controller.sendWritePrompt('explain')
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce())
    expect(readWorkspaceOfficeSemantic).not.toHaveBeenCalled()
    expect(sendMessage.mock.calls[0]?.[0]).toBe('explain')
    const quotedContexts = (sendMessage.mock.calls[0]?.[2]?.composerContexts ?? []) as ComposerContextAttachment[]
    expect(quotedContexts.find((context) => context.reference.kind === 'work-reference-quotes')?.reference)
      .toMatchObject({ quotes: [{ text: 'Only this paragraph' }] })
    expect(quotedContexts.some((context) => context.reference.kind === 'work-reference-office')).toBe(false)
  })

  it('routes the Work preset through the private persona field', async () => {
    useWriteWorkspaceStore.setState({
      assistantAgentPresetId: 'editor',
      agentPresets: [{ id: 'editor', name: 'Editor', emoji: 'E', persona: 'Be a precise editor.' }]
    })
    const sendMessage = vi.fn(async (..._args: Parameters<ControllerParams['sendMessage']>) => true)
    const controller = useWorkbenchComposerSubmitController(controllerParams({ sendMessage }))

    controller.sendWritePrompt('Review this draft')

    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce())
    expect(sendMessage.mock.calls[0]?.[0]).not.toContain('Be a precise editor.')
    expect(sendMessage.mock.calls[0]?.[2]).toMatchObject({ persona: 'Be a precise editor.' })
  })

  it('does not retrieve the current file when an exact quote is already attached', async () => {
    const exactQuote = {
      id: 'quote-1', text: 'Exact quoted paragraph', sourceTitle: 'draft.md',
      sourceFilePath: '/tmp/write/draft.md', lineStart: 1, lineEnd: 1,
      charCount: 22, createdAt: '2026-08-13T00:00:00.000Z'
    }
    useWriteWorkspaceStore.setState({ quotedSelections: [exactQuote] })
    const retrieveWriteContext = vi.fn(async () => ({ ok: true as const, context: null }))
    vi.stubGlobal('window', { kunGui: { retrieveWriteContext } })
    const controller = useWorkbenchComposerSubmitController(controllerParams())

    controller.sendWritePrompt('Explain this paragraph')

    await vi.waitFor(() => expect(retrieveWriteContext).toHaveBeenCalledOnce())
    expect(retrieveWriteContext).toHaveBeenCalledWith(expect.objectContaining({
      query: 'Explain this paragraph',
      includeCurrentFile: false
    }))
  })

  it('restores the prompt and exposes an error when reference creation fails', async () => {
    const quote = {
      id: 'quote-1', text: 'Reference content', sourceTitle: 'draft.md',
      sourceFilePath: '/tmp/write/draft.md', lineStart: 1, lineEnd: 1,
      charCount: 17, createdAt: '2026-08-13T00:00:00.000Z'
    }
    useWriteWorkspaceStore.setState({ quotedSelections: [quote] })
    vi.stubGlobal('crypto', {
      subtle: { digest: vi.fn(async () => { throw new Error('context digest failed') }) }
    })
    const setInput = vi.fn()
    const setError = vi.fn()
    const sendMessage = vi.fn(async (..._args: Parameters<ControllerParams['sendMessage']>) => true)
    const controller = useWorkbenchComposerSubmitController(controllerParams({
      input: 'Keep this prompt', setInput, setError, sendMessage
    }))

    controller.sendWritePrompt('Keep this prompt')

    await vi.waitFor(() => expect(setError).toHaveBeenCalledWith('context digest failed'))
    expect(sendMessage).not.toHaveBeenCalled()
    expect(setInput).toHaveBeenCalledWith('')
    const restore = setInput.mock.calls.find(([value]) => typeof value === 'function')?.[0]
    expect(restore).toBeTypeOf('function')
    expect(restore('')).toBe('Keep this prompt')
  })
})
