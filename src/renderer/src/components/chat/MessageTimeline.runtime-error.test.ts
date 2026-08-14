import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TimelineRuntimeError } from './MessageTimeline'

describe('TimelineRuntimeError', () => {
  let renderer: ReactTestRenderer

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(async () => {
    if (renderer) await act(async () => renderer.unmount())
  })

  it('shows the caught error directly without interactive controls', async () => {
    const message = 'model request was rate limited (HTTP 429): resets in 2hr 3min.'
    await act(async () => {
      renderer = create(createElement(TimelineRuntimeError, {
        block: {
          kind: 'system',
          id: 'error_1',
          text: message,
          severity: 'error',
          runtimeError: true
        }
      }))
    })

    const root = renderer.root.findByProps({ 'data-testid': 'timeline-runtime-error' })
    expect(root.props.role).toBe('alert')
    expect(renderer.root.findByType('p').children.join('')).toBe(message)
    expect(renderer.root.findAllByType('button')).toHaveLength(0)
  })

  it('explains a memory-pressure restart instead of exposing only its code', async () => {
    await act(async () => {
      renderer = create(createElement(TimelineRuntimeError, {
        block: {
          kind: 'system',
          id: 'error_memory',
          text: 'raw memory failure',
          code: 'memory_pressure_critical',
          severity: 'error',
          runtimeError: true
        }
      }))
    })

    expect(renderer.root.findAllByType('p')[0]?.children.join('')).toContain('restarting')
  })
})
