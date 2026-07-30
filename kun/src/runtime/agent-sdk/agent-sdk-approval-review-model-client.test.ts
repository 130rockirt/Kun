import { describe, expect, it, vi } from 'vitest'
import { makeUserItem } from '../../domain/item.js'
import type { ModelRequest, ModelStreamChunk } from '../../ports/model-client.js'
import type {
  SdkApi,
  SdkMessage,
  SdkQueryInput,
  SdkQueryResult
} from './sdk-protocol.js'
import { AgentSdkApprovalReviewModelClient } from './agent-sdk-approval-review-model-client.js'

describe('AgentSdkApprovalReviewModelClient', () => {
  it('uses the exact model in a fresh no-tools SDK request', async () => {
    const requests: SdkQueryInput[] = []
    const sdk = sdkWithMessages(requests, [
      {
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          role: 'assistant',
          content: [{
            type: 'text',
            text: '{"decision":"allow","riskLevel":"low","rationale":"bounded"}'
          }]
        }
      },
      {
        type: 'result',
        subtype: 'success',
        result: '{"decision":"allow","riskLevel":"low","rationale":"bounded"}',
        num_turns: 1,
        usage: { input_tokens: 11, output_tokens: 7 }
      }
    ])
    const client = new AgentSdkApprovalReviewModelClient({
      providerId: 'claude-subscription',
      oauthToken: 'sk-ant-oat01-review',
      defaultModel: 'claude-sonnet-default',
      cwd: '/isolated-review',
      baseEnv: () => ({
        PATH: '/bin',
        ANTHROPIC_API_KEY: 'must-not-leak'
      }),
      loadSdk: async () => sdk
    })

    const chunks = await collect(client.stream(request()))

    expect(requests).toHaveLength(1)
    expect(requests[0]?.prompt).toBe('<REVIEW_DATA>host data</REVIEW_DATA>')
    expect(requests[0]?.options).toMatchObject({
      cwd: '/isolated-review',
      systemPrompt: 'isolated reviewer',
      model: 'claude-sonnet-selected',
      tools: [],
      allowedTools: [],
      strictMcpConfig: true,
      permissionMode: 'default',
      settingSources: [],
      includePartialMessages: false,
      maxTurns: 1
    })
    expect(requests[0]?.options?.env?.ANTHROPIC_API_KEY).toBeUndefined()
    expect(requests[0]?.options?.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-review')
    expect(requests[0]?.options).not.toHaveProperty('mcpServers')
    expect(requests[0]?.options).not.toHaveProperty('hooks')
    expect(requests[0]?.options).not.toHaveProperty('agents')
    expect(requests[0]?.options).not.toHaveProperty('resume')
    expect(await requests[0]?.options?.canUseTool?.('Bash', {})).toMatchObject({
      behavior: 'deny'
    })
    expect(chunks).toEqual([
      {
        kind: 'assistant_text_delta',
        text: '{"decision":"allow","riskLevel":"low","rationale":"bounded"}'
      },
      {
        kind: 'usage',
        usage: expect.objectContaining({
          promptTokens: 11,
          completionTokens: 7,
          totalTokens: 18
        })
      },
      { kind: 'completed', stopReason: 'stop' }
    ])
  })

  it('surfaces an impossible SDK tool call so the strict reviewer denies it', async () => {
    const requests: SdkQueryInput[] = []
    const sdk = sdkWithMessages(requests, [{
      type: 'assistant',
      parent_tool_use_id: null,
      message: {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'tool_1',
          name: 'Bash',
          input: { command: 'whoami' }
        }]
      }
    }])
    const interrupt = vi.fn(async () => undefined)
    const query = sdk.query
    sdk.query = (input) => {
      const result = query(input)
      result.interrupt = interrupt
      return result
    }
    const client = new AgentSdkApprovalReviewModelClient({
      providerId: 'claude-subscription',
      cwd: '/isolated-review',
      loadSdk: async () => sdk
    })

    const chunks: ModelStreamChunk[] = []
    for await (const chunk of client.stream(request())) {
      chunks.push(chunk)
      if (chunk.kind === 'tool_call_complete') break
    }

    expect(chunks).toEqual([{
      kind: 'tool_call_complete',
      callId: 'tool_1',
      toolName: 'Bash',
      arguments: { command: 'whoami' }
    }])
    expect(interrupt).toHaveBeenCalledOnce()
  })

  it('rejects any caller that tries to expose tools', async () => {
    const client = new AgentSdkApprovalReviewModelClient({
      providerId: 'claude-subscription',
      cwd: '/isolated-review',
      loadSdk: async () => sdkWithMessages([], [])
    })
    const stream = client.stream({
      ...request(),
      tools: [{
        name: 'unsafe',
        description: 'unsafe',
        inputSchema: { type: 'object' }
      }]
    })
    await expect(collect(stream)).rejects.toThrow('refuses requests that expose tools')
  })
})

function request(): ModelRequest {
  const abortController = new AbortController()
  return {
    threadId: 'thread_1',
    turnId: 'turn_1_review',
    model: 'claude-sonnet-selected',
    providerId: 'claude-subscription',
    accountId: 'account-selected',
    systemPrompt: 'isolated reviewer',
    contextInstructions: [],
    prefix: [],
    history: [makeUserItem({
      id: 'review_input',
      threadId: 'thread_1',
      turnId: 'turn_1_review',
      text: '<REVIEW_DATA>host data</REVIEW_DATA>'
    })],
    tools: [],
    stream: false,
    abortSignal: abortController.signal
  }
}

function sdkWithMessages(
  requests: SdkQueryInput[],
  messages: SdkMessage[]
): SdkApi {
  return {
    query(input): SdkQueryResult {
      requests.push(input)
      return (async function* (): AsyncGenerator<SdkMessage, void> {
        for (const message of messages) yield message
      })() as SdkQueryResult
    },
    createSdkMcpServer: vi.fn() as unknown as SdkApi['createSdkMcpServer'],
    tool: vi.fn() as unknown as SdkApi['tool']
  }
}

async function collect(stream: AsyncIterable<ModelStreamChunk>): Promise<ModelStreamChunk[]> {
  const chunks: ModelStreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}
