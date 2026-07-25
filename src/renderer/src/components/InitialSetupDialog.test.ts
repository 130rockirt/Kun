import { describe, expect, it, vi } from 'vitest'
import {
  canCloseInitialSetup,
  completeInitialSetupAfterSave,
  dismissInitialSetup
} from './InitialSetupDialog'

describe('InitialSetupDialog completion flow', () => {
  it('keeps required first-run setup modal-only until the runtime is ready, then opens Code', async () => {
    const reloadUiSettings = vi.fn(async () => undefined)
    const probeRuntime = vi.fn(async () => undefined)
    const openCode = vi.fn(async () => undefined)
    const closeInitialSetup = vi.fn()
    const setDialogError = vi.fn()

    const completed = await completeInitialSetupAfterSave({
      mode: 'required',
      reloadUiSettings,
      probeRuntime,
      openCode,
      closeInitialSetup,
      getState: () => ({ runtimeConnection: 'ready', error: null }),
      setDialogError,
      fallbackRuntimeError: 'Could not reach Kun.'
    })

    expect(completed).toBe(true)
    expect(reloadUiSettings).toHaveBeenCalledTimes(1)
    expect(probeRuntime).toHaveBeenCalledWith('user')
    expect(openCode).toHaveBeenCalledTimes(1)
    expect(closeInitialSetup).toHaveBeenCalledTimes(1)
    expect(setDialogError).not.toHaveBeenCalled()
  })

  it('does not close required first-run setup when the runtime cannot connect', async () => {
    const closeInitialSetup = vi.fn()
    const openCode = vi.fn(async () => undefined)
    const setDialogError = vi.fn()

    const completed = await completeInitialSetupAfterSave({
      mode: 'required',
      reloadUiSettings: vi.fn(async () => undefined),
      probeRuntime: vi.fn(async () => undefined),
      openCode,
      closeInitialSetup,
      getState: () => ({ runtimeConnection: 'offline', error: 'Port is busy.' }),
      setDialogError,
      fallbackRuntimeError: 'Could not reach Kun.'
    })

    expect(completed).toBe(false)
    expect(openCode).not.toHaveBeenCalled()
    expect(closeInitialSetup).not.toHaveBeenCalled()
    expect(setDialogError).toHaveBeenCalledWith('Port is busy.')
  })

  it('keeps preview setup dismissible and avoids forcing the user into Code', async () => {
    const probeRuntime = vi.fn(async () => undefined)
    const openCode = vi.fn(async () => undefined)
    const closeInitialSetup = vi.fn()

    const completed = await completeInitialSetupAfterSave({
      mode: 'preview',
      reloadUiSettings: vi.fn(async () => undefined),
      probeRuntime,
      openCode,
      closeInitialSetup,
      getState: () => ({ runtimeConnection: 'offline', error: null }),
      setDialogError: vi.fn(),
      fallbackRuntimeError: 'Could not reach Kun.'
    })

    expect(completed).toBe(true)
    expect(probeRuntime).toHaveBeenCalledWith('background')
    expect(openCode).not.toHaveBeenCalled()
    expect(closeInitialSetup).toHaveBeenCalledTimes(1)
  })

  it('allows users to dismiss both required and preview setup flows', () => {
    expect(canCloseInitialSetup('required')).toBe(true)
    expect(canCloseInitialSetup('preview')).toBe(true)
  })

  it('persists a required dismissal and starts probing Kun after closing', async () => {
    const persistCompletion = vi.fn(async () => undefined)
    const reloadUiSettings = vi.fn(async () => undefined)
    const probeRuntime = vi.fn(async () => undefined)
    const closeInitialSetup = vi.fn()

    await dismissInitialSetup({
      mode: 'required',
      persistCompletion,
      reloadUiSettings,
      probeRuntime,
      closeInitialSetup
    })

    expect(persistCompletion).toHaveBeenCalledTimes(1)
    expect(reloadUiSettings).toHaveBeenCalledTimes(1)
    expect(closeInitialSetup).toHaveBeenCalledTimes(1)
    expect(probeRuntime).toHaveBeenCalledWith('user')
  })

  it('does not persist or start Kun when closing the settings preview', async () => {
    const persistCompletion = vi.fn(async () => undefined)
    const probeRuntime = vi.fn(async () => undefined)
    const closeInitialSetup = vi.fn()

    await dismissInitialSetup({
      mode: 'preview',
      persistCompletion,
      reloadUiSettings: vi.fn(async () => undefined),
      probeRuntime,
      closeInitialSetup
    })

    expect(persistCompletion).not.toHaveBeenCalled()
    expect(probeRuntime).not.toHaveBeenCalled()
    expect(closeInitialSetup).toHaveBeenCalledTimes(1)
  })
})
