/** @vitest-environment jsdom */
import { act, createElement, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopStartupPhase } from '@shared/desktop-startup-state'
import { StartupGate } from './StartupGate'

vi.mock('./components/StorageRelocationBootView', () => ({
  StorageRelocationBootView: () => createElement('div', { 'data-testid': 'storage-relocation-view' })
}))
vi.mock('./components/RuntimeMigrationRecoveryView', () => ({
  RuntimeMigrationRecoveryView: () => createElement('div', { 'data-testid': 'runtime-recovery-view' })
}))
vi.mock('./App', () => ({
  default: () => createElement('div', { 'data-testid': 'workbench-app' })
}))
vi.mock('./lib/shared-business-storage', () => ({
  installSharedBusinessStorage: vi.fn(async () => undefined)
}))

type PhaseListener = (phase: DesktopStartupPhase) => void

function setReactActEnvironment(value: boolean): void {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = value
}

function installStartupApi(initial: DesktopStartupPhase): {
  listeners: Set<PhaseListener>
  getState: ReturnType<typeof vi.fn>
  onState: ReturnType<typeof vi.fn>
} {
  const listeners = new Set<PhaseListener>()
  const getState = vi.fn(async () => initial)
  const onState = vi.fn((handler: PhaseListener) => {
    listeners.add(handler)
    return () => listeners.delete(handler)
  })
  ;(window as unknown as { kunGui: unknown }).kunGui = { startup: { getState, onState } }
  return { listeners, getState, onState }
}

describe('StartupGate', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    setReactActEnvironment(true)
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
    setReactActEnvironment(false)
    delete (window as unknown as { kunGui?: unknown }).kunGui
    vi.clearAllMocks()
  })

  function renderGate(props: { storageRelocationMode?: boolean; runtimeMigrationRecoveryMode?: boolean }): void {
    act(() => {
      root.render(
        createElement(
          StrictMode,
          null,
          createElement(StartupGate, {
            storageRelocationMode: props.storageRelocationMode ?? false,
            runtimeMigrationRecoveryMode: props.runtimeMigrationRecoveryMode ?? false
          })
        )
      )
    })
  }

  it('shows the startup shell for the initial phase', async () => {
    const api = installStartupApi('bootstrapping')
    renderGate({})
    await act(async () => undefined)
    expect(api.onState).toHaveBeenCalled()
    expect(container.textContent).toContain('Preparing Kun desktop...')
    expect(container.querySelector('[data-testid="workbench-app"]')).toBeNull()
  })

  it('renders the workbench App once the phase reaches ready', async () => {
    const api = installStartupApi('bootstrapping')
    renderGate({})
    await act(async () => undefined)
    expect(container.textContent).toContain('Preparing Kun desktop...')

    await act(async () => {
      api.listeners.forEach((listener) => listener('runtime_starting'))
    })
    expect(container.textContent).toContain('Starting Kun runtime...')
    expect(container.querySelector('[data-testid="workbench-app"]')).toBeNull()

    await act(async () => {
      api.listeners.forEach((listener) => listener('ready'))
    })
    expect(container.querySelector('[data-testid="workbench-app"]')).not.toBeNull()
  })

  it('installs shared business storage exactly once despite StrictMode double effects', async () => {
    const { installSharedBusinessStorage } = await import('./lib/shared-business-storage')
    installStartupApi('ready')
    renderGate({})
    await act(async () => undefined)
    expect(installSharedBusinessStorage).toHaveBeenCalledTimes(1)
  })

  it('keeps the shell visible while the App chunk is still loading', async () => {
    const api = installStartupApi('bootstrapping')
    renderGate({})
    await act(async () => undefined)
    act(() => {
      api.listeners.forEach((listener) => listener('ready'))
    })
    // Before the async bootstrap (storage install + App import) resolves, the
    // shell must stay mounted showing the ready label instead of a blank page.
    expect(container.textContent).toContain('Kun is ready.')
    expect(container.querySelector('[data-testid="workbench-app"]')).toBeNull()
    await act(async () => undefined)
    expect(container.querySelector('[data-testid="workbench-app"]')).not.toBeNull()
  })

  it('renders only the storage relocation view and never subscribes to startup state', async () => {
    const api = installStartupApi('bootstrapping')
    renderGate({ storageRelocationMode: true })
    await act(async () => undefined)
    expect(container.querySelector('[data-testid="storage-relocation-view"]')).not.toBeNull()
    expect(api.getState).not.toHaveBeenCalled()
    expect(api.onState).not.toHaveBeenCalled()
    expect(container.querySelector('[data-testid="workbench-app"]')).toBeNull()
  })

  it('renders only the runtime recovery view and never subscribes to startup state', async () => {
    const api = installStartupApi('bootstrapping')
    renderGate({ runtimeMigrationRecoveryMode: true })
    await act(async () => undefined)
    expect(container.querySelector('[data-testid="runtime-recovery-view"]')).not.toBeNull()
    expect(api.getState).not.toHaveBeenCalled()
    expect(api.onState).not.toHaveBeenCalled()
  })

  it('shows the recovery_required styling on the shell', async () => {
    const api = installStartupApi('bootstrapping')
    renderGate({})
    await act(async () => undefined)
    await act(async () => {
      api.listeners.forEach((listener) => listener('recovery_required'))
    })
    expect(container.textContent).toContain('Kun startup requires recovery.')
    expect(container.querySelector('.bg-red-500')).not.toBeNull()
  })
})
