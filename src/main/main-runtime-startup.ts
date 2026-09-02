import {
  getKunRuntimeSettings,
  type AppSettingsV1
} from '../shared/app-settings'
import {
  kunRuntimeAdapter
} from './runtime/kun-adapter'
import {
  isKunChildRunning,
  waitForKunStartupSettled
} from './kun-process'
import { clearHistoricalKunServeProcesses } from './runtime/kun-serve-process-cleanup'
import { waitForRuntimeTurnsIdle } from './runtime/managed-runtime-idle'
import { managedKunHostCanAutoStart } from './managed-runtime-startup-policy'
import { logWarn } from './logger'
import {
  mainState,
  runtimeJsonError
} from './main-app-context'
import {
  kunRuntimeHealthMonitor,
  noteRuntimeHealthy,
  probeRuntimeApi,
  RUNTIME_HUNG_CONFIRM_MS,
  runtimeFingerprint,
  runtimeSupervisor
} from './main-runtime-health'

export async function ensureRuntime(settings: AppSettingsV1): Promise<AppSettingsV1> {
  const requested = runtimeSupervisor.latestOr(settings)
  // Availability is the durable intent, not a reward for one successful
  // launch. Arm recovery before the first attempt so a cold-start failure is
  // retried automatically by the watchdog.
  if (managedKunHostCanAutoStart(requested)) {
    runtimeSupervisor.setManagedRuntimeExpected(true)
  }
  mainState.assertCanonicalRuntimeMigrationReady()
  const fingerprint = runtimeFingerprint(requested)
  return runtimeSupervisor.ensure(
    fingerprint,
    // Freeze this FIFO node to the snapshot used for its fingerprint. A later
    // persisted settings snapshot has its own queued apply node and must not
    // jump across this lifecycle barrier.
    () => ensureRuntimeOnce(requested)
  )
}

async function ensureRuntimeOnce(settings: AppSettingsV1): Promise<AppSettingsV1> {
  return ensureKunRuntime(settings)
}

export async function resolveManagedKunLaunchSettings(
  settings: AppSettingsV1,
  _source: string
): Promise<AppSettingsV1> {
  // The GUI owns one supervised child on its configured loopback port. The
  // data-directory/Manager election still prevents a foreign GUI/TUI owner.
  return settings
}

export async function ensureKunRuntime(settings: AppSettingsV1): Promise<AppSettingsV1> {
  const currentSettings = settings
  const connectionResolved = await kunRuntimeAdapter.resolveConnection(currentSettings)

  const runtime = getKunRuntimeSettings(currentSettings)

  const healthy = connectionResolved &&
    // Match the watchdog probe budget: a single big scan (large events.jsonl
    // cold read) can exceed 2s without the runtime being unhealthy, and the
    // hung path below still provides the multi-second confirmation window.
    await kunRuntimeHealthMonitor.waitForHealthy(currentSettings, 5_000)
  if (healthy) {
    const runtimeApi = await probeRuntimeApi(currentSettings)
    if (runtimeApi.ok) {
      noteRuntimeHealthy('ensure', currentSettings)
      return currentSettings
    }
    throw runtimeJsonError(runtimeApi.error, runtimeApi.message)
  }

  if (!runtime.autoStart) {
    throw runtimeJsonError(
      'runtime_offline',
      'Kun is offline. Enable automatic startup in Settings, or start `kun serve` manually.'
    )
  }

  // A GUI-owned child that failed the probe may only be busy or waking from
  // system sleep. Give it a real recovery window before replacing it.
  if (kunRuntimeAdapter.isChildRunning()) {
    // Never tear down a child still inside its (deliberately generous) startup
    // window — interrupting a slow-but-healthy boot is the #544 restart storm.
    await waitForKunStartupSettled()
    if (kunRuntimeAdapter.isChildRunning()) {
      // Give a merely-busy runtime a real chance to answer before judging it
      // hung, so one long synchronous step does not cost the user their turn.
      const recovered = await kunRuntimeHealthMonitor.waitForHealthy(currentSettings, RUNTIME_HUNG_CONFIRM_MS)
      if (recovered) {
        const runtimeApi = await probeRuntimeApi(currentSettings)
        if (runtimeApi.ok) {
          noteRuntimeHealthy('ensure', currentSettings)
          return currentSettings
        }
        throw runtimeJsonError(runtimeApi.error, runtimeApi.message)
      }
      if (!isKunChildRunning()) {
        throw runtimeJsonError(
          'runtime_unhealthy',
          'Kun is still running but temporarily unresponsive. Its active runtime was preserved; retry after it recovers.'
        )
      }
      // The controller-held GUI child can be replaced safely in place.
      logWarn(
        'runtime-start',
        `GUI-private Kun child stopped responding on port ${runtime.port}; restarting it in place`
      )
      await kunRuntimeAdapter.stopSharedAndWait(currentSettings)
    }
  }

  const launchSettings = await resolveManagedKunLaunchSettings(currentSettings, 'runtime-start')
  const adapter = kunRuntimeAdapter
  try {
    await adapter.ensureRunning(launchSettings)
  } catch (e) {
    console.error('[kun-gui] failed to start kun:', e)
    throw e
  }
  const started = await kunRuntimeHealthMonitor.waitForHealthy(launchSettings, 20_000)
  if (!started) {
    throw runtimeJsonError(
      'runtime_unhealthy',
      'Kun did not become healthy after launch.'
    )
  }

  const runtimeApi = await probeRuntimeApi(launchSettings)
  if (!runtimeApi.ok) {
    throw runtimeJsonError(runtimeApi.error, runtimeApi.message)
  }
  noteRuntimeHealthy('ensure', launchSettings)
  return launchSettings
}

