import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { DesignRightPanelContent, type DesignRightPanelContentProps } from './DesignRightPanelContent'

vi.mock('./DesignAIRail', () => ({
  DesignAIRail: () => <div data-testid="design-air-rail" />
}))

vi.mock('./DesignImplementPanel', () => ({
  DesignImplementPanel: () => <div data-testid="design-implement-panel" />
}))

function props(patch: Partial<DesignRightPanelContentProps> = {}): DesignRightPanelContentProps {
  return {
    panelMode: 'hidden',
    shared: {
      input: '',
      setInput: vi.fn(),
      mode: 'agent',
      setMode: vi.fn(),
      busy: false,
      runtimeConnection: 'ready',
      activeThreadId: null,
      blocks: [],
      liveReasoning: '',
      liveAssistant: '',
      composerModelGroups: [],
      composerReasoningEffort: 'medium',
      setComposerReasoningEffort: vi.fn(),
      queuedMessages: [],
      removeQueuedMessage: vi.fn(),
      guideQueuedMessage: vi.fn(),
      attachments: [],
      attachmentUploadEnabled: true,
      attachmentUploadBusy: false,
      attachmentUploadError: null,
      onPickAttachments: vi.fn(),
      onPasteClipboardImage: vi.fn(),
      onRemoveAttachment: vi.fn(),
      onInterrupt: vi.fn(),
      onRetryConnection: vi.fn(),
      onConfigureProviders: vi.fn()
    },
    implement: {
      title: 'Home',
      workspaceRoot: '/workspace',
      composerModel: 'deepseek-chat',
      composerProviderId: 'deepseek',
      composerPickList: [],
      setComposerModel: vi.fn(),
      onSend: vi.fn(),
      onOpenSettings: vi.fn(),
      onClose: vi.fn()
    },
    assistant: {
      composerModel: 'deepseek-chat',
      composerProviderId: 'deepseek',
      composerPickList: [],
      setComposerModel: vi.fn(),
      contextChips: [],
      onRemoveContextChip: vi.fn(),
      onSend: vi.fn(),
      onOpenSettings: vi.fn(),
      onNewConversation: vi.fn(),
      designThreads: [],
      onSwitchThread: vi.fn(),
      onCollapse: vi.fn()
    },
    ...patch
  }
}

describe('DesignRightPanelContent', () => {
  it('renders nothing when hidden', () => {
    expect(renderToStaticMarkup(<DesignRightPanelContent {...props()} />)).toBe('')
  })

  it('renders the implement panel in implement mode', () => {
    expect(renderToStaticMarkup(
      <DesignRightPanelContent {...props({ panelMode: 'implement' })} />
    )).toContain('design-implement-panel')
  })

  it('renders the design assistant rail in assistant mode', () => {
    expect(renderToStaticMarkup(
      <DesignRightPanelContent {...props({ panelMode: 'assistant' })} />
    )).toContain('design-air-rail')
  })
})
