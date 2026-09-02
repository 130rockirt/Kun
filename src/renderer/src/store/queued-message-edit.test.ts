import { describe, expect, it } from 'vitest'
import type { QueuedUserMessage } from './chat-store-types'
import {
  canInlineEditQueuedMessage,
  canRestoreQueuedMessageToComposer,
  editQueuedMessageInQueue,
  queuedMessageComposerRestoreText,
  restoreQueuedMessageFromQueue
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
      approvalPolicy: 'on-request' as const,
      sandboxMode: 'workspace-write' as const,
      approvalReviewer: 'agent' as const,
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
      approvalPolicy: 'on-request',
      sandboxMode: 'workspace-write',
      approvalReviewer: 'agent',
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

  it('restores a pending image message to the composer and removes it from the queue', () => {
    const imageMessage: QueuedUserMessage = {
      id: 'q-image',
      text: 'analyze this screenshot',
      deliveryState: 'pending',
      attachmentIds: ['attachment-1'],
      attachments: [{ id: 'attachment-1', kind: 'image', name: 'shot.png' }]
    }
    const messages: QueuedUserMessage[] = [
      { id: 'q-other', text: 'keep', deliveryState: 'pending' },
      imageMessage
    ]

    expect(canInlineEditQueuedMessage(imageMessage)).toBe(false)
    expect(canRestoreQueuedMessageToComposer(imageMessage)).toBe(true)
    expect(restoreQueuedMessageFromQueue(messages, 'q-image')).toEqual({
      messages: [{ id: 'q-other', text: 'keep', deliveryState: 'pending' }],
      restored: imageMessage
    })
    expect(restoreQueuedMessageFromQueue(messages, 'q-missing').restored).toBeNull()
  })

  it('maps image-only synthesized prompts to an empty composer restore text', () => {
    expect(queuedMessageComposerRestoreText({
      text: '<composer-image-only-prompt>',
      displayText: '已附加图片'
    })).toBe('')
    expect(queuedMessageComposerRestoreText({ text: 'visible prompt' })).toBe('visible prompt')
  })

  it.each([
    ['plan mode', { mode: 'plan' }],
    ['file references', { fileReferences: [{ path: '/workspace/file.ts' }] }],
    ['document attachments', {
      attachments: [{ id: 'doc-1', kind: 'document', name: 'spec.pdf' }]
    }],
    ['write surface', { agentSurface: 'write' }],
    ['in-flight delivery', { deliveryState: 'in_flight', deliveryTurnId: 'turn-1' }],
    ['runtime admission wait', { waitForRuntimeAdmission: true }],
    ['no text and no attachments', { text: '   ' }]
  ] as const)('rejects composer restore for %s', (_name, fields) => {
    const message = {
      id: 'q-locked',
      text: 'structured prompt',
      deliveryState: 'pending',
      ...fields
    } as QueuedUserMessage
    const messages = [message]

    expect(canRestoreQueuedMessageToComposer(message)).toBe(false)
    expect(restoreQueuedMessageFromQueue(messages, message.id)).toEqual({
      messages,
      restored: null
    })
  })
})
