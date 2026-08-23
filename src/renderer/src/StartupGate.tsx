import React, { lazy, useEffect, useRef, useState } from 'react'
import type { DesktopStartupPhase } from '@shared/desktop-startup-state'
import { startupPhaseLabel, startupShellAllowsWorkbench } from './startup-shell'

const StorageRelocationBootView = lazy(async () => {
  const { StorageRelocationBootView: view } = await import('./components/StorageRelocationBootView')
  return { default: view }
})
const RuntimeMigrationRecoveryView = lazy(async () => {
  const { RuntimeMigrationRecoveryView: view } = await import('./components/RuntimeMigrationRecoveryView')
  return { default: view }
})
type AppModule = typeof import('./App')
const WorkbenchApp = lazy(async () => {
  const mod: AppModule = await import('./App')
  return { default: mod.default }
})

const fallback = <div className="min-h-screen bg-ds-canvas" />

export interface StartupGateProps {
  storageRelocationMode: boolean
  runtimeMigrationRecoveryMode: boolean
}

/**
 * Owns the full renderer lifecycle for the single React root: startup shell,
 * special boot views, and the workbench App. Phase transitions go through
 * normal reconciliation instead of repeated createRoot calls on #root.
 */
export function StartupGate({
  storageRelocationMode,
  runtimeMigrationRecoveryMode
}: StartupGateProps): React.ReactElement {
  const [phase, setPhase] = useState<DesktopStartupPhase>('bootstrapping')
  const [appReady, setAppReady] = useState(false)
  const workbenchStartedRef = useRef(false)

  useEffect(() => {
    if (storageRelocationMode || runtimeMigrationRecoveryMode) return
    const startup = window.kunGui?.startup
    if (!startup) return
    let cancelled = false
    void startup.getState().then((initial) => {
      if (!cancelled) setPhase(initial)
    })
    const unsubscribe = startup.onState((next) => setPhase(next))
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [storageRelocationMode, runtimeMigrationRecoveryMode])

  useEffect(() => {
    // Guard against StrictMode double-invoke: the workbench bootstrap
    // (shared storage install + App chunk load) must run exactly once.
    if (storageRelocationMode || runtimeMigrationRecoveryMode) return
    if (!startupShellAllowsWorkbench(phase)) return
    if (workbenchStartedRef.current) return
    workbenchStartedRef.current = true
    let cancelled = false
    void (async () => {
      await installSharedBusinessStorageForWorkbench()
      const mod: AppModule = await import('./App')
      if (!cancelled) setAppReady(true)
    })()
    return () => {
      cancelled = true
    }
  }, [phase, storageRelocationMode, runtimeMigrationRecoveryMode])

  if (storageRelocationMode) {
    return (
      <React.Suspense fallback={fallback}>
        <StorageRelocationBootView />
      </React.Suspense>
    )
  }
  if (runtimeMigrationRecoveryMode) {
    return (
      <React.Suspense fallback={fallback}>
        <RuntimeMigrationRecoveryView />
      </React.Suspense>
    )
  }
  if (appReady) {
    return (
      <React.Suspense fallback={fallback}>
        <WorkbenchApp />
      </React.Suspense>
    )
  }
  return (
    <main className="flex min-h-screen items-center justify-center bg-ds-canvas p-8 text-ds-ink">
      <section className="flex items-center gap-3 rounded-full border border-ds-border bg-ds-surface px-5 py-3 shadow-sm">
        <span
          className={`h-2.5 w-2.5 rounded-full ${phase === 'recovery_required' ? 'bg-red-500' : 'animate-pulse bg-blue-500'}`}
          aria-hidden="true"
        />
        <span className="text-sm font-medium">{startupPhaseLabel(phase)}</span>
      </section>
    </main>
  )
}

// Late import keeps this module free of the workbench storage implementation
// so the gate stays part of the small entry chunk.
let installSharedBusinessStorageForWorkbench = async (): Promise<void> => {
  const { installSharedBusinessStorage } = await import('./lib/shared-business-storage')
  installSharedBusinessStorageForWorkbench = async () => {
    await installSharedBusinessStorage()
  }
  await installSharedBusinessStorageForWorkbench()
}
