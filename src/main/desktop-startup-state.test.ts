import { describe, expect, it, vi } from 'vitest'
import { DesktopStartupState } from './desktop-startup-state'

describe('DesktopStartupState', () => {
  it('walks the startup phases and publishes each state to the current window', () => {
    const send = vi.fn()
    const state = new DesktopStartupState(() => ({
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, send }
    } as never))

    expect(state.phase).toBe('bootstrapping')
    state.transition('runtime_handoff')
    state.transition('runtime_starting')
    state.transition('ready')

    expect(state.isReady()).toBe(true)
    expect(send.mock.calls.map((call) => call[1])).toEqual([
      'runtime_handoff',
      'runtime_starting',
      'ready'
    ])
  })

  it('rejects skipped or repeated transitions and locks recovery', () => {
    const state = new DesktopStartupState(() => null)

    expect(() => state.transition('ready')).toThrow(/Invalid desktop startup transition/)
    state.transition('runtime_handoff')
    state.transition('recovery_required')
    expect(() => state.transition('runtime_starting')).toThrow(/Invalid desktop startup transition/)
    expect(() => state.assertReady()).toThrow(/recovery_required/)
  })
})
