import { describe, expect, it } from 'vitest'
import {
  makeAssistantReasoningItem,
  makeGoalContextItem,
  makeToolCallItem,
  makeToolResultItem,
  makeUserItem
} from '../../domain/item.js'
import type { ModelRequest } from '../../ports/model-client.js'
import { projectCompatMessages } from './compat-message-projector.js'
import { COMPAT_HISTORY_CONTEXT } from './compat-request-codecs.js'

const composerContextFixture = {
  schemaVersion: 1 as const,
  id: 'video-selection',
  title: 'Interview selection',
  summary: 'Revision 4 with two selected clips',
  reference: { projectId: 'project-1', selectedItemIds: ['clip-1', 'clip-2'] },
  revision: 4,
  generation: 7,
  attachmentId: `extension-context:${'a'.repeat(64)}`,
  provenance: {
    extensionId: 'acme.video-editor',
    extensionVersion: '1.1.0',
    viewContributionId: 'extension:acme.video-editor/editor',
    workspaceId: 'b'.repeat(64)
  }
}

describe('compat composer context projection', () => {
  it('appends extension context once to USER content and never changes system content', () => {
    const user = makeUserItem({
      id: 'item-user',
      turnId: 'turn-1',
      threadId: 'thread-1',
      text: 'Use the selected clips',
      composerContexts: [composerContextFixture]
    })
    const request: ModelRequest = {
      threadId: 'thread-1',
      turnId: 'turn-1',
      model: 'test-model',
      systemPrompt: 'stable-system-prefix',
      prefix: [],
      history: [user],
      tools: [],
      abortSignal: new AbortController().signal
    }

    const messages = projectCompatMessages(request, {
      thinkingMode: false,
      supportsImages: false
    })
    expect(messages[0]).toEqual({ role: 'system', content: 'stable-system-prefix' })
    const userContent = String(messages.find((message) => message.role === 'user')?.content ?? '')
    expect(userContent).toContain('Use the selected clips')
    expect(userContent).toContain('untrusted reference data')
    expect(userContent).toContain(composerContextFixture.attachmentId)
    expect(userContent.match(new RegExp(composerContextFixture.attachmentId, 'g'))).toHaveLength(1)
    expect(messages.filter((message) => message.role === 'system').map((message) => message.content))
      .toEqual(['stable-system-prefix'])
  })

  it('orders stable prompt, profile, mode, history, and turn context', () => {
    const request: ModelRequest = {
      threadId: 'thread-order',
      turnId: 'turn-order',
      model: 'test-model',
      systemPrompt: 'stable-system-prefix',
      threadProfileInstruction: 'thread-profile',
      modeInstruction: 'mode-instruction',
      prefix: [],
      history: [makeUserItem({
        id: 'item-order',
        threadId: 'thread-order',
        turnId: 'turn-order',
        text: 'user-history'
      })],
      contextInstructions: ['turn-context-preamble', 'turn-context-block'],
      tools: [],
      abortSignal: new AbortController().signal
    }

    expect(projectCompatMessages(request, {
      thinkingMode: false,
      supportsImages: false
    }).map((message) => [message.role, message.content])).toEqual([
      ['system', 'stable-system-prefix'],
      ['system', 'thread-profile'],
      ['system', 'mode-instruction'],
      ['user', 'user-history'],
      ['system', 'turn-context-preamble'],
      ['system', 'turn-context-block']
    ])
  })

  it('projects durable goal context as history rather than a per-request instruction', () => {
    const request: ModelRequest = {
      threadId: 'thread-goal',
      turnId: 'turn-goal',
      model: 'test-model',
      systemPrompt: 'stable-system-prefix',
      prefix: [],
      history: [
        makeGoalContextItem({
          id: 'goal-context',
          threadId: 'thread-goal',
          turnId: 'turn-goal',
          text: 'Goal objective stays in append-only history.',
          createdAt: '2026-08-06T00:00:00.000Z'
        }),
        makeUserItem({
          id: 'goal-user',
          threadId: 'thread-goal',
          turnId: 'turn-goal',
          text: 'Continue.'
        })
      ],
      tools: [],
      abortSignal: new AbortController().signal
    }

    const messages = projectCompatMessages(request, {
      thinkingMode: false,
      supportsImages: false
    })
    const goal = messages[1]
    expect(goal).toMatchObject({
      role: 'system',
      content: 'Goal objective stays in append-only history.'
    })
    expect(goal?.[COMPAT_HISTORY_CONTEXT]).toBe(true)
  })

  it('replays complete historical DeepSeek tool rounds only on the identical route', () => {
    const threadId = 'thread-deepseek'
    const priorTurnId = 'turn-prior'
    const request: ModelRequest = {
      threadId,
      turnId: 'turn-current',
      model: 'deepseek-v4-pro',
      providerId: 'deepseek',
      accountId: 'account-a',
      prefix: [],
      history: [
        makeAssistantReasoningItem({
          id: 'reason-prior', threadId, turnId: priorTurnId,
          text: 'inspect the requested file', status: 'completed'
        }),
        makeToolCallItem({
          id: 'call-prior', threadId, turnId: priorTurnId, callId: 'call-prior',
          toolName: 'read_file', arguments: { path: 'a.ts' }, status: 'completed'
        }),
        makeToolResultItem({
          id: 'result-prior', threadId, turnId: priorTurnId, callId: 'call-prior',
          toolName: 'read_file', output: 'contents', status: 'completed'
        })
      ],
      historyRoutesByTurnId: {
        [priorTurnId]: { model: 'deepseek-v4-pro', providerId: 'deepseek', accountId: 'account-a' }
      },
      tools: [],
      abortSignal: new AbortController().signal
    }

    const messages = projectCompatMessages(request, {
      thinkingMode: true,
      strictThinkingToolReplay: true,
      supportsImages: false
    })
    expect(messages.find((message) => message.tool_calls?.length)).toMatchObject({
      reasoning_content: 'inspect the requested file'
    })

    const switched = projectCompatMessages({
      ...request,
      model: 'deepseek-v4-flash',
      historyRoutesByTurnId: {
        [priorTurnId]: { model: 'deepseek-v4-pro', providerId: 'deepseek', accountId: 'account-a' }
      }
    }, {
      thinkingMode: true,
      strictThinkingToolReplay: true,
      supportsImages: false
    })
    expect(switched.some((message) => message.tool_calls?.length)).toBe(false)
    expect(switched.some((message) => message.role === 'tool')).toBe(false)
  })
})
