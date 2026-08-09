import { timingSafeEqual } from 'node:crypto'
import { chmod, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { atomicWriteFile } from '../adapters/file/atomic-write.js'
import {
  RuntimeFlavorSchema,
  RuntimeRegistrationSchema,
  ThreadExecutionLeaseSchema,
  type RuntimeFlavor,
  type RuntimeRegistration,
  type ThreadExecutionLease
} from '../contracts/runtime-flavor.js'
import { startNodeHttpServer, type NodeHttpServerHandle } from '../server/node-http-server.js'
import { acquireRuntimeDataDirLease } from '../server/runtime-data-dir-lease.js'
import { readJsonBody } from '../server/read-json-body.js'
import { jsonResponse, type JsonResponse } from '../server/response.js'
import { Router } from '../server/router.js'
import { GraphRunConflictError } from '../graph/graph-run-store.js'
import { KUN_VERSION } from '../version.js'
import {
  KUN_MANAGER_PROTOCOL_VERSION,
  publishManagerDiscovery,
  removeManagerDiscovery,
  type ManagerDiscoveryRecord
} from './manager-discovery.js'
import {
  ManagerSharedDataStore,
  type ManagerAttachmentStoreOperation,
  type ManagerArtifactStoreOperation,
  type ManagerGraphStoreOperation,
  type ManagerMemoryStoreOperation,
  type ManagerSessionStoreOperation,
  type ManagerThreadStoreOperation
} from './shared-data-store.js'
import {
  RevisionConflictError,
  RevisionedDocumentStore
} from './revisioned-document-store.js'

export const KUN_MANAGER_CAPABILITIES = [
  'runtime-slots-v1',
  'shared-data-v1',
  'artifact-memory-data-v1',
  'atomic-json-v1',
  'thread-leases-v1',
  'durable-leases-v1',
  'item-page-v1'
] as const

const ThreadStoreOperationSchema = z.enum([
  'list', 'get', 'getMetadata', 'touch', 'upsert', 'delete'
])
const SessionStoreOperationSchema = z.enum([
  'appendEvent', 'appendItem', 'rewriteItems', 'loadItemSnapshot',
  'rewriteItemsIfRevision', 'updateItem', 'compactItems', 'loadEventsSince',
  'loadItems', 'loadItemPage', 'loadSession', 'upsertSession', 'highestSeq', 'allocateEventSeq',
  'loadUsageRecords', 'loadLatestUsageSnapshots', 'resetMemory', 'clearThreadMemory'
])
const ArtifactStoreOperationSchema = z.enum([
  'put', 'delete', 'list', 'get', 'readRange', 'stat'
])
const MemoryStoreOperationSchema = z.enum([
  'create', 'createWithId', 'update', 'delete', 'purge', 'list', 'retrieve', 'diagnostics'
])
const GraphStoreOperationSchema = z.enum([
  'create', 'append', 'get', 'list', 'events', 'eventReplay', 'snapshot', 'remove', 'diagnostics'
])
const AttachmentStoreOperationSchema = z.enum([
  'create', 'get', 'bindScope', 'bindScopes', 'delete', 'releaseLease',
  'pruneExpiredLeases', 'replaceMetadata', 'resolveContent', 'diagnostics'
])
const MAX_MANAGER_DATA_BODY_BYTES = 64 * 1024 * 1024

type RuntimeSlot = {
  registration: RuntimeRegistration
  lastHeartbeatAt: string
}

export const RUNTIME_HEARTBEAT_TTL_MS = 20_000
export const THREAD_EXECUTION_LEASE_TTL_MS = 15_000
export const RESOURCE_LEASE_TTL_MS = 10_000

export type ManagerResourceLease = {
  resource: string
  ownerFlavor: RuntimeFlavor
  ownerInstanceId: string
  acquiredAt: string
  expiresAt: string
}

const ManagerResourceLeaseSchema = z.object({
  resource: z.string().min(1).max(512),
  ownerFlavor: RuntimeFlavorSchema,
  ownerInstanceId: z.string().min(1).max(256),
  acquiredAt: z.string().datetime(),
  expiresAt: z.string().datetime()
}).strict()

const ServiceManagerStateSnapshotSchema = z.object({
  version: z.literal(1),
  slots: z.array(z.object({
    registration: RuntimeRegistrationSchema,
    lastHeartbeatAt: z.string().datetime()
  }).strict()),
  leases: z.array(ThreadExecutionLeaseSchema),
  resourceLeases: z.array(ManagerResourceLeaseSchema)
}).strict()

type ServiceManagerStateSnapshot = z.infer<typeof ServiceManagerStateSnapshotSchema>

export class ThreadLeaseBusyError extends Error {
  constructor(readonly lease: ThreadExecutionLease) {
    super(`thread_busy: ${lease.threadId} is owned by ${lease.ownerFlavor}/${lease.ownerInstanceId}`)
    this.name = 'ThreadLeaseBusyError'
  }
}

export class RuntimeSlotBusyError extends Error {
  constructor(readonly owner: RuntimeRegistration) {
    super(`runtime_slot_busy: ${owner.flavor} is owned by ${owner.instanceId}`)
    this.name = 'RuntimeSlotBusyError'
  }
}

export class RuntimeRegistrationRequiredError extends Error {}

export class ServiceManagerState {
  private readonly slots = new Map<RuntimeFlavor, RuntimeSlot>()
  private readonly leases = new Map<string, ThreadExecutionLease>()
  private readonly resourceLeases = new Map<string, ManagerResourceLease>()
  private mutationListener: (() => void) | undefined

  static restore(value: unknown): ServiceManagerState {
    const snapshot = ServiceManagerStateSnapshotSchema.parse(value)
    const state = new ServiceManagerState()
    for (const slot of snapshot.slots) state.slots.set(slot.registration.flavor, slot)
    for (const lease of snapshot.leases) state.leases.set(lease.threadId, lease)
    for (const lease of snapshot.resourceLeases) state.resourceLeases.set(lease.resource, lease)
    return state
  }

  onMutation(listener: (() => void) | undefined): void {
    this.mutationListener = listener
  }

  durableSnapshot(): ServiceManagerStateSnapshot {
    return ServiceManagerStateSnapshotSchema.parse({
      version: 1,
      slots: this.snapshot(),
      leases: [...this.leases.values()],
      resourceLeases: [...this.resourceLeases.values()]
    })
  }

  register(registration: RuntimeRegistration, now = new Date()): RuntimeRegistration {
    const parsed = RuntimeRegistrationSchema.parse(registration)
    const existing = this.slots.get(parsed.flavor)
    if (existing && existing.registration.instanceId !== parsed.instanceId) {
      throw new RuntimeSlotBusyError(existing.registration)
    }
    this.slots.set(parsed.flavor, {
      registration: parsed,
      lastHeartbeatAt: now.toISOString()
    })
    this.changed()
    return parsed
  }

  heartbeat(flavor: RuntimeFlavor, instanceId: string, now = new Date()): boolean {
    const slot = this.slots.get(flavor)
    if (!slot || slot.registration.instanceId !== instanceId) return false
    slot.lastHeartbeatAt = now.toISOString()
    this.changed()
    return true
  }

  unregister(flavor: RuntimeFlavor, instanceId: string): boolean {
    const slot = this.slots.get(flavor)
    if (!slot || slot.registration.instanceId !== instanceId) return false
    const removed = this.slots.delete(flavor)
    if (removed) this.changed()
    return removed
  }

  registration(flavor: RuntimeFlavor): RuntimeRegistration | null {
    return this.slots.get(flavor)?.registration ?? null
  }

  snapshot(): Array<RuntimeSlot> {
    return [...this.slots.values()].map((slot) => ({
      registration: { ...slot.registration },
      lastHeartbeatAt: slot.lastHeartbeatAt
    }))
  }

  acquireLease(input: {
    threadId: string
    turnId: string
    ownerFlavor: RuntimeFlavor
    ownerInstanceId: string
  }, now = new Date()): ThreadExecutionLease {
    const slot = this.slots.get(input.ownerFlavor)
    if (!slot || slot.registration.instanceId !== input.ownerInstanceId) {
      throw new RuntimeRegistrationRequiredError('runtime must register before acquiring a thread lease')
    }
    this.expireLeases(now)
    const existing = this.leases.get(input.threadId)
    if (existing && (
      existing.ownerInstanceId !== input.ownerInstanceId ||
      existing.turnId !== input.turnId
    )) {
      throw new ThreadLeaseBusyError(existing)
    }
    const acquiredAt = existing?.acquiredAt ?? now.toISOString()
    const lease = ThreadExecutionLeaseSchema.parse({
      ...input,
      acquiredAt,
      expiresAt: new Date(now.getTime() + THREAD_EXECUTION_LEASE_TTL_MS).toISOString()
    })
    this.leases.set(input.threadId, lease)
    this.changed()
    return lease
  }

  renewLease(input: {
    threadId: string
    turnId: string
    ownerFlavor: RuntimeFlavor
    ownerInstanceId: string
  }, now = new Date()): ThreadExecutionLease | null {
    this.expireLeases(now)
    const existing = this.leases.get(input.threadId)
    if (!existing ||
      existing.turnId !== input.turnId ||
      existing.ownerFlavor !== input.ownerFlavor ||
      existing.ownerInstanceId !== input.ownerInstanceId) return null
    const lease = {
      ...existing,
      expiresAt: new Date(now.getTime() + THREAD_EXECUTION_LEASE_TTL_MS).toISOString()
    }
    this.leases.set(input.threadId, lease)
    this.changed()
    return lease
  }

  releaseLease(input: {
    threadId: string
    turnId: string
    ownerFlavor: RuntimeFlavor
    ownerInstanceId: string
  }): boolean {
    const existing = this.leases.get(input.threadId)
    if (!existing ||
      existing.turnId !== input.turnId ||
      existing.ownerFlavor !== input.ownerFlavor ||
      existing.ownerInstanceId !== input.ownerInstanceId) return false
    const released = this.leases.delete(input.threadId)
    if (released) this.changed()
    return released
  }

  lease(threadId: string, now = new Date()): ThreadExecutionLease | null {
    this.expireLeases(now)
    return this.leases.get(threadId) ?? null
  }

  expireStale(now = new Date()): ThreadExecutionLease[] {
    let changed = false
    for (const [flavor, slot] of this.slots) {
      if (now.getTime() - Date.parse(slot.lastHeartbeatAt) > RUNTIME_HEARTBEAT_TTL_MS) {
        this.slots.delete(flavor)
        changed = true
      }
    }
    for (const [resource, lease] of this.resourceLeases) {
      if (Date.parse(lease.expiresAt) <= now.getTime()) {
        this.resourceLeases.delete(resource)
        changed = true
      }
    }
    const expired = this.expireLeases(now)
    if (changed && expired.length === 0) this.changed()
    return expired
  }

  acquireResource(input: {
    resource: string
    ownerFlavor: RuntimeFlavor
    ownerInstanceId: string
  }, now = new Date()): { acquired: boolean; lease: ManagerResourceLease } {
    const existing = this.resourceLeases.get(input.resource)
    const expired = existing && Date.parse(existing.expiresAt) <= now.getTime()
    const sameOwner = existing?.ownerFlavor === input.ownerFlavor &&
      existing.ownerInstanceId === input.ownerInstanceId
    const productionPreemptsDevelopment =
      (input.resource === 'desktop-host' || input.resource === 'desktop-background-services') &&
      input.ownerFlavor === 'production' &&
      existing?.ownerFlavor === 'development'
    if (existing && !expired && !sameOwner && !productionPreemptsDevelopment) {
      return { acquired: false, lease: existing }
    }
    const lease: ManagerResourceLease = {
      ...input,
      acquiredAt: sameOwner && existing ? existing.acquiredAt : now.toISOString(),
      expiresAt: new Date(now.getTime() + RESOURCE_LEASE_TTL_MS).toISOString()
    }
    this.resourceLeases.set(input.resource, lease)
    this.changed()
    return { acquired: true, lease }
  }

  releaseResource(input: {
    resource: string
    ownerFlavor: RuntimeFlavor
    ownerInstanceId: string
  }): boolean {
    const existing = this.resourceLeases.get(input.resource)
    if (!existing || existing.ownerFlavor !== input.ownerFlavor ||
      existing.ownerInstanceId !== input.ownerInstanceId) return false
    const released = this.resourceLeases.delete(input.resource)
    if (released) this.changed()
    return released
  }

  private expireLeases(now: Date): ThreadExecutionLease[] {
    const expired: ThreadExecutionLease[] = []
    for (const [threadId, lease] of this.leases) {
      const slot = this.slots.get(lease.ownerFlavor)
      const ownerAlive = slot?.registration.instanceId === lease.ownerInstanceId &&
        now.getTime() - Date.parse(slot.lastHeartbeatAt) <= RUNTIME_HEARTBEAT_TTL_MS
      if (Date.parse(lease.expiresAt) > now.getTime() && ownerAlive) continue
      this.leases.delete(threadId)
      expired.push(lease)
    }
    if (expired.length > 0) this.changed()
    return expired
  }

  private changed(): void {
    this.mutationListener?.()
  }
}

export type ServiceManagerHandle = NodeHttpServerHandle & {
  instanceId: string
  discovery: ManagerDiscoveryRecord
  state: ServiceManagerState
  shutdownRequested: Promise<void>
}

export async function startServiceManager(input: {
  controlDir: string
  managerToken: string
  host?: string
  port?: number
  instanceId: string
  startedAt: string
  logPath?: string
  state?: ServiceManagerState
  dataDir: string
  sharedData?: ManagerSharedDataStore
  settingsPath: string
  documents?: RevisionedDocumentStore
}): Promise<ServiceManagerHandle> {
  // The Manager is the physical owner of canonical stores for every managed
  // Runtime flavor. Hold the data-directory lease before constructing those
  // stores so migration and manager election cannot overlap writes.
  const dataDirLease = await acquireRuntimeDataDirLease(input.dataDir)
  const managerStatePath = join(input.controlDir, 'manager-state.json')
  let state: ServiceManagerState
  try {
    state = input.state ?? await readPersistedManagerState(managerStatePath)
  } catch (error) {
    await dataDirLease.release().catch(() => undefined)
    throw error
  }
  let statePersistence = Promise.resolve()
  state.onMutation(() => {
    const snapshot = state.durableSnapshot()
    statePersistence = statePersistence
      .catch(() => undefined)
      .then(async () => {
        await atomicWriteFile(managerStatePath, `${JSON.stringify(snapshot, null, 2)}\n`)
        await chmod(managerStatePath, 0o600).catch((error) => {
          if (process.platform !== 'win32') throw error
        })
      })
      .catch((error) => {
        console.warn('[kun-manager] failed to persist manager lease state:', error)
      })
  })
  let sharedData: ManagerSharedDataStore
  try {
    sharedData = input.sharedData ?? await ManagerSharedDataStore.create(input.dataDir)
  } catch (error) {
    state.onMutation(undefined)
    await dataDirLease.release().catch(() => undefined)
    throw error
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
  let server!: NodeHttpServerHandle
  let discovery!: ManagerDiscoveryRecord
  try {
    const documents = input.documents ?? new RevisionedDocumentStore({
      settingsPath: input.settingsPath,
      clientStatePath: `${input.controlDir}/shared-client-state.json`
    })
    reconciliationTimer = setInterval(() => {
      const expired = state.expireStale()
      for (const lease of expired) {
        void sharedData.reconcileExpiredLease(lease).catch((error) => {
          console.warn('[kun-manager] failed to reconcile expired thread lease:', error)
        })
      }
    }, 1_000)
    reconciliationTimer.unref?.()
    const router = buildServiceManagerRouter({
      managerToken: input.managerToken,
      instanceId: input.instanceId,
      startedAt: input.startedAt,
      state,
      sharedData,
      documents,
      requestShutdown: deferShutdown
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
      dataDir: input.dataDir,
      settingsPath: input.settingsPath,
      ...(input.logPath ? { logPath: input.logPath } : {})
    })
  } catch (error) {
    if (reconciliationTimer) clearInterval(reconciliationTimer)
    state.onMutation(undefined)
    await statePersistence.catch(() => undefined)
    await server?.close().catch(() => undefined)
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
      state.onMutation(undefined)
      let firstError: unknown
      const settle = async (action: () => Promise<unknown>): Promise<void> => {
        try {
          await action()
        } catch (error) {
          if (firstError === undefined) firstError = error
        }
      }
      await settle(() => statePersistence)
      await settle(() => server.close())
      await settle(() => sharedData.close())
      await settle(() => removeManagerDiscovery(input.controlDir, input.instanceId))
      await settle(() => dataDirLease.release())
      if (firstError !== undefined) throw firstError
    }
  }
}

async function readPersistedManagerState(path: string): Promise<ServiceManagerState> {
  try {
    return ServiceManagerState.restore(JSON.parse(await readFile(path, 'utf8')))
  } catch (error) {
    if (String((error as { code?: unknown })?.code ?? '') !== 'ENOENT') {
      console.warn('[kun-manager] ignoring invalid persisted manager state:', error)
    }
    return new ServiceManagerState()
  }
}

export function buildServiceManagerRouter(input: {
  managerToken: string
  instanceId: string
  startedAt: string
  state: ServiceManagerState
  sharedData?: ManagerSharedDataStore
  documents?: RevisionedDocumentStore
  requestShutdown?: () => void
}): Router {
  const router = new Router()
  const capabilities = input.sharedData
    ? KUN_MANAGER_CAPABILITIES
    : KUN_MANAGER_CAPABILITIES.filter((capability) =>
        capability !== 'shared-data-v1' &&
        capability !== 'artifact-memory-data-v1' &&
        capability !== 'atomic-json-v1'
      )
  router.add('GET', '/health', () => jsonResponse({
    status: 'ok',
    service: 'kun-service-manager',
    protocolVersion: KUN_MANAGER_PROTOCOL_VERSION,
    instanceId: input.instanceId,
    pid: process.pid,
    startedAt: input.startedAt,
    serviceVersion: KUN_VERSION,
    capabilities
  }))
  router.add('GET', '/v1/manager/status', (request) => authorized(request, input.managerToken, () =>
    jsonResponse({
      protocolVersion: KUN_MANAGER_PROTOCOL_VERSION,
      instanceId: input.instanceId,
      pid: process.pid,
      startedAt: input.startedAt,
      serviceVersion: KUN_VERSION,
      capabilities,
      slots: input.state.snapshot()
    })))
  router.add('GET', '/v1/runtimes/:flavor', (request, context) => authorized(request, input.managerToken, () => {
    const flavor = RuntimeFlavorSchema.safeParse(context.params.flavor)
    if (!flavor.success) return validation('invalid runtime flavor')
    return jsonResponse({ registration: input.state.registration(flavor.data) })
  }))
  router.add('GET', '/v1/leases/threads/:threadId', (request, context) => authorized(
    request,
    input.managerToken,
    () => jsonResponse({ lease: input.state.lease(context.params.threadId) })
  ))
  router.add('POST', '/v1/leases/threads/:threadId/acquire', (request, context) => authorizedAsync(
    request,
    input.managerToken,
    async () => {
      const body = await readJsonBody(request)
      if (!body.ok) return body.response
      const parsed = z.object({
        turnId: z.string().min(1).max(256),
        ownerFlavor: RuntimeFlavorSchema,
        ownerInstanceId: z.string().min(1).max(256)
      }).strict().safeParse(body.value)
      if (!parsed.success) return validation('invalid thread lease request', parsed.error.issues)
      try {
        return jsonResponse({ lease: input.state.acquireLease({
          threadId: context.params.threadId,
          ...parsed.data
        }) })
      } catch (error) {
        if (error instanceof ThreadLeaseBusyError) {
          return jsonResponse({
            code: 'thread_busy',
            message: error.message,
            owner: error.lease
          }, 409)
        }
        if (error instanceof RuntimeRegistrationRequiredError) {
          return jsonResponse({ code: 'runtime_not_registered', message: error.message }, 409)
        }
        throw error
      }
    }
  ))
  router.add('POST', '/v1/leases/threads/:threadId/renew', (request, context) => authorizedAsync(
    request,
    input.managerToken,
    async () => {
      const body = await readJsonBody(request)
      if (!body.ok) return body.response
      const parsed = leaseOwnerBody(body.value)
      if (!parsed.success) return validation('invalid thread lease renewal', parsed.error.issues)
      const lease = input.state.renewLease({ threadId: context.params.threadId, ...parsed.data })
      return lease
        ? jsonResponse({ lease })
        : jsonResponse({ code: 'thread_lease_lost', message: 'thread lease is no longer owned by this runtime' }, 409)
    }
  ))
  router.add('POST', '/v1/leases/threads/:threadId/release', (request, context) => authorizedAsync(
    request,
    input.managerToken,
    async () => {
      const body = await readJsonBody(request)
      if (!body.ok) return body.response
      const parsed = leaseOwnerBody(body.value)
      if (!parsed.success) return validation('invalid thread lease release', parsed.error.issues)
      return jsonResponse({ released: input.state.releaseLease({
        threadId: context.params.threadId,
        ...parsed.data
      }) })
    }
  ))
  router.add('POST', '/v1/leases/resources/:resource/acquire', (request, context) => authorizedAsync(
    request,
    input.managerToken,
    async () => {
      const body = await readJsonBody(request)
      if (!body.ok) return body.response
      const parsed = z.object({
        ownerFlavor: RuntimeFlavorSchema,
        ownerInstanceId: z.string().min(1).max(256)
      }).strict().safeParse(body.value)
      if (!parsed.success) return validation('invalid resource lease request', parsed.error.issues)
      return jsonResponse(input.state.acquireResource({
        resource: context.params.resource,
        ...parsed.data
      }))
    }
  ))
  router.add('POST', '/v1/leases/resources/:resource/release', (request, context) => authorizedAsync(
    request,
    input.managerToken,
    async () => {
      const body = await readJsonBody(request)
      if (!body.ok) return body.response
      const parsed = z.object({
        ownerFlavor: RuntimeFlavorSchema,
        ownerInstanceId: z.string().min(1).max(256)
      }).strict().safeParse(body.value)
      if (!parsed.success) return validation('invalid resource lease release', parsed.error.issues)
      return jsonResponse({ released: input.state.releaseResource({
        resource: context.params.resource,
        ...parsed.data
      }) })
    }
  ))
  router.add('PUT', '/v1/runtimes/:flavor/register', (request, context) => authorizedAsync(
    request,
    input.managerToken,
    async () => {
      const flavor = RuntimeFlavorSchema.safeParse(context.params.flavor)
      if (!flavor.success) return validation('invalid runtime flavor')
      const body = await readJsonBody(request)
      if (!body.ok) return body.response
      const registration = RuntimeRegistrationSchema.safeParse(body.value)
      if (!registration.success || registration.data.flavor !== flavor.data) {
        return validation('invalid runtime registration', registration.success ? undefined : registration.error.issues)
      }
      try {
        return jsonResponse({ registration: input.state.register(registration.data) })
      } catch (error) {
        if (error instanceof RuntimeSlotBusyError) {
          return jsonResponse({
            code: 'runtime_slot_busy',
            message: error.message,
            owner: error.owner
          }, 409)
        }
        throw error
      }
    }
  ))
  router.add('POST', '/v1/runtimes/:flavor/heartbeat', (request, context) => authorizedAsync(
    request,
    input.managerToken,
    async () => {
      const flavor = RuntimeFlavorSchema.safeParse(context.params.flavor)
      if (!flavor.success) return validation('invalid runtime flavor')
      const body = await readJsonBody(request)
      if (!body.ok) return body.response
      const parsed = z.object({ instanceId: z.string().min(1).max(256) }).strict().safeParse(body.value)
      if (!parsed.success) return validation('invalid heartbeat', parsed.error.issues)
      if (!input.state.heartbeat(flavor.data, parsed.data.instanceId)) {
        return jsonResponse({ code: 'runtime_instance_changed', message: 'runtime slot owner changed' }, 409)
      }
      return jsonResponse({ accepted: true })
    }
  ))
  router.add('DELETE', '/v1/runtimes/:flavor/:instanceId', (request, context) => authorized(
    request,
    input.managerToken,
    () => {
      const flavor = RuntimeFlavorSchema.safeParse(context.params.flavor)
      if (!flavor.success) return validation('invalid runtime flavor')
      return jsonResponse({
        removed: input.state.unregister(flavor.data, context.params.instanceId)
      })
    }
  ))
  router.add('POST', '/v1/manager/shutdown', (request) => authorizedAsync(
    request,
    input.managerToken,
    async () => {
      const body = await readJsonBody(request)
      if (!body.ok) return body.response
      const parsed = z.object({ instanceId: z.literal(input.instanceId) }).strict().safeParse(body.value)
      if (!parsed.success) return jsonResponse({ code: 'manager_instance_changed' }, 409)
      input.requestShutdown?.()
      return jsonResponse({ accepted: true, instanceId: input.instanceId })
    }
  ))
  if (input.sharedData) router.add('POST', '/v1/data/thread/:operation', (request, context) => authorizedAsync(
    request,
    input.managerToken,
    async () => {
      const operation = ThreadStoreOperationSchema.safeParse(context.params.operation)
      if (!operation.success) return validation('invalid thread-store operation')
      const body = await readJsonBody(request, MAX_MANAGER_DATA_BODY_BYTES)
      if (!body.ok) return body.response
      try {
        const result = await input.sharedData!.executeThread(
          operation.data as ManagerThreadStoreOperation,
          body.value
        )
        return jsonResponse({ result })
      } catch (error) {
        if (error instanceof z.ZodError) return validation('invalid thread-store request', error.issues)
        throw error
      }
    }
  ))
  if (input.sharedData) router.add('POST', '/v1/data/session/:operation', (request, context) => authorizedAsync(
    request,
    input.managerToken,
    async () => {
      const operation = SessionStoreOperationSchema.safeParse(context.params.operation)
      if (!operation.success) return validation('invalid session-store operation')
      const body = await readJsonBody(request, MAX_MANAGER_DATA_BODY_BYTES)
      if (!body.ok) return body.response
      try {
        const result = await input.sharedData!.executeSession(
          operation.data as ManagerSessionStoreOperation,
          body.value
        )
        return jsonResponse({ result })
      } catch (error) {
        if (error instanceof z.ZodError) return validation('invalid session-store request', error.issues)
        throw error
      }
    }
  ))
  if (input.sharedData) router.add('POST', '/v1/data/artifact/:operation', (request, context) => authorizedAsync(
    request,
    input.managerToken,
    async () => {
      const operation = ArtifactStoreOperationSchema.safeParse(context.params.operation)
      if (!operation.success) return validation('invalid artifact-store operation')
      const body = await readJsonBody(request, MAX_MANAGER_DATA_BODY_BYTES)
      if (!body.ok) return body.response
      try {
        const result = await input.sharedData!.executeArtifact(
          operation.data as ManagerArtifactStoreOperation,
          body.value
        )
        return jsonResponse({ result })
      } catch (error) {
        if (error instanceof z.ZodError) return validation('invalid artifact-store request', error.issues)
        throw error
      }
    }
  ))
  if (input.sharedData) router.add('POST', '/v1/data/memory/:operation', (request, context) => authorizedAsync(
    request,
    input.managerToken,
    async () => {
      const operation = MemoryStoreOperationSchema.safeParse(context.params.operation)
      if (!operation.success) return validation('invalid memory-store operation')
      const body = await readJsonBody(request, MAX_MANAGER_DATA_BODY_BYTES)
      if (!body.ok) return body.response
      try {
        const result = await input.sharedData!.executeMemory(
          operation.data as ManagerMemoryStoreOperation,
          body.value
        )
        return jsonResponse({ result })
      } catch (error) {
        if (error instanceof z.ZodError) return validation('invalid memory-store request', error.issues)
        throw error
      }
    }
  ))
  if (input.sharedData) router.add('POST', '/v1/data/graph/:operation', (request, context) => authorizedAsync(
    request,
    input.managerToken,
    async () => {
      const operation = GraphStoreOperationSchema.safeParse(context.params.operation)
      if (!operation.success) return validation('invalid graph-store operation')
      const body = await readJsonBody(request, MAX_MANAGER_DATA_BODY_BYTES)
      if (!body.ok) return body.response
      try {
        const result = await input.sharedData!.executeGraph(
          operation.data as ManagerGraphStoreOperation,
          body.value
        )
        return jsonResponse({ result })
      } catch (error) {
        if (error instanceof z.ZodError) return validation('invalid graph-store request', error.issues)
        if (error instanceof GraphRunConflictError) {
          return jsonResponse({ code: 'graph_run_conflict', message: error.message }, 409)
        }
        throw error
      }
    }
  ))
  if (input.sharedData) router.add('POST', '/v1/data/attachment/:operation', (request, context) => authorizedAsync(
    request,
    input.managerToken,
    async () => {
      const operation = AttachmentStoreOperationSchema.safeParse(context.params.operation)
      if (!operation.success) return validation('invalid attachment-store operation')
      const body = await readJsonBody(request, MAX_MANAGER_DATA_BODY_BYTES)
      if (!body.ok) return body.response
      try {
        const result = await input.sharedData!.executeAttachment(
          operation.data as ManagerAttachmentStoreOperation,
          body.value
        )
        return jsonResponse({ result })
      } catch (error) {
        if (error instanceof z.ZodError) return validation('invalid attachment-store request', error.issues)
        throw error
      }
    }
  ))
  if (input.sharedData) router.add('POST', '/v1/data/atomic-json/read', (request) => authorizedAsync(
    request,
    input.managerToken,
    async () => {
      const body = await readJsonBody(request)
      if (!body.ok) return body.response
      const parsed = z.object({ path: z.string().min(1).max(4_096) }).strict().safeParse(body.value)
      if (!parsed.success) return validation('invalid atomic JSON read', parsed.error.issues)
      return jsonResponse({ snapshot: await input.sharedData!.readAtomicJson(parsed.data.path) })
    }
  ))
  if (input.sharedData) router.add('PUT', '/v1/data/atomic-json/write', (request) => authorizedAsync(
    request,
    input.managerToken,
    async () => {
      const body = await readJsonBody(request, MAX_MANAGER_DATA_BODY_BYTES)
      if (!body.ok) return body.response
      const parsed = z.object({
        path: z.string().min(1).max(4_096),
        expectedRevision: z.number().int().nonnegative(),
        value: z.unknown()
      }).strict().safeParse(body.value)
      if (!parsed.success) return validation('invalid atomic JSON write', parsed.error.issues)
      try {
        return jsonResponse({ snapshot: await input.sharedData!.writeAtomicJson(parsed.data) })
      } catch (error) {
        if (error instanceof RevisionConflictError) {
          return jsonResponse({
            code: 'revision_conflict',
            currentRevision: error.currentRevision
          }, 409)
        }
        throw error
      }
    }
  ))
  if (input.sharedData) router.add('DELETE', '/v1/data/atomic-json/delete', (request) => authorizedAsync(
    request,
    input.managerToken,
    async () => {
      const body = await readJsonBody(request)
      if (!body.ok) return body.response
      const parsed = z.object({
        path: z.string().min(1).max(4_096),
        expectedRevision: z.number().int().nonnegative()
      }).strict().safeParse(body.value)
      if (!parsed.success) return validation('invalid atomic JSON delete', parsed.error.issues)
      try {
        return jsonResponse({ snapshot: await input.sharedData!.deleteAtomicJson(parsed.data) })
      } catch (error) {
        if (error instanceof RevisionConflictError) {
          return jsonResponse({
            code: 'revision_conflict',
            currentRevision: error.currentRevision
          }, 409)
        }
        throw error
      }
    }
  ))
  if (input.sharedData) router.add('GET', '/v1/controls/:kind/:id/owner', (request, context) => authorized(
    request,
    input.managerToken,
    () => {
      const kind = z.enum(['approval', 'user-input']).safeParse(context.params.kind)
      if (!kind.success) return validation('invalid control kind')
      const threadId = input.sharedData!.controlThread(kind.data, context.params.id)
      const lease = threadId ? input.state.lease(threadId) : null
      const registration = lease ? input.state.registration(lease.ownerFlavor) : null
      return jsonResponse({ threadId, lease, registration })
    }
  ))
  if (input.documents) router.add('GET', '/v1/documents/:key', (request, context) => authorizedAsync(
    request,
    input.managerToken,
    async () => {
      const key = z.enum(['settings', 'client-state']).safeParse(context.params.key)
      if (!key.success) return validation('invalid document key')
      return jsonResponse({ snapshot: await input.documents!.read(key.data) })
    }
  ))
  if (input.documents) router.add('PUT', '/v1/documents/:key', (request, context) => authorizedAsync(
    request,
    input.managerToken,
    async () => {
      const key = z.enum(['settings', 'client-state']).safeParse(context.params.key)
      if (!key.success) return validation('invalid document key')
      const body = await readJsonBody(request, MAX_MANAGER_DATA_BODY_BYTES)
      if (!body.ok) return body.response
      const parsed = z.object({
        expectedRevision: z.number().int().nonnegative(),
        value: z.string().max(MAX_MANAGER_DATA_BODY_BYTES)
      }).strict().safeParse(body.value)
      if (!parsed.success) return validation('invalid revisioned document write', parsed.error.issues)
      try {
        return jsonResponse({ snapshot: await input.documents!.write({
          key: key.data,
          ...parsed.data
        }) })
      } catch (error) {
        if (error instanceof RevisionConflictError) {
          return jsonResponse({
            code: 'revision_conflict',
            message: error.message,
            currentRevision: error.currentRevision
          }, 409)
        }
        throw error
      }
    }
  ))
  return router
}

function authorized(
  request: Request,
  token: string,
  action: () => JsonResponse | Response
): JsonResponse | Response {
  return tokenMatches(request.headers.get('authorization'), token)
    ? action()
    : jsonResponse({ code: 'unauthorized', message: 'manager authorization required' }, 401)
}

async function authorizedAsync(
  request: Request,
  token: string,
  action: () => Promise<JsonResponse | Response>
): Promise<JsonResponse | Response> {
  return tokenMatches(request.headers.get('authorization'), token)
    ? action()
    : jsonResponse({ code: 'unauthorized', message: 'manager authorization required' }, 401)
}

function tokenMatches(header: string | null, expected: string): boolean {
  const actual = header?.replace(/^Bearer\s+/iu, '') ?? ''
  const left = Buffer.from(actual)
  const right = Buffer.from(expected)
  return left.length === right.length && timingSafeEqual(left, right)
}

function validation(message: string, details?: unknown): JsonResponse {
  return jsonResponse({ code: 'validation_error', message, ...(details ? { details } : {}) }, 400)
}

function leaseOwnerBody(value: unknown) {
  return z.object({
    turnId: z.string().min(1).max(256),
    ownerFlavor: RuntimeFlavorSchema,
    ownerInstanceId: z.string().min(1).max(256)
  }).strict().safeParse(value)
}
