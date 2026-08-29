import { chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWriteFile } from '../adapters/file/atomic-write.js'
import { acquireRuntimeDataDirLease } from '../server/runtime-data-dir-lease.js'
import { startNodeHttpServer, type NodeHttpServerHandle } from '../server/node-http-server.js'
import { KUN_VERSION } from '../version.js'
import {
  publishManagerDiscovery,
  removeManagerDiscovery,
  type ManagerDiscoveryRecord
} from './manager-discovery.js'
import { readForcedRuntimeRecovery } from './forced-runtime-recovery.js'
import { RevisionedDocumentStore } from './revisioned-document-store.js'
import { buildServiceManagerRouter } from './service-manager-router.js'
import {
  reconcileVerifiedForcedRuntimeRecovery,
  readPersistedManagerState,
  ServiceManagerState,
  type ServiceManagerHandle
} from './service-manager-state.js'
import { ManagerSharedDataStore } from './shared-data-store.js'

export async function startServiceManager(input: {
  controlDir: string
  managerToken: string
  host?: string
  port?: number
  instanceId: string
  startedAt: string
  buildId?: string
  logPath?: string
  state?: ServiceManagerState
  dataDir: string
  sharedData?: ManagerSharedDataStore
  settingsPath: string
  documents?: RevisionedDocumentStore
}): Promise<ServiceManagerHandle> {
  const dataDirLease = await acquireRuntimeDataDirLease(input.dataDir)
  const managerStatePath = join(input.controlDir, 'manager-state.json')
  let state: ServiceManagerState
  let forcedRecovery: Awaited<ReturnType<typeof readForcedRuntimeRecovery>>
  try {
    ;[state, forcedRecovery] = await Promise.all([
      input.state ?? readPersistedManagerState(managerStatePath),
      readForcedRuntimeRecovery(input.controlDir)
    ])
  } catch (error) {
    await dataDirLease.release().catch(() => undefined)
    throw error
  }
  let statePersistence = Promise.resolve()
  let statePersistenceError: unknown
  state.onMutation(() => {
    if (statePersistenceError !== undefined) return
    const snapshot = state.durableSnapshot()
    statePersistence = statePersistence.then(async () => {
      await atomicWriteFile(managerStatePath, `${JSON.stringify(snapshot, null, 2)}\n`)
      await chmod(managerStatePath, 0o600).catch((error) => {
        if (process.platform !== 'win32') throw error
      })
    }).catch((error) => {
      statePersistenceError = error
      console.error('[kun-manager] failed to persist manager lease state:', error)
      throw error
    })
    void statePersistence.catch(() => undefined)
  })
  const flushState = async () => {
    await statePersistence
    if (statePersistenceError !== undefined) throw statePersistenceError
  }
  let sharedData: ManagerSharedDataStore
  try {
    sharedData = input.sharedData ?? await ManagerSharedDataStore.create(input.dataDir)
  } catch (error) {
    state.onMutation(undefined)
    await dataDirLease.release().catch(() => undefined)
    throw error
  }
  if (forcedRecovery) {
    try {
      await reconcileVerifiedForcedRuntimeRecovery({
        controlDir: input.controlDir,
        dataDir: input.dataDir,
        record: forcedRecovery,
        state,
        sharedData,
        flushState: () => statePersistence
      })
    } catch (error) {
      state.onMutation(undefined)
      await statePersistence.catch(() => undefined)
      await sharedData.close().catch(() => undefined)
      await dataDirLease.release().catch(() => undefined)
      throw error
    }
  }
  let requestShutdown!: () => void
  const shutdownRequested = new Promise<void>((resolve) => { requestShutdown = resolve })
  let shutdownTimer: ReturnType<typeof setTimeout> | undefined
  const deferShutdown = () => {
    if (shutdownTimer) return
    shutdownTimer = setTimeout(requestShutdown, 25)
    shutdownTimer.unref?.()
  }
  let reconciliationTimer: ReturnType<typeof setInterval> | undefined
  let reconciliationWork = Promise.resolve()
  let reconciliationInFlight = false
  let server!: NodeHttpServerHandle
  let discovery!: ManagerDiscoveryRecord
  try {
    const documents = input.documents ?? new RevisionedDocumentStore({
      settingsPath: input.settingsPath,
      clientStatePath: `${input.controlDir}/shared-client-state.json`
    })
    reconciliationTimer = setInterval(() => {
      if (reconciliationInFlight) return
      const expired = state.expireStale()
      if (expired.length === 0) return
      reconciliationInFlight = true
      reconciliationWork = (async () => {
        await flushState()
        for (const lease of expired) {
          try {
            await sharedData.reconcileExpiredLease(lease)
            state.completeExpiredLeaseReconciliation(lease)
            await flushState()
          } catch (error) {
            console.warn('[kun-manager] failed to reconcile expired thread lease:', error)
          }
        }
      })().catch((error) => {
        console.warn('[kun-manager] lease reconciliation cycle failed:', error)
      }).finally(() => { reconciliationInFlight = false })
    }, 1_000)
    reconciliationTimer.unref?.()
    const router = buildServiceManagerRouter({
      managerToken: input.managerToken,
      instanceId: input.instanceId,
      startedAt: input.startedAt,
      ...(input.buildId ? { buildId: input.buildId } : {}),
      state,
      sharedData,
      documents,
      requestShutdown: deferShutdown,
      flushState
    })
    server = await startNodeHttpServer({
      router,
      host: input.host ?? '127.0.0.1',
      port: input.port ?? 0
    })
    discovery = await publishManagerDiscovery(input.controlDir, {
      instanceId: input.instanceId,
      pid: process.pid,
      startedAt: input.startedAt,
      host: server.host,
      port: server.port,
      baseUrl: `http://${server.host}:${server.port}`,
      managerToken: input.managerToken,
      serviceVersion: KUN_VERSION,
      ...(input.buildId ? { buildId: input.buildId } : {}),
      dataDir: input.dataDir,
      settingsPath: input.settingsPath,
      ...(input.logPath ? { logPath: input.logPath } : {})
    })
  } catch (error) {
    if (reconciliationTimer) clearInterval(reconciliationTimer)
    await server?.close().catch(() => undefined)
    await statePersistence.catch(() => undefined)
    state.onMutation(undefined)
    await sharedData.close().catch(() => undefined)
    await dataDirLease.release().catch(() => undefined)
    throw error
  }
  let closed = false
  return {
    ...server,
    instanceId: input.instanceId,
    discovery,
    state,
    shutdownRequested,
    close: async () => {
      if (closed) return
      closed = true
      if (shutdownTimer) clearTimeout(shutdownTimer)
      if (reconciliationTimer) clearInterval(reconciliationTimer)
      let firstError: unknown
      const settle = async (action: () => Promise<unknown>): Promise<void> => {
        try { await action() } catch (error) {
          if (firstError === undefined) firstError = error
        }
      }
      await settle(() => reconciliationWork)
      state.onMutation(undefined)
      await settle(() => server.close())
      await settle(() => statePersistence)
      state.onMutation(undefined)
      await settle(() => sharedData.close())
      await settle(() => removeManagerDiscovery(input.controlDir, input.instanceId))
      await settle(() => dataDirLease.release())
      if (firstError !== undefined) throw firstError
    }
  }
}
