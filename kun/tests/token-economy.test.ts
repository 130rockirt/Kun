import { describe, expect, it } from 'vitest'
import {
  TOKEN_ECONOMY_INSTRUCTION,
  applyTokenEconomyToRequest,
  compressProse,
  normalizeTokenEconomyConfig
} from '../src/loop/token-economy.js'
import { makeToolCallItem, makeToolResultItem } from '../src/domain/item.js'
import type { ModelRequest } from '../src/ports/model-client.js'

function request(): ModelRequest {
  return {
    threadId: 'thr_1',
    turnId: 'turn_1',
    model: 'fake',
    systemPrompt: 'system',
    prefix: [],
    history: [],
    tools: [],
    abortSignal: new AbortController().signal
  }
}

describe('token economy', () => {
  it('compresses prose while preserving protected technical segments', () => {
    const input = 'Sure, I can really explain `useMemo` for https://example.com/docs and ./src/App.tsx.'
    const output = compressProse(input)

    expect(output).not.toContain('Sure')
    expect(output).not.toContain('really')
    expect(output).toContain('`useMemo`')
    expect(output).toContain('https://example.com/docs')
    expect(output).toContain('./src/App.tsx')
  })

  it('compresses tool descriptions and current-turn tool results only in the model request', () => {
    const longOutput = Array.from({ length: 500 }, (_, index) =>
      index === 240 ? 'ERROR failed to compile auth middleware' : `noise line ${index}`
    ).join('\n')
    const previousToolResult = makeToolResultItem({
      id: 'item_previous_result',
      threadId: 'thr_1',
      turnId: 'turn_previous',
      callId: 'call_previous_bash',
      toolName: 'bash',
      output: {
        command: 'npm test',
        output: longOutput,
        full_output_path: '/tmp/previous-full.log'
      }
    })
    const currentToolResult = makeToolResultItem({
      id: 'item_current_result',
      threadId: 'thr_1',
      turnId: 'turn_1',
      callId: 'call_bash',
      toolName: 'bash',
      output: {
        command: 'npm test',
        output: longOutput,
        full_output_path: '/tmp/full.log'
      }
    })
    const original = request()
    original.tools = [
      {
        name: 'read',
        description: 'Please read a file from the workspace and return the complete content.',
        inputSchema: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'The path to the file that should be read.'
            }
          }
        }
      }
    ]
    original.history = [
      makeToolCallItem({
        id: 'item_previous_call',
        threadId: 'thr_1',
        turnId: 'turn_previous',
        callId: 'call_previous_bash',
        toolName: 'bash',
        arguments: { command: 'npm test' }
      }),
      previousToolResult,
      makeToolCallItem({
        id: 'item_current_call',
        threadId: 'thr_1',
        turnId: 'turn_1',
        callId: 'call_bash',
        toolName: 'bash',
        arguments: { command: 'npm test' }
      }),
      currentToolResult
    ]

    const compacted = applyTokenEconomyToRequest(original, { enabled: true })
    const previousResult = compacted.history.find((item) =>
      item.kind === 'tool_result' && item.callId === 'call_previous_bash')
    const currentResult = compacted.history.find((item) =>
      item.kind === 'tool_result' && item.callId === 'call_bash')
    const currentOutput = currentToolResult.kind === 'tool_result'
      ? currentToolResult.output
      : {}

    expect(compacted.contextInstructions).toBeUndefined()
    expect(compacted.tools[0]?.description).not.toContain('Please')
    expect(JSON.stringify(compacted.tools[0]?.inputSchema)).not.toContain('The path')
    expect(previousResult).toBe(previousToolResult)
    expect(previousResult?.kind === 'tool_result' ? JSON.stringify(previousResult.output) : '')
      .toContain('noise line 499')
    expect(currentResult?.kind === 'tool_result' ? JSON.stringify(currentResult.output).length : 0)
      .toBeLessThan(JSON.stringify(currentOutput).length)
    expect(JSON.stringify(currentOutput)).toContain('noise line 499')
  })

  it('returns the original request when disabled', () => {
    const original = request()
    expect(applyTokenEconomyToRequest(original, { enabled: false })).toBe(original)
  })

  it('preserves request context instructions when enabled', () => {
    const original = request()
    original.contextInstructions = ['persisted request-local control']

    const compacted = applyTokenEconomyToRequest(original, { enabled: true })

    expect(compacted.contextInstructions).toEqual(['persisted request-local control'])
    expect(compacted.contextInstructions?.join('\n')).not.toContain(TOKEN_ECONOMY_INSTRUCTION)
  })

  it('keeps request history hygiene limits with the token economy config', () => {
    const normalized = normalizeTokenEconomyConfig({
      historyHygiene: {
        maxToolResultLines: 120,
        maxArrayItems: 20
      }
    })

    expect(normalized.historyHygiene.maxToolResultLines).toBe(120)
    expect(normalized.historyHygiene.maxArrayItems).toBe(20)
  })
})
