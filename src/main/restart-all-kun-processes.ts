import type { RuntimeFlavor, RuntimeRegistration } from '../../kun/src/contracts/runtime-flavor.js'
import {
  readManagerRuntime,
  requestManagerJson,
  type ServiceManagerConnection
} from '../../kun/src/manager/manager-client.js'
import { stopSharedRuntime } from '../../kun/src/cli/shared-runtime.js'
import { terminateStalePid, waitForPidExit } from './kun-process-ports'

const RUNTIME_FLAVORS: readonly RuntimeFlavor[] = ['production', 'development']

type RestartAllKunProcessDependencies = {
  readRuntime: typeof readManagerRuntime
  stopRuntime: typeof stopSharedRuntime
  shutdownManager: (manager: ServiceManagerConnection) => Promise<void>
  terminatePid: (pid: number) => Promise<boolean>
  waitForExit: (pid: number, timeoutMs: number) => Promise<boolean>
}

export type RestartAllKunProcessReport = {
  stoppedRuntimePids: number[]
  forcedPids: number[]
  managerPid: number
}

const defaultDependencies: RestartAllKunProcessDependencies = {
  readRuntime: readManagerRuntime,
  stopRuntime: stopSharedRuntime,
  shutdownManager: shutdownManagerGracefully,
  terminatePid: terminateStalePid,
  waitForExit: waitForPidExit
}

/**
 * Stop both shared Runtime flavors and their Service Manager before the
 * desktop relaunches. PIDs come only from the authenticated Manager; the
 * force fallback never scans or kills unrelated processes by name.
 */
export async function stopAllKunBackgroundProcesses(
  manager: ServiceManagerConnection,
  overrides: Partial<RestartAllKunProcessDependencies> = {}
): Promise<RestartAllKunProcessReport> {
  const deps = { ...defaultDependencies, ...overrides }
  const registrations = await Promise.all(
    RUNTIME_FLAVORS.map((flavor) => readRuntimeRegistration(manager, flavor, deps))
  )
  const forcedPids: number[] = []

  await Promise.all(RUNTIME_FLAVORS.map(async (flavor, index) => {
    const registration = registrations[index]
    try {
      await deps.stopRuntime(manager.discovery.dataDir, fetch, {
        runtimeFlavor: flavor,
        manager
      })
    } catch (error) {
      if (!registration) throw error
      await forceVerifiedPidExit(registration.pid, deps, forcedPids)
      return
    }
    if (registration && !(await deps.waitForExit(registration.pid, 0))) {
      await forceVerifiedPidExit(registration.pid, deps, forcedPids)
    }
  }))

  try {
    await deps.shutdownManager(manager)
  } catch (error) {
    if (await deps.waitForExit(manager.discovery.pid, 0)) {
      return report(registrations, forcedPids, manager.discovery.pid)
    }
    await forceVerifiedPidExit(manager.discovery.pid, deps, forcedPids)
  }

  if (!(await deps.waitForExit(manager.discovery.pid, 0))) {
    await forceVerifiedPidExit(manager.discovery.pid, deps, forcedPids)
  }
  return report(registrations, forcedPids, manager.discovery.pid)
}

async function readRuntimeRegistration(
  manager: ServiceManagerConnection,
  flavor: RuntimeFlavor,
  deps: RestartAllKunProcessDependencies
): Promise<RuntimeRegistration | null> {
  try {
    return await deps.readRuntime(manager, flavor, fetch)
  } catch {
    // stopRuntime still owns the authenticated discovery probe. A missing
    // snapshot only disables the force fallback for this flavor.
    return null
  }
}

async function forceVerifiedPidExit(
  pid: number,
  deps: RestartAllKunProcessDependencies,
  forcedPids: number[]
): Promise<void> {
  if (pid === process.pid) throw new Error('refusing to terminate the current Kun desktop process')
  const terminated = await deps.terminatePid(pid)
  if (!terminated && !(await deps.waitForExit(pid, 0))) {
    throw new Error(`Kun process ${pid} could not be terminated`)
  }
  if (!(await deps.waitForExit(pid, 2_000))) {
    throw new Error(`Kun process ${pid} did not exit after termination`)
  }
  if (!forcedPids.includes(pid)) forcedPids.push(pid)
}

async function shutdownManagerGracefully(manager: ServiceManagerConnection): Promise<void> {
  await requestManagerJson(manager, '/v1/manager/shutdown', {
    method: 'POST',
    body: { instanceId: manager.discovery.instanceId },
    timeoutMs: 10_000
  })
  if (!(await waitForPidExit(manager.discovery.pid, 15_000))) {
    throw new Error('Kun Service Manager did not exit after shutdown')
  }
}

function report(
  registrations: Array<RuntimeRegistration | null>,
  forcedPids: number[],
  managerPid: number
): RestartAllKunProcessReport {
  return {
    stoppedRuntimePids: registrations.flatMap((registration) =>
      registration ? [registration.pid] : []
    ),
    forcedPids,
    managerPid
  }
}
