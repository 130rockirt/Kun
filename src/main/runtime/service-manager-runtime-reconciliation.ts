import {
  inspectSharedRuntime,
  type SharedRuntimeInspection
} from '../../../kun/src/cli/shared-runtime.js'
import type { RuntimeFlavor } from '../../../kun/src/contracts/runtime-flavor.js'
import type { ServiceManagerConnection } from '../../../kun/src/manager/manager-client.js'

const MANAGED_RUNTIME_FLAVORS: readonly RuntimeFlavor[] = ['production', 'development']

type InspectSharedRuntime = (
  dataDir: string,
  fetchImpl: typeof fetch,
  scope: {
    runtimeFlavor: RuntimeFlavor
    manager: ServiceManagerConnection
  }
) => Promise<SharedRuntimeInspection | null>

/**
 * Reconcile only Manager slots whose recorded PID has already exited.
 *
 * `inspectSharedRuntime` authenticates the Manager, checks the PID, and
 * removes the exact stale instance ID. A live Runtime that does not answer an
 * HTTP probe deliberately remains registered; callers then fail closed rather
 * than treating an unverified writer as stale.
 */
export async function reconcileDeadManagerRuntimeRegistrations(
  manager: ServiceManagerConnection,
  options: {
    fetch?: typeof fetch
    inspect?: InspectSharedRuntime
  } = {}
): Promise<void> {
  const inspect = options.inspect ?? inspectSharedRuntime
  const fetchImpl = options.fetch ?? fetch
  await Promise.all(MANAGED_RUNTIME_FLAVORS.map(async (runtimeFlavor) => {
    await inspect(manager.discovery.dataDir, fetchImpl, { runtimeFlavor, manager })
  }))
}