/**
 * Startup policy: the GUI starts its own supervised child and never adopts a
 * TUI/foreign owner. The retained name keeps startup wiring stable.
 *
 * Automatic-startup disabled: attach-only, exactly like a plain ensure.
 */
export async function ensureKunServeFreshOnStartup(
  settings: AppSettingsV1
): Promise<AppSettingsV1> {
  const requested = runtimeSupervisor.latestOr(settings)
  if (!managedKunHostCanAutoStart(requested)) return requested
  return ensureRuntime(requested)
}

export async function restartRuntime(settings: AppSettingsV1): Promise<void> {
  const requested = runtimeSupervisor.latestOr(settings)
  if (!managedKunHostCanAutoStart(requested)) {
    runtimeSupervisor.setManagedRuntimeExpected(false)
  }
  return runtimeSupervisor.restart(
    // As with ensure, the queued restart owns exactly the settings snapshot
    // captured at enqueue time. Later settings are reconciled behind it.
    () => restartRuntimeOnce(requested)
  )
}

async function restartRuntimeOnce(settings: AppSettingsV1): Promise<void> {
  const idle = kunRuntimeAdapter.isChildRunning()
    ? await waitForRuntimeTurnsIdle({ settings })
    : 'idle'
  if (idle !== 'idle') {
    throw runtimeJsonError(
      'runtime_busy',
      idle === 'timeout'
        ? 'Kun still has active tasks; restart was deferred.'
        : 'Kun task state could not be verified; restart was deferred.'
    )
  }
  await restartRuntimeAfterStopping(
    settings,
    () => kunRuntimeAdapter.stopSharedAndWait(settings)
  )
}

/**
 * Replace the current shared serve after an explicit user or installer action.
 * Ordinary restarts keep their conservative shared-runtime stop behavior so a
 * watchdog cannot terminate an unresponsive turn by accident.
 */
export async function replaceKunServe(settings: AppSettingsV1): Promise<void> {
  const requested = runtimeSupervisor.latestOr(settings)
  if (!managedKunHostCanAutoStart(requested)) {
    runtimeSupervisor.setManagedRuntimeExpected(false)
  }
  return runtimeSupervisor.replace(
    () => replaceKunServeOnce(requested)
  )
}

/**
 * Broad restart used only by an explicit user action. Stop the current
 * discovered owner through the authenticated replacement path, then clear
 * any remaining current-user historical `kun serve` processes before electing
 * one fresh runtime.
 *
 * Ordinary health recovery remains separate so transient failures do not
 * interrupt another client or data-directory owner.
 */
