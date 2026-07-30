import { describe, expect, it } from 'vitest'
import {
  LlmDebugRecorder,
  redactBrowserUseDebugContent
} from './llm-debug-recorder.js'

describe('Browser Use model trace redaction', () => {
  it('removes screenshots, DOM content, query strings, and entered values from request traces', () => {
    const body = JSON.stringify({
      messages: [{
        role: 'assistant',
        tool_calls: [{
          function: {
            name: 'browser_use',
            arguments: JSON.stringify({
              action: 'open',
              url: 'https://example.com/path?token=secret#fragment'
            })
          }
        }]
      }, {
        role: 'tool',
        content: JSON.stringify({
          kind: 'browser_snapshot',
          snapshot: {
            title: 'Secret account',
            nodes: [{ role: 'textbox', name: 'API token', value: 'sk-secret' }]
          }
        })
      }, {
        role: 'tool',
        content: [{
          type: 'image_url',
          image_url: { url: 'data:image/png;base64,SECRETSCREEN' }
        }]
      }]
    })
    const redacted = redactBrowserUseDebugContent(body)
    expect(redacted).not.toContain('token=secret')
    expect(redacted).not.toContain('sk-secret')
    expect(redacted).not.toContain('SECRETSCREEN')
    expect(redacted).not.toContain('Secret account')
    expect(redacted).toContain('https://example.com/path')
    expect(redacted).toContain('[redacted]')
  })

  it('redacts decoded Browser Use tool calls and results before retention', async () => {
    const recorder = new LlmDebugRecorder()
    const round = recorder.start({
      threadId: 'thread-1',
      turnId: 'turn-1',
      provider: 'test',
      model: 'model'
    })
    recorder.captureChunk(round, {
      kind: 'tool_call_complete',
      callId: 'call-1',
      toolName: 'browser_use',
      arguments: {
        action: 'type',
        ref: 'opaque-reference-1234',
        expectedTarget: {
          sessionId: 'session-1234567890',
          tabId: 'tab-1',
          documentGeneration: 1,
          origin: 'https://example.com',
          sanitizedUrl: 'https://example.com/form',
          role: 'textbox',
          name: 'Public note'
        },
        text: 'private input'
      }
    })
    recorder.captureToolResult(round, {
      callId: 'call-1',
      toolName: 'browser_use',
      output: JSON.stringify({
        kind: 'browser_screenshot',
        images: [{ mime_type: 'image/png', data_base64: 'SCREENSHOT_BYTES' }]
      }),
      isError: false
    })
    await recorder.finish(round)
    const retained = JSON.stringify(recorder.snapshot())
    expect(retained).not.toContain('private input')
    expect(retained).not.toContain('SCREENSHOT_BYTES')
    expect(retained).toContain('[redacted]')
  })
})
