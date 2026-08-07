import { describe, expect, it } from 'vitest'
import { makeAssistantTextItem, makeToolCallItem, makeToolResultItem } from '../../domain/item.js'
import type { ModelRequest } from '../../ports/model-client.js'
import { projectCompatMessages } from './compat-message-projector.js'
import { createCompatRequestCodecs } from './compat-request-builder.js'
import { COMPAT_TOOL_RESULT_ERROR } from './compat-request-codecs.js'

const requestBase: ModelRequest = {
  threadId: 'thread',
  turnId: 'turn',
  model: 'test-model',
  prefix: [],
  history: [],
  tools: [],
  abortSignal: new AbortController().signal
}

function errorMessages(): ReturnType<typeof projectCompatMessages> {
  return projectCompatMessages({
    ...requestBase,
    history: [
      makeAssistantTextItem({
        id: 'assistant',
        threadId: 'thread',
        turnId: 'turn',
        text: 'I will inspect that.'
      }),
      makeToolCallItem({
        id: 'call-item',
        threadId: 'thread',
        turnId: 'turn',
        callId: 'call-1',
        toolName: 'read',
        arguments: {},
        status: 'completed'
      }),
      makeToolResultItem({
        id: 'result-item',
        threadId: 'thread',
        turnId: 'turn',
        callId: 'call-1',
        toolName: 'read',
        output: {
          code: 'tool_cancelled_by_user',
          guidance: 'Only this tool was stopped. Do not repeat the identical call automatically.'
        },
        isError: true
      })
    ]
  }, {
    thinkingMode: false,
    supportsImages: false
  })
}

describe('tool cancellation protocol projection', () => {
  it('keeps the provider-neutral error marker paired with the call id', () => {
    const messages = errorMessages()
    const tool = messages.find((message) => message.role === 'tool')
    expect(tool).toMatchObject({ role: 'tool', tool_call_id: 'call-1' })
    expect(tool?.[COMPAT_TOOL_RESULT_ERROR]).toBe(true)
  })

  it('emits Anthropic is_error and structured text for OpenAI protocols', () => {
    const messages = errorMessages()
    const codecs = createCompatRequestCodecs()
    const common = {
      request: requestBase,
      model: 'test-model',
      messages,
      tools: [],
      stream: false,
      baseUrl: 'https://provider.example/v1',
      isCodex: false,
      isCodexLite: false,
      codexNativeImageGeneration: false
    }

    const anthropic = codecs.build({ ...common, endpointFormat: 'messages' })
    const anthropicTool = (anthropic.messages as Array<{ content: unknown }>).flatMap((message) =>
      Array.isArray(message.content) ? message.content : []
    ).find((block) => (block as { type?: string }).type === 'tool_result') as {
      tool_use_id: string
      is_error?: boolean
    }
    expect(anthropicTool).toMatchObject({ tool_use_id: 'call-1', is_error: true })

    const chat = codecs.build({ ...common, endpointFormat: 'chat_completions' })
    expect(chat.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'tool', tool_call_id: 'call-1' })
    ]))
    expect(JSON.stringify(chat.messages)).toContain('tool_cancelled_by_user')

    const responses = codecs.build({ ...common, endpointFormat: 'responses' })
    expect(responses.input).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'function_call_output', call_id: 'call-1' })
    ]))
    expect(JSON.stringify(responses.input)).toContain('tool_cancelled_by_user')
  })
})
