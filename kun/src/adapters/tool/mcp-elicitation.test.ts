import { describe, expect, it, vi } from 'vitest'
import type { ToolHostContext } from '../../ports/tool-host.js'
import type { UserInputResolution } from '../../ports/user-input-gate.js'
import { McpElicitationRuntime, McpInteractionRequiredError } from './mcp-elicitation.js'

function context(
  resolve?: (questions: Array<{ id: string }>) => UserInputResolution | Promise<UserInputResolution>
): ToolHostContext {
  return {
    abortSignal: new AbortController().signal,
    ...(resolve ? {
      awaitUserInput: async (input) => resolve(input.questions)
    } : {})
  } as ToolHostContext
}

describe('McpElicitationRuntime', () => {
  it('parses form answers into MCP primitive values', async () => {
    const runtime = new McpElicitationRuntime('forms')
    const result = await runtime.run(context((questions) => ({
      status: 'submitted',
      answers: questions.map(({ id }) => {
        if (id === 'count') return { id, label: '2', value: '2' }
        if (id === 'enabled') return { id, label: 'true', value: 'true' }
        if (id === 'tags') return { id, label: 'a, b', value: '', values: ['a', 'b'] }
        return { id, label: 'Kun', value: 'Kun' }
      })
    })), () => runtime.handle({
      mode: 'form',
      message: 'Configure the operation',
      requestedSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          count: { type: 'integer' },
          enabled: { type: 'boolean' },
          tags: { type: 'array', items: { type: 'string', enum: ['a', 'b'] } }
        },
        required: ['name', 'count']
      }
    }))

    expect(result).toEqual({
      action: 'accept',
      content: { name: 'Kun', count: 2, enabled: true, tags: ['a', 'b'] }
    })
  })

  it('fails closed when user input is disabled', async () => {
    const runtime = new McpElicitationRuntime('headless')
    await expect(runtime.run(context(), () => runtime.handle({
      mode: 'form',
      message: 'Need input',
      requestedSchema: { type: 'object', properties: {} }
    }))).rejects.toBeInstanceOf(McpInteractionRequiredError)
  })

  it('returns cancellation without fabricating form content', async () => {
    const runtime = new McpElicitationRuntime('cancelled')
    const result = await runtime.run(context(() => ({ status: 'cancelled' })), () => runtime.handle({
      mode: 'form',
      message: 'Need input',
      requestedSchema: {
        type: 'object',
        properties: { secret: { type: 'string' } },
        required: ['secret']
      }
    }))
    expect(result).toEqual({ action: 'cancel' })
  })

  it('opens URL elicitation only after explicit consent', async () => {
    const openExternal = vi.fn(async () => undefined)
    const runtime = new McpElicitationRuntime('url', openExternal)
    const result = await runtime.run(context((questions) => ({
      status: 'submitted',
      answers: [{ id: questions[0]?.id ?? 'consent', label: 'Open', value: 'Open' }]
    })), () => runtime.handle({
      mode: 'url',
      message: 'Authenticate securely',
      elicitationId: 'opaque',
      url: 'https://example.com/authorize'
    }))

    expect(result).toEqual({ action: 'accept' })
    expect(openExternal).toHaveBeenCalledWith(new URL('https://example.com/authorize'))
  })

  it('does not open URL elicitation after decline', async () => {
    const openExternal = vi.fn(async () => undefined)
    const runtime = new McpElicitationRuntime('url', openExternal)
    const result = await runtime.run(context((questions) => ({
      status: 'submitted',
      answers: [{ id: questions[0]?.id ?? 'consent', label: 'Decline', value: 'Decline' }]
    })), () => runtime.handle({
      mode: 'url',
      message: 'Authenticate securely',
      elicitationId: 'opaque',
      url: 'https://example.com/authorize'
    }))

    expect(result).toEqual({ action: 'decline' })
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('isolates concurrent turns sharing the same client handler', async () => {
    const runtime = new McpElicitationRuntime('shared')
    const params = {
      mode: 'form' as const,
      message: 'Who are you?',
      requestedSchema: {
        type: 'object' as const,
        properties: { name: { type: 'string' } },
        required: ['name']
      }
    }
    const invoke = (name: string, delayMs: number) => runtime.run(context(async (questions) => {
      await new Promise((resolve) => setTimeout(resolve, delayMs))
      return {
        status: 'submitted',
        answers: [{ id: questions[0]?.id ?? 'name', label: name, value: name }]
      }
    }), () => runtime.handle(params))

    const [first, second] = await Promise.all([invoke('first', 10), invoke('second', 0)])
    expect(first).toEqual({ action: 'accept', content: { name: 'first' } })
    expect(second).toEqual({ action: 'accept', content: { name: 'second' } })
  })
})
