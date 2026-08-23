import React, { lazy, useCallback, useEffect, useRef, useState } from 'react'
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

type WorkbenchBootState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready' }

function bootErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  return String(error)
}

/**
 * Owns the full renderer lifecycle for the single React root: startup shell,
 * special boot views, and the workbench App. Phase transitions go through
 * normal reconciliation instead of repeated createRoot calls on #root.
 *
 * The workbench bootstrap (shared storage install + App chunk load) is an
 * explicit idle/loading/error/ready state machine. A failed bootstrap surfaces
 * an error view with a retry action instead of leaving the shell locked, and
 * shared storage installation is idempotent so a retry never starts a second
 * polling timer.
 */
export function StartupGate({
  storageRelocationMode,
  runtimeMigrationRecoveryMode
}: StartupGateProps): React.ReactElement {
  const [phase, setPhase] = useState<DesktopStartupPhase>('bootstrapping')
  const [boot, setBoot] = useState<WorkbenchBootState>({ status: 'idle' })
  const bootRunRef = useRef(0)

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

  const startWorkbench = useCallback(() => {
    bootRunRef.current += 1
    const run = bootRunRef.current
    setBoot({ status: 'loading' })
    void (async () => {
      try {
        await installSharedBusinessStorageForWorkbench()
        await import('./App')
        if (bootRunRef.current === run) setBoot({ status: 'ready' })
      } catch (error) {
        if (bootRunRef.current === run) {
          setBoot({ status: 'error', message: bootErrorMessage(error) })
        }
      }
    })()
  }, [])

  useEffect(() => {
    if (storageRelocationMode || runtimeMigrationRecoveryMode) return
    if (!startupShellAllowsWorkbench(phase)) return
    // 'idle' starts automatically once the shell allows the workbench;
    // 'error' only restarts through the explicit retry action.
    if (boot.status !== 'idle') return
    startWorkbench()
  }, [phase, boot.status, storageRelocationMode, runtimeMigrationRecoveryMode, startWorkbench])

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
  if (boot.status === 'ready') {
    return (
      <React.Suspense fallback={fallback}>
        <WorkbenchApp />
      </React.Suspense>
    )
  }
  if (boot.status === 'error') {
    return (
      <main className="flex min-h-screen items-center justify-center bg-ds-canvas p-8 text-ds-ink">
        <section className="flex w-full max-w-md flex-col items-center gap-4 rounded-2xl border border-ds-border bg-ds-surface px-8 py-8 text-center shadow-sm">
          <span className="h-2.5 w-2.5 rounded-full bg-red-500" aria-hidden="true" />
          <h1 className="text-base font-semibold">Failed to start Kun workbench</h1>
          <p className="text-sm text-ds-faint">
            The workbench could not finish starting up. Check that the desktop runtime is
            running, then try again.
          </p>
          <p className="w-full break-words rounded-lg bg-ds-canvas px-3 py-2 font-mono text-xs text-ds-faint">
            {boot.message}
          </p>
          <button type="button" className="primary-button" onClick={startWorkbench}>
            Retry
          </button>
        </section>
      </main>
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