export async function restartAllKunServeProcesses(
  settings: AppSettingsV1
): Promise<void> {
  const requested = runtimeSupervisor.latestOr(settings)
  if (!managedKunHostCanAutoStart(requested)) {
    runtimeSupervisor.setManagedRuntimeExpected(false)
  }
  return runtimeSupervisor.replace(
    () => restartAllKunServeProcessesOnce(requested)
  )
}

/**
 * Explicit desktop control: restart only the child owned by this Electron
 * process. Unlike the conservative automatic restart, this confirmed action
 * may interrupt active work. It never scans for or stops foreign Kun serves.
 */
export async function restartGuiRuntime(settings: AppSettingsV1): Promise<void> {
  const requested = runtimeSupervisor.latestOr(settings)
  if (!managedKunHostCanAutoStart(requested)) {
    runtimeSupervisor.setManagedRuntimeExpected(false)
  }
  return runtimeSupervisor.replace(
    () => restartRuntimeAfterStopping(
      requested,
      () => kunRuntimeAdapter.stopAndWait()
    )
  )
}

async function restartAllKunServeProcessesOnce(settings: AppSettingsV1): Promise<void> {
  await restartRuntimeAfterStopping(
    settings,
    async () => {
      await kunRuntimeAdapter.stopSharedForReplacementAndWait(settings)
      await clearHistoricalKunServeProcesses()
    },
    (launchSettings) => kunRuntimeAdapter.ensureReplacementRunning(launchSettings)
  )
}

async function replaceKunServeOnce(settings: AppSettingsV1): Promise<void> {
  await restartRuntimeAfterStopping(
    settings,
    () => kunRuntimeAdapter.stopSharedForReplacementAndWait(settings),
    (launchSettings) => kunRuntimeAdapter.ensureReplacementRunning(launchSettings)
  )
}

/**
 * A packaged bundle becomes authoritative after an update or manual install.
 * When automatic startup is disabled, remove the verified old serve but honor
 * the user's preference not to launch a replacement until they enable it.
 */
export async function reconcileBundledRuntimeAfterInstall(
  settings: AppSettingsV1
): Promise<void> {
  mainState.assertCanonicalRuntimeMigrationReady()
  const requested = runtimeSupervisor.latestOr(settings)
  const probe = await kunRuntimeAdapter.probeBundledBuildReplacement(requested)
  if (probe.state === 'matched') return
  if (probe.state === 'unknown') throw probe.error
  // Ordinary packaged startup never replaces an already registered client
  // owner. A GUI/TUI-owned Runtime must survive until its owner exits, while an
  // exact legacy shared daemon is retired narrowly by the client-owned election
  // immediately before spawn. Ambiguous ownerless evidence also fails there.
}

async function restartRuntimeAfterStopping(
  settings: AppSettingsV1,
  stop: () => Promise<void>,
  ensure: (settings: AppSettingsV1) => Promise<void> = (launchSettings) =>
    kunRuntimeAdapter.ensureRunning(launchSettings)
): Promise<void> {
  mainState.assertCanonicalRuntimeMigrationReady()
  // Don't tear down a child that is still completing its startup; wait for it
  // to settle so a restart trigger that races a boot doesn't reset the clock
  // (#544). Resolves immediately when nothing is launching.
  await waitForKunStartupSettled()
  const runtime = getKunRuntimeSettings(settings)

  if (!runtime.autoStart) {
    throw runtimeJsonError(
      'runtime_offline',
      'Kun is offline. Enable automatic startup in Settings, or start `kun serve` manually.'
    )
  }

  const adapter = kunRuntimeAdapter
  await stop()
  const launchSettings = await resolveManagedKunLaunchSettings(settings, 'runtime-restart')

  try {
    await ensure(launchSettings)
  } catch (e) {
    console.error('[kun-gui] failed to restart kun:', e)
    throw e
  }

  const healthy = await kunRuntimeHealthMonitor.waitForHealthy(launchSettings, 20_000)
  if (!healthy) {
    throw runtimeJsonError(
      'runtime_unhealthy',
      'Kun did not become healthy after restart.'
    )
  }

  const runtimeApi = await probeRuntimeApi(launchSettings)
  if (!runtimeApi.ok) {
    throw runtimeJsonError(runtimeApi.error, runtimeApi.message)
  }
  noteRuntimeHealthy('restart', launchSettings)
}
