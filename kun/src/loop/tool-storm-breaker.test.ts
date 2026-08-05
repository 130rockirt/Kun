import { describe, expect, it } from 'vitest'
import { ToolStormBreaker } from './tool-storm-breaker.js'

describe('ToolStormBreaker', () => {
  it('suppresses repeated interactive user-input gates in one turn', () => {
    const breaker = new ToolStormBreaker({ interactiveThreshold: 2 })

    expect(
      breaker.inspect({ callId: 'c1', toolName: 'user_input', arguments: { prompt: 'one' } })
    ).toEqual({ suppress: false })
    expect(
      breaker.inspect({ callId: 'c2', toolName: 'request_user_input', arguments: { prompt: 'two' } })
    ).toEqual({ suppress: false })
    expect(
      breaker.inspect({ callId: 'c3', toolName: 'user_input', arguments: { prompt: 'three' } })
    ).toMatchObject({
      suppress: true,
      reason: expect.stringContaining('interactive prompt guard')
    })
  })

  it('resets the interactive prompt count between turns', () => {
    const breaker = new ToolStormBreaker({ interactiveThreshold: 1 })

    expect(
      breaker.inspect({ callId: 'c1', toolName: 'user_input', arguments: { prompt: 'one' } })
    ).toEqual({ suppress: false })
    expect(
      breaker.inspect({ callId: 'c2', toolName: 'user_input', arguments: { prompt: 'two' } })
    ).toMatchObject({ suppress: true })

    breaker.reset()

    expect(
      breaker.inspect({ callId: 'c3', toolName: 'user_input', arguments: { prompt: 'new turn' } })
    ).toEqual({ suppress: false })
  })

  it('suppresses a third identical Graph inspection when durable state did not change', () => {
    const breaker = new ToolStormBreaker({ threshold: 3 })
    const inspect = (callId: string) => breaker.inspect({
      callId,
      toolName: 'graph_control_run',
      arguments: { action: 'inspect', runId: 'graph_run_1' }
    })

    expect(inspect('c1')).toEqual({ suppress: false })
    expect(inspect('c2')).toEqual({ suppress: false })
    expect(inspect('c3')).toMatchObject({
      suppress: true,
      reason: expect.stringContaining('identical arguments 3 times')
    })
  })

  it('allows a fresh Graph inspection after a control mutation', () => {
    const breaker = new ToolStormBreaker({ threshold: 3 })
    const args = { action: 'inspect', runId: 'graph_run_1' }

    expect(breaker.inspect({
      callId: 'c1',
      toolName: 'graph_control_run',
      arguments: args
    })).toEqual({ suppress: false })
    expect(breaker.inspect({
      callId: 'c2',
      toolName: 'graph_control_run',
      arguments: args
    })).toEqual({ suppress: false })
    expect(breaker.inspect({
      callId: 'c3',
      toolName: 'graph_control_run',
      arguments: { action: 'retry_node', runId: 'graph_run_1', nodeId: 'research' }
    })).toEqual({ suppress: false })
    expect(breaker.inspect({
      callId: 'c4',
      toolName: 'graph_control_run',
      arguments: args
    })).toEqual({ suppress: false })
  })

  it('allows a fresh Graph inspection after a semantic patch or Lead review', () => {
    for (const mutation of [
      {
        toolName: 'graph_patch_run',
        arguments: {
          runId: 'graph_run_1',
          reason: 'Replace exhausted work.',
          operations: [{ op: 'supersede_node', nodeId: 'research' }]
        }
      },
      {
        toolName: 'graph_review_node',
        arguments: {
          runId: 'graph_run_1',
          nodeId: 'research',
          outcome: 'pass',
          summary: 'Accepted.'
        }
      }
    ]) {
      const breaker = new ToolStormBreaker({ threshold: 3 })
      const inspect = {
        toolName: 'graph_control_run',
        arguments: { action: 'inspect', runId: 'graph_run_1' }
      }

      expect(breaker.inspect({ callId: 'c1', ...inspect })).toEqual({ suppress: false })
      expect(breaker.inspect({ callId: 'c2', ...inspect })).toEqual({ suppress: false })
      expect(breaker.inspect({ callId: 'c3', ...mutation })).toEqual({ suppress: false })
      expect(breaker.inspect({ callId: 'c4', ...inspect })).toEqual({ suppress: false })
    }
  })

  it('suppresses repeated malformed Browser Use calls with actionable guidance', () => {
    const breaker = new ToolStormBreaker()
    const call = (callId: string) => ({
      callId,
      toolName: 'browser_use',
      arguments: { action: 'navigate', url: 'https://example.com' }
    })

    expect(breaker.inspect(call('c1'))).toEqual({ suppress: false })
    expect(breaker.inspect(call('c2'))).toEqual({ suppress: false })
    expect(breaker.inspect(call('c3'))).toMatchObject({
      suppress: true,
      reason: expect.stringContaining('previous invalid_action guidance')
    })
  })

  it('allows a fresh Browser Use snapshot after a state-advancing action', () => {
    const breaker = new ToolStormBreaker({ threshold: 3 })
    const snapshot = (callId: string) => ({
      callId,
      toolName: 'browser_use',
      arguments: { action: 'snapshot' }
    })

    expect(breaker.inspect(snapshot('c1'))).toEqual({ suppress: false })
    expect(breaker.inspect(snapshot('c2'))).toEqual({ suppress: false })
    expect(breaker.inspect({
      callId: 'wait',
      toolName: 'browser_use',
      arguments: { action: 'wait', milliseconds: 500 }
    })).toEqual({ suppress: false })
    expect(breaker.inspect(snapshot('c3'))).toEqual({ suppress: false })
  })

  it('allows the normal open-observe-wait-observe-click-observe sequence', () => {
    const breaker = new ToolStormBreaker()
    const expectedTarget = {
      sessionId: 'session-1234567890',
      tabId: 'tab-1',
      documentGeneration: 1,
      origin: 'https://example.com',
      sanitizedUrl: 'https://example.com/form',
      role: 'button',
      name: 'Continue'
    }
    const calls = [
      { toolName: 'browser_use', arguments: { action: 'open', url: 'https://example.com' } },
      { toolName: 'browser_use', arguments: { action: 'snapshot' } },
      { toolName: 'browser_use', arguments: { action: 'wait', milliseconds: 500 } },
      { toolName: 'browser_use', arguments: { action: 'snapshot' } },
      {
        toolName: 'browser_use',
        arguments: { action: 'click', ref: 'opaque-reference-1234', expectedTarget }
      },
      { toolName: 'browser_use', arguments: { action: 'snapshot' } }
    ]

    for (const [index, call] of calls.entries()) {
      expect(breaker.inspect({ callId: `c${index}`, ...call })).toEqual({ suppress: false })
    }
  })

  it('still suppresses an unchanged Browser Use observation loop', () => {
    const breaker = new ToolStormBreaker({ threshold: 3 })
    const snapshot = (callId: string) => ({
      callId,
      toolName: 'browser_use',
      arguments: { action: 'snapshot' }
    })

    expect(breaker.inspect(snapshot('c1'))).toEqual({ suppress: false })
    expect(breaker.inspect(snapshot('c2'))).toEqual({ suppress: false })
    expect(breaker.inspect(snapshot('c3'))).toMatchObject({
      suppress: true,
      reason: expect.stringContaining('duplicate Browser Use action')
    })
  })
})
