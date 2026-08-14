import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({ t: (key: string): string => key })
}))

import { useSddDraftStore, type SddDraft } from '../../sdd/sdd-draft-store'
import type { WriteQuotedSelection } from '../../write/quoted-selection'
import {
  buildSddAssistantModelOverrides,
  createSddReferenceContexts,
  isSddDraftStillActive,
  resolveSddAssistantUserPrompt,
  useWorkbenchSddTurnController,
  type WorkbenchSddTurnController
} from './useWorkbenchSddTurnController'

type SddTurnControllerParams = Parameters<typeof useWorkbenchSddTurnController>[0]

let latestController: WorkbenchSddTurnController
let renderer: ReactTestRenderer | null = null

function draft(id: string): SddDraft {
  return {
    id,
    workspaceRoot: '/workspace/current',
    relativePath: `.kunsdd/requirements/${id}/requirement.md`,
    createdAt: '2026-08-13T00:00:00.000Z',
    updatedAt: '2026-08-13T00:00:00.000Z'
  }
}

function quote(id: string): WriteQuotedSelection {
  return {
    id,
    text: `${id} text`,
    sourceTitle: 'requirement.md',
    sourceFilePath: '/workspace/current/.kunsdd/requirements/current/requirement.md',
    charCount: `${id} text`.length,
    createdAt: '2026-08-13T00:00:00.000Z'
  }
}

function controllerParams(overrides: Partial<SddTurnControllerParams> = {}): SddTurnControllerParams {
  return {
    activeGuiPlan: null,
    attachmentUploadEnabled: true,
    blocks: [],
    busy: false,
    composerAttachments: [],
    composerMode: 'agent',
    composerModelGroups: [],
    composerReasoningEffort: 'auto',
    composerFastMode: false,
    input: '',
    resolvedWriteAssistantProviderId: '',
    runtimeConnection: 'ready',
    runtimeInfo: null,
    selectedModelSupportsImageInput: true,
    sendMessage: vi.fn(async () => true),
    sendPlanTurn: vi.fn(async () => false),
    setAttachmentUploadError: vi.fn(),
    setComposerMode: vi.fn(),
    setError: vi.fn(),
    setInput: vi.fn(),
    setWriteAssistantModel: vi.fn(),
    writeAssistantModel: '',
    clearComposerAttachments: vi.fn(),
    ensureSddAssistantThreadForDraft: vi.fn(async () => 'thread-sdd'),
    getAttachmentScope: () => 'sdd',
    openSddAssistantPanel: vi.fn(async () => undefined),
    startNewSddAssistantConversation: vi.fn(),
    ...overrides
  }
}

function ControllerHarness({ params }: { params: SddTurnControllerParams }): null {
  latestController = useWorkbenchSddTurnController(params)
  return null
}

async function mountController(params: SddTurnControllerParams): Promise<void> {
  await act(async () => {
    renderer = create(createElement(ControllerHarness, { params }))
  })
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.stubGlobal('window', { kunGui: {} })
  useSddDraftStore.getState().clearActiveDraft()
})

afterEach(() => {
  renderer?.unmount()
  renderer = null
  useSddDraftStore.getState().clearActiveDraft()
  vi.unstubAllGlobals()
})

describe('SDD assistant model selection', () => {
  it('forwards the model, provider, and reasoning selected in the assistant sidebar', () => {
    expect(buildSddAssistantModelOverrides({
      model: ' gpt-5.6-sol ',
      providerId: ' codex ',
      reasoningEffort: 'max',
      fastMode: true,
      modelGroups: [{
        providerId: 'codex',
        presetSource: 'codex',
        label: 'Codex',
        modelIds: ['gpt-5.6-sol'],
        modelProfiles: {
          'gpt-5.6-sol': {
            inputModalities: ['text'],
            outputModalities: ['text'],
            supportsToolCalling: true,
            messageParts: ['text'],
            serviceTiers: ['priority']
          }
        }
      }]
    })).toEqual({
      model: 'gpt-5.6-sol',
      providerId: 'codex',
      reasoningEffort: 'max',
      serviceTier: 'priority'
    })
  })

  it('omits only empty model routing fields', () => {
    expect(buildSddAssistantModelOverrides({
      model: ' ',
      providerId: '',
      reasoningEffort: 'auto',
      fastMode: false,
      modelGroups: []
    })).toEqual({
      reasoningEffort: 'auto'
    })
  })
})

