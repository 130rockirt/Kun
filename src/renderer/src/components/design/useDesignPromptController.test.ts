import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDesignWorkspaceStore } from '../../design/design-workspace-store'
import { useDesignPromptController } from './useDesignPromptController'

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({ t: (key: string) => key })
}))

vi.mock('./useDesignQualityRepair', () => ({
  useDesignQualityRepair: () => ({
    clearDesignAutoRepairScope: vi.fn(),
    handleDesignRuntimeQualityFindings: vi.fn(),
    handleDesignQualityRepairRequest: vi.fn()
  })
}))

describe('useDesignPromptController', () => {
  beforeEach(() => {
    useDesignWorkspaceStore.setState({
      workspaceRoot: '/workspace',
      activeDocumentId: 'doc',
      drawingCreationOpen: false,
      drawingCreationDocumentId: null,
      drawingCreationSubmitting: false,
      drawingHistoryMutation: {
        workspaceRoot: '/workspace',
        documentId: 'doc',
        kind: 'clear'
      }
    })
  })

  afterEach(() => {
    useDesignWorkspaceStore.setState({ drawingHistoryMutation: null })
    vi.restoreAllMocks()
  })

  it('rejects sends before creating or rebinding a thread while history is mutating', async () => {
    const ensureDesignThreadForWorkspace = vi.fn(async () => 'thread-new')
    const sendMessage = vi.fn(async () => true)
    const setDesignAssistantOpen = vi.fn()
    const controller = useDesignPromptController({
      route: 'design',
      runtimeConnection: 'ready',
      busy: false,
      workspaceRoot: '/workspace',
      composerAttachments: [],
      attachmentUploadEnabled: true,
      composerReasoningEffort: 'auto',
      composerFastMode: false,
      composerModelGroups: [],
      designContextSuppressedIds: new Set(),
      designHtmlElementContext: null,
      setInput: vi.fn(),
      setAttachmentUploadError: vi.fn(),
      setError: vi.fn(),
      setDesignAssistantOpen,
      ensureDesignThreadForWorkspace,
      clearDesignHistory: vi.fn(async () => ({
        cleared: true,
        deletedThreadIds: [],
        retainedThreadIds: [],
        recreatedThreadId: null
      })),
      sendMessage,
      getAttachmentScope: () => 'design',
      clearComposerAttachments: vi.fn(),
      clearHtmlElementContext: vi.fn()
    })

    await expect(controller.sendDesignPrompt('Draw a dashboard')).resolves.toBe(false)
    expect(ensureDesignThreadForWorkspace).not.toHaveBeenCalled()
    expect(sendMessage).not.toHaveBeenCalled()
    expect(setDesignAssistantOpen).not.toHaveBeenCalled()
  })
})
