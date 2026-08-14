import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import type { KunRuntimeSettingsSyncStatusPayload } from '@shared/kun-gui-api'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSettingsDomainOperations } from './use-settings-domain-operations'

const diagnostics = vi.hoisted(() => ({
  load: vi.fn(),
  provider: {}
}))

vi.mock('../agent/registry', () => ({
  getProvider: () => diagnostics.provider
}))

vi.mock('../lib/load-kun-diagnostics', () => ({
  loadKunDiagnostics: diagnostics.load
}))

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve
  })
  return { promise, resolve }
}

function runtimeSyncStatus(
  state: KunRuntimeSettingsSyncStatusPayload['state'],
  generation: number
): KunRuntimeSettingsSyncStatusPayload {
  return { state, generation, at: `2026-08-13T08:00:0${generation}.000Z` }
}

function installRuntimeSyncBridge(
  snapshot: Promise<KunRuntimeSettingsSyncStatusPayload> = Promise.resolve(runtimeSyncStatus('idle', 0))
): {
  emit: (status: KunRuntimeSettingsSyncStatusPayload) => void
  unsubscribe: ReturnType<typeof vi.fn>
} {
  let handler: ((status: KunRuntimeSettingsSyncStatusPayload) => void) | undefined
  const unsubscribe = vi.fn()
  vi.stubGlobal('window', {
    kunGui: {
      getRuntimeSettingsSyncStatus: vi.fn(() => snapshot),
      onRuntimeSettingsSyncStatus: vi.fn((next: typeof handler) => {
        handler = next
        return unsubscribe
      })
    }
  })
  return {
    emit: (status) => {
      if (!handler) throw new Error('runtime sync listener was not installed')
      handler(status)
    },
    unsubscribe
  }
}

function Harness({
  category,
  setRuntimeInfo
}: {
  category: string
  setRuntimeInfo: (value: unknown) => void
}) {
  useSettingsDomainOperations({
    category,
    setRuntimeInfo,
    setToolDiagnostics: vi.fn(),
    setMemoryRecords: vi.fn(),
    setRuntimeDiagnosticsBusy: vi.fn(),
    setRuntimeDiagnosticsNotice: vi.fn(),
    activeProjectWorkspaceRoot: '',
    projectConfigGrantFingerprint: '',
    memoryRecords: []
  })
  return null
}

describe('settings runtime diagnostics refresh', () => {
  beforeAll(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })

  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT
  })

  beforeEach(() => {
    vi.clearAllMocks()
    diagnostics.load.mockResolvedValue({ errors: [] })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('loads runtime capability data when Laboratory is opened directly', async () => {
    let renderer: ReactTestRenderer | undefined

    await act(async () => {
      renderer = create(createElement(Harness, {
        category: 'laboratory',
        setRuntimeInfo: vi.fn()
      }))
    })

    expect(diagnostics.load).toHaveBeenCalledTimes(1)
    await act(async () => renderer?.unmount())
  })

  it('waits for the latest runtime terminal status after settings persistence', async () => {
    const bridge = installRuntimeSyncBridge()
    const setRuntimeInfo = vi.fn()
    let renderer: ReactTestRenderer | undefined

    await act(async () => {
      renderer = create(createElement(Harness, {
        category: 'laboratory',
        setRuntimeInfo
      }))
    })
    expect(diagnostics.load).toHaveBeenCalledTimes(1)

    await act(async () => {
      renderer?.update(createElement(Harness, {
        category: 'laboratory',
        setRuntimeInfo
      }))
      await Promise.resolve()
    })
    expect(diagnostics.load).toHaveBeenCalledTimes(1)

    await act(async () => {
      bridge.emit(runtimeSyncStatus('syncing', 1))
    })
    expect(diagnostics.load).toHaveBeenCalledTimes(1)

    await act(async () => {
      bridge.emit(runtimeSyncStatus('synced', 1))
      await Promise.resolve()
    })
    expect(diagnostics.load).toHaveBeenCalledTimes(2)
    await act(async () => renderer?.unmount())
  })

  it('invalidates a stale Browser Use capability while runtime sync is pending', async () => {
    const bridge = installRuntimeSyncBridge()
    const setRuntimeInfo = vi.fn()
    let renderer: ReactTestRenderer | undefined

    await act(async () => {
      renderer = create(createElement(Harness, {
        category: 'laboratory',
        setRuntimeInfo
      }))
    })
    await act(async () => {
      bridge.emit(runtimeSyncStatus('syncing', 2))
    })

    const invalidate = setRuntimeInfo.mock.calls[0]?.[0] as (current: any) => any
    const current = {
      capabilities: {
        browserUse: { status: 'available' },
        imageGen: { status: 'available' }
      }
    }
    expect(invalidate(current)).toEqual({
      capabilities: { imageGen: { status: 'available' } }
    })
    expect(diagnostics.load).toHaveBeenCalledTimes(1)
    await act(async () => renderer?.unmount())
  })

  it('ignores stale snapshots, terminal events, and same-generation regressions', async () => {
    const snapshot = deferred<KunRuntimeSettingsSyncStatusPayload>()
    const bridge = installRuntimeSyncBridge(snapshot.promise)
    const setRuntimeInfo = vi.fn()
    let renderer: ReactTestRenderer | undefined

    await act(async () => {
      renderer = create(createElement(Harness, {
        category: 'laboratory',
        setRuntimeInfo
      }))
    })
    await act(async () => {
      bridge.emit(runtimeSyncStatus('syncing', 5))
      bridge.emit(runtimeSyncStatus('failed', 4))
    })
    expect(diagnostics.load).toHaveBeenCalledTimes(1)

    await act(async () => {
      bridge.emit(runtimeSyncStatus('failed', 5))
      snapshot.resolve(runtimeSyncStatus('synced', 4))
      await snapshot.promise
    })
    expect(diagnostics.load).toHaveBeenCalledTimes(2)
    expect(setRuntimeInfo).toHaveBeenCalledTimes(1)

    await act(async () => {
      bridge.emit(runtimeSyncStatus('syncing', 5))
      bridge.emit(runtimeSyncStatus('unavailable', 4))
    })
    expect(diagnostics.load).toHaveBeenCalledTimes(2)
    expect(setRuntimeInfo).toHaveBeenCalledTimes(1)
    await act(async () => renderer?.unmount())
  })

  it('keeps a late initial response from replacing terminal runtime state', async () => {
    const bridge = installRuntimeSyncBridge()
    const initial = deferred<{ runtimeInfo: { marker: string }; errors: never[] }>()
    const terminal = deferred<{ runtimeInfo: { marker: string }; errors: never[] }>()
    diagnostics.load
      .mockReturnValueOnce(initial.promise)
      .mockReturnValueOnce(terminal.promise)
    const setRuntimeInfo = vi.fn()
    let renderer: ReactTestRenderer | undefined

    await act(async () => {
      renderer = create(createElement(Harness, {
        category: 'laboratory',
        setRuntimeInfo
      }))
    })
    await act(async () => {
      bridge.emit(runtimeSyncStatus('syncing', 1))
      bridge.emit(runtimeSyncStatus('synced', 1))
    })

    await act(async () => {
      terminal.resolve({ runtimeInfo: { marker: 'terminal' }, errors: [] })
      await terminal.promise
    })
    await act(async () => {
      initial.resolve({ runtimeInfo: { marker: 'initial' }, errors: [] })
      await initial.promise
    })

    expect(setRuntimeInfo).toHaveBeenCalledTimes(2)
    expect(setRuntimeInfo).toHaveBeenLastCalledWith({ marker: 'terminal' })
    await act(async () => renderer?.unmount())
  })
})
