import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import '../../i18n'
import { useChatStore } from '../../store/chat-store'
import { useWriteWorkspaceStore } from '../../write/write-workspace-store'
import { WriteAssistantPanel } from './WriteAssistantPanel'

describe('WriteAssistantPanel', () => {
  it('forwards enabled runtime Skills to the compact composer', () => {
    useChatStore.setState({
      activeThreadId: 'thr_write',
      activeThreadGoal: null,
      route: 'write',
      workspaceRoot: '/workspace',
      threads: []
    })
    useWriteWorkspaceStore.setState({
      workspaceRoot: '/workspace',
      activeFilePath: '/workspace/draft.md'
    })

    const html = renderToStaticMarkup(createElement(WriteAssistantPanel, {
      input: '/style',
      setInput: () => undefined,
      mode: 'agent',
      setMode: () => undefined,
      busy: false,
      runtimeConnection: 'ready',
      activeThreadId: 'thr_write',
      blocks: [],
      liveReasoning: '',
      liveAssistant: '',
      composerModel: '',
      composerPickList: [],
      composerReasoningEffort: 'max',
      setComposerModel: () => undefined,
      setComposerReasoningEffort: () => undefined,
      queuedMessages: [],
      removeQueuedMessage: () => undefined,
      guideQueuedMessage: () => undefined,
      skillCommands: [
        {
          id: 'style-guide',
          name: 'Style Guide',
          description: 'Apply the project writing style',
          root: '/workspace/.codex/skills/style-guide',
          scope: 'project',
          legacy: true,
          version: '1',
          triggers: { commands: [], fileTypes: [], promptPatterns: [] },
          allowedTools: []
        },
        {
          id: 'disabled-skill',
          name: 'Disabled Skill',
          root: '/workspace/.codex/skills/disabled-skill',
          scope: 'project',
          legacy: true,
          version: '1',
          triggers: { commands: [], fileTypes: [], promptPatterns: [] },
          allowedTools: []
        }
      ],
      disabledSkillIds: ['disabled-skill'],
      onSend: () => undefined,
      onInterrupt: () => undefined,
      onRetryConnection: () => undefined,
      onOpenSettings: () => undefined,
      onNewConversation: () => undefined,
      onPickWorkspace: () => undefined,
      onCollapse: () => undefined
    }))

    expect(html).toContain('Style Guide')
    expect(html).toContain('/skill:style-guide')
    expect(html).not.toContain('Disabled Skill')
  })

  it('offers guidance for queued plain-text messages', () => {
    useChatStore.setState({
      activeThreadId: 'thr_write',
      activeThreadGoal: null,
      route: 'write',
      workspaceRoot: '/workspace',
      threads: []
    })
    useWriteWorkspaceStore.setState({
      workspaceRoot: '/workspace',
      activeFilePath: '/workspace/draft.md'
    })

    const html = renderToStaticMarkup(createElement(WriteAssistantPanel, {
      input: '',
      setInput: () => undefined,
      mode: 'agent',
      setMode: () => undefined,
      busy: true,
      runtimeConnection: 'ready',
      activeThreadId: 'thr_write',
      blocks: [],
      liveReasoning: '',
      liveAssistant: '',
      composerModel: '',
      composerPickList: [],
      composerReasoningEffort: 'max',
      setComposerModel: () => undefined,
      setComposerReasoningEffort: () => undefined,
      queuedMessages: [{ id: 'q-guide', text: 'keep the opening shorter' }],
      removeQueuedMessage: () => undefined,
      guideQueuedMessage: () => undefined,
      onSend: () => undefined,
      onInterrupt: () => undefined,
      onRetryConnection: () => undefined,
      onOpenSettings: () => undefined,
      onNewConversation: () => undefined,
      onPickWorkspace: () => undefined,
      onCollapse: () => undefined
    }))

    expect(html).toContain('aria-label="Guide"')
  })
})
