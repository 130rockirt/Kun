import { describe, expect, it } from 'vitest'
import type { QueuedUserMessage } from './chat-store-types'
import {
  canInlineEditQueuedMessage,
  editQueuedMessageInQueue
} from './queued-message-edit'

describe('queued-message-edit', () => {
  it('edits a plain pending message in place without changing queue identity or order', () => {
    const before = { id: 'q-before', text: 'before', deliveryState: 'pending' as const }
    const after = { id: 'q-after', text: 'after', deliveryState: 'pending' as const }
    const editable = {
      id: 'q-edit',
      text: 'old visible text',
      displayText: 'old visible text',
      deliveryState: 'pending' as const,
      clientRequestId: 'client-request-1',
      model: 'deepseek-v4-pro',
      providerId: 'provider-1',
      accountId: 'account-1',
      modelLabel: 'DeepSeek V4 Pro',
      reasoningEffort: 'high',
      serviceTier: 'priority' as const,
      orchestration: 'direct' as const,
      expectedThreadId: 'thread-1',
      backgroundRuntimeText: 'frozen expanded prompt',
      backgroundCheckpointRequestId: 'checkpoint-1',
      futureRoutingContext: {
        lane: 'foreground',
        hints: ['preserve-me']
      }
    } satisfies QueuedUserMessage & {
      futureRoutingContext: { lane: string; hints: string[] }
    }
    const messages: QueuedUserMessage[] = [before, editable, after]

    expect(canInlineEditQueuedMessage(editable)).toBe(true)
    const result = editQueuedMessageInQueue(
      messages,
      'q-edit',
      '  revised visible text  ',
      'client-request-2'
    )

    expect(result.edited).toBe(true)
    expect(result.messages).not.toBe(messages)
    expect(result.messages.map((message) => message.id)).toEqual([
      'q-before', 'q-edit', 'q-after'
    ])
    expect(result.messages[0]).toBe(before)
    expect(result.messages[2]).toBe(after)
    expect(result.messages[1]).not.toBe(editable)
    expect(result.messages[1]).toEqual({
      id: 'q-edit',
      text: 'revised visible text',
      displayText: 'revised visible text',
      deliveryState: 'pending',
      clientRequestId: 'client-request-2',
      model: 'deepseek-v4-pro',
      providerId: 'provider-1',
      accountId: 'account-1',
      modelLabel: 'DeepSeek V4 Pro',
      reasoningEffort: 'high',
      serviceTier: 'priority',
      orchestration: 'direct',
      expectedThreadId: 'thread-1',
      futureRoutingContext: {
        lane: 'foreground',
        hints: ['preserve-me']
      }
    })
    expect(result.messages[1]).not.toHaveProperty('backgroundRuntimeText')
    expect(result.messages[1]).not.toHaveProperty('backgroundCheckpointRequestId')
  })

  it('does not alter the queue for a blank edit or a missing message id', () => {
    const messages: QueuedUserMessage[] = [
      { id: 'q-edit', text: 'keep me', deliveryState: 'pending' }
    ]

    expect(editQueuedMessageInQueue(messages, 'q-edit', '   ', 'client-request-2')).toEqual({
      messages,
      edited: false
    })
    expect(editQueuedMessageInQueue(messages, 'q-missing', 'replacement', 'client-request-2')).toEqual({
      messages,
      edited: false
    })
  })

  it.each([
    ['blank source text', { text: '   ' }],
    ['non-mirrored display text', { displayText: 'visible alias' }],
    ['plan mode', { mode: 'plan' }],
    ['attachment ids', { attachmentIds: ['attachment-1'] }],
    ['attachment payloads', { attachments: [{ id: 'attachment-1', kind: 'image' }] }],
    ['file references', { fileReferences: [{ path: '/workspace/file.ts' }] }],
    ['composer context', { composerContexts: [{ kind: 'selection', text: 'selected' }] }],
    ['write surface', { agentSurface: 'write' }],
    ['write context', {
      writeContext: {
        workspaceRoot: '/workspace',
        activeFilePath: '/workspace/draft.md',
        documentEpoch: 1,
        contentRevision: 2,
        threadId: 'thread-1'
      }
    }],
    ['design surface', { agentSurface: 'design' }],
    ['design canvas', { guiDesignCanvas: true }],
    ['design mode', { guiDesignMode: true }],
    ['paused delivery', { deliveryState: 'paused' }],
    ['failed delivery', { deliveryState: 'failed' }],
    ['starting delivery', { deliveryState: 'starting' }],
    ['in-flight delivery', { deliveryState: 'in_flight' }]
  ] as const)('rejects inline editing for %s', (_name, fields) => {
    const message = {
      id: 'q-locked',
      text: 'structured prompt',
      deliveryState: 'pending',
      ...fields
    } as QueuedUserMessage
    const messages = [message]

    expect(canInlineEditQueuedMessage(message)).toBe(false)
    expect(editQueuedMessageInQueue(messages, message.id, 'replacement', 'client-request-2')).toEqual({
      messages,
      edited: false
    })
  })
})
