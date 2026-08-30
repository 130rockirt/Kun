import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ConversationTurn,
  TimelineRuntimeError,
  timelineTurnAllowsRecoveryContinue
} from './MessageTimeline'

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

  it('localizes ownership interruption and exposes the idle Continue fallback', async () => {
    const onContinue = vi.fn()
    await act(async () => {
      renderer = create(createElement(TimelineRuntimeError, {
        block: {
          kind: 'system',
          id: 'error_owner_lease',
          text: 'Turn owner stopped heartbeating.',
          detail: 'Code: owner_lease_expired\nMessage: Turn owner stopped heartbeating.',
          code: 'owner_lease_expired',
          severity: 'warning',
          runtimeError: true
        },
        onContinue
      }))
    })

    expect(renderer.root.findAllByType('p')[0]?.children.join('')).toContain('ownership')
    expect(renderer.root.findAllByType('pre')[0]?.children.join(''))
      .toContain('owner_lease_expired')
    const button = renderer.root.findByProps({
      'data-testid': 'timeline-runtime-error-continue'
    })
    await act(async () => button.props.onClick())
    expect(onContinue).toHaveBeenCalledOnce()
  })

  it('hides the Continue fallback while another turn is running', async () => {
    await act(async () => {
      renderer = create(createElement(ConversationTurn, {
        turn: {
          blocks: [{
            kind: 'system',
            id: 'error_owner_lease_history',
            text: 'Turn owner stopped heartbeating.',
            code: 'owner_lease_expired',
            severity: 'warning',
            runtimeError: true
          }]
        },
        isProcessing: false,
        allowRecoveryContinue: false,
        liveReasoning: '',
        live: '',
        filePreviewWorkspaceRoot: '',
        viewportRef: { current: null }
      }))
    })

    expect(renderer.root.findAllByProps({
      'data-testid': 'timeline-runtime-error-continue'
    })).toHaveLength(0)
  })

  it('allows recovery only for the latest turn while the thread is idle', () => {
    expect(timelineTurnAllowsRecoveryContinue({
      busy: false,
      isLatestTurn: true
    })).toBe(true)
    expect(timelineTurnAllowsRecoveryContinue({
      busy: true,
      isLatestTurn: true
    })).toBe(false)
    expect(timelineTurnAllowsRecoveryContinue({
      busy: false,
      isLatestTurn: false
    })).toBe(false)
  })
})