describe('SDD assistant structured references', () => {
  it('rejects a turn whose active draft changed while resolving its thread', () => {
    expect(isSddDraftStillActive({ id: 'draft-after-await' }, { id: 'draft-before-await' })).toBe(false)
    expect(isSddDraftStillActive({ id: 'draft-before-await' }, { id: 'draft-before-await' })).toBe(true)
  })

  it('uses a safe visible request for a reference-only turn', () => {
    const prompt = resolveSddAssistantUserPrompt('', 1, 'Improve the selected text')

    expect(prompt).toBe('Improve the selected text')
    expect(resolveSddAssistantUserPrompt('', 0, 'Improve the selected text')).toBe('')
  })

  it('keeps quote text and absolute source paths out of the user prompt', async () => {
    const prompt = 'Explain this requirement'
    const contexts = await createSddReferenceContexts({
      workspaceRoot: '/private/workspace',
      query: prompt,
      selections: [{
        id: 'quote-1',
        text: 'Sensitive acceptance criteria',
        sourceTitle: '.kunsdd/requirements/one/requirement.md',
        sourceFilePath: '/private/workspace/.kunsdd/requirements/one/requirement.md',
        lineStart: 3,
        lineEnd: 3,
        charCount: 29,
        createdAt: '2026-08-13T00:00:00.000Z'
      }]
    })

    expect(prompt).not.toContain('Sensitive acceptance criteria')
    expect(prompt).not.toContain('/private/workspace')
    expect(contexts).toHaveLength(1)
    expect(contexts[0]?.reference).toMatchObject({
      kind: 'work-reference-quotes',
      quotes: [{ text: 'Sensitive acceptance criteria' }]
    })
    expect(JSON.stringify(contexts)).not.toContain('/private/workspace')
  })
})

describe('SDD assistant turn lifecycle', () => {
  it('keeps quotes added during send after removing the sent snapshot', async () => {
    const activeDraft = draft('draft-send')
    const sentQuote = quote('sent-quote')
    const laterQuote = quote('later-quote')
    const sendMessage = vi.fn(async () => {
      useSddDraftStore.getState().addAssistantQuotedSelection(laterQuote)
      return true
    })
    useSddDraftStore.setState({
      activeDraft,
      content: '# Requirement',
      lastSavedContent: '# Requirement',
      saveStatus: 'saved',
      assistantQuotedSelections: [sentQuote]
    })
    await mountController(controllerParams({ sendMessage }))

    await act(async () => {
      await latestController.sendSddAssistantPrompt('Explain this')
    })

    expect(sendMessage).toHaveBeenCalledOnce()
    expect(useSddDraftStore.getState().assistantQuotedSelections).toMatchObject([{
      id: 'later-quote', text: 'later-quote text'
    }])
  })

  it('does not send after thread resolution switches the active draft', async () => {
    const originalDraft = draft('draft-before-await')
    const nextDraft = draft('draft-after-await')
    const sendMessage = vi.fn(async () => true)
    const ensureSddAssistantThreadForDraft = vi.fn(async () => {
      useSddDraftStore.setState({
        activeDraft: nextDraft,
        content: '# New requirement',
        lastSavedContent: '# New requirement',
        saveStatus: 'saved',
        assistantQuotedSelections: []
      })
      return 'thread-stale'
    })
    useSddDraftStore.setState({
      activeDraft: originalDraft,
      content: '# Original requirement',
      lastSavedContent: '# Original requirement',
      saveStatus: 'saved',
      assistantQuotedSelections: []
    })
    await mountController(controllerParams({ sendMessage, ensureSddAssistantThreadForDraft }))

    await act(async () => {
      await latestController.sendSddAssistantPrompt('Explain this')
    })

    expect(ensureSddAssistantThreadForDraft).toHaveBeenCalledWith(originalDraft)
    expect(sendMessage).not.toHaveBeenCalled()
  })
})
