import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { assertManagerAtomicJsonPath, AtomicJsonFile } from '../extensions/atomic-json.js'
import type { ServeProviderConfig } from '../config/kun-config.js'
import type { ModelCapabilityMetadata } from '../contracts/capabilities.js'
import {
  ModelConnectionConnectRequestSchema,
  ModelConnectionCredentialCommitRequestSchema,
  ModelConnectionCredentialFenceRequestSchema,
  ModelConnectionCredentialPrepareRequestSchema,
  ModelConnectionCredentialRequestSchema,
  ModelConnectionGlobalsRequestSchema,
  ModelConnectionPatchRequestSchema,
  ModelConnectionSelectRequestSchema,
  ModelConnectionSnapshotSchema,
  type ModelConnectionConnectRequest,
  type ModelConnectionCredentialErrorCode,
  type ModelConnectionCredentialStatus,
  type ModelConnectionProfile,
  type ModelConnectionSnapshot
} from '../contracts/model-connections.js'
import { materializeLegacyProviderCredential } from './legacy-provider-credential-migration.js'
import type { ExtensionCredentialStore } from './extension-credential-store.js'
import { createProxyFetch } from '../adapters/model/proxy-fetch.js'

const StoredProfileSchema = ModelConnectionSnapshotSchema.shape.providers.element.omit({
  credentialStatus: true,
  credentialErrorCode: true
}).extend({
  incarnationId: z.string().uuid().optional(),
  credentialMutationHighWater: z.record(
    z.string().uuid(),
    z.number().int().positive()
  ).optional(),
  credentialRef: z.string().min(1).max(256).optional(),
  credentialSourceId: z.string().min(1).max(256).optional(),
  legacyCredentialSourceToRetire: z.string().min(1).max(256).optional(),
  headers: z.record(z.string(), z.string()).optional()
})
const DeletedProfileTombstoneSchema = z.object({
  deletedRevision: z.number().int().nonnegative(),
  credentialMutationHighWater: z.record(
    z.string().uuid(),
    z.number().int().positive()
  ).optional(),
  legacyCredentialSourceToRetire: z.string().min(1).max(256).optional()
}).strict()
const CredentialTransactionPreviousSchema = z.object({
  credentialRef: z.string().min(1).max(256).optional(),
  credentialSourceId: z.string().min(1).max(256).optional(),
  legacyCredentialSourceToRetire: z.string().min(1).max(256).optional(),
  configured: z.boolean()
}).strict()
const CredentialTransactionSchema = z.object({
  operationToken: z.string().min(1).max(128),
  clientId: z.string().uuid(),
  generation: z.number().int().positive(),
  incarnationId: z.string().uuid(),
  phase: z.enum(['fenced', 'prepared', 'committing', 'recovering']),
  expiresAt: z.number().int().nonnegative(),
  previous: CredentialTransactionPreviousSchema,
  nextCredentialRef: z.string().min(1).max(256).optional(),
  writerInstanceId: z.string().uuid().optional(),
  writerPid: z.number().int().positive().optional(),
  recoveryOwnerId: z.string().uuid().optional(),
  recoveryOwnerPid: z.number().int().positive().optional()
}).strict()
const CredentialRefCleanupEntrySchema = z.object({
  reference: z.string().min(1).max(256),
  enqueuedAt: z.number().int().nonnegative(),
  writerInstanceId: z.string().uuid().optional(),
  writerPid: z.number().int().positive().optional()
}).strict()
const RegistryDocumentSchema = z.object({
  schemaVersion: z.literal(1),
  revision: z.number().int().nonnegative(),
  profiles: z.record(z.string(), StoredProfileSchema),
  tombstones: z.record(z.string(), DeletedProfileTombstoneSchema).default({}),
  credentialTransactions: z.record(z.string(), CredentialTransactionSchema).default({}),
  credentialRefCleanup: z.record(
    z.string().min(1).max(256),
    CredentialRefCleanupEntrySchema
  ).default({}),
  defaultProviderId: z.string().min(1).optional(),
  defaultAccountId: z.string().min(1).optional(),
  defaultModel: z.string().min(1).optional(),
  proxy: ModelConnectionSnapshotSchema.shape.proxy,
  routePools: ModelConnectionSnapshotSchema.shape.routePools,
  localModelGateway: ModelConnectionSnapshotSchema.shape.localModelGateway
}).strict()
type RegistryDocument = z.infer<typeof RegistryDocumentSchema>
type StoredProfile = z.infer<typeof StoredProfileSchema>
type CredentialTransaction = z.infer<typeof CredentialTransactionSchema>
type PreparedCredentialSecret = {
  operationToken: string
  incarnationId: string
  credential: string
}

export type ModelConnectionSeed = ModelConnectionConnectRequest & {
  /** Trusted runtime-only binding; never accepted by public connection APIs. */
  credentialSourceId?: string
}

export type AuthenticatedModelConnectionInput = Omit<
  ModelConnectionConnectRequest,
  'credential' | 'probe'
> & {
  /**
   * Credential material produced by a runtime-owned OAuth/SDK flow. Official
   * CLI providers omit this only after the service has verified their
   * provider-owned login.
   */
  credential?: string
  externalAuthVerified?: boolean
}

const MODEL_CONNECTION_CREDENTIAL_SOURCE_PREFIX = 'model-connection:'

export function isModelConnectionCredentialSourceId(sourceId: string): boolean {
  return sourceId.startsWith(MODEL_CONNECTION_CREDENTIAL_SOURCE_PREFIX) &&
    sourceId.length > MODEL_CONNECTION_CREDENTIAL_SOURCE_PREFIX.length
}

export function modelConnectionCredentialSourceId(providerId: string): string {
  return `${MODEL_CONNECTION_CREDENTIAL_SOURCE_PREFIX}${providerId}`
}

export function providerIdFromCredentialSource(sourceId: string): string | null {
  if (!isModelConnectionCredentialSourceId(sourceId)) return null
  return sourceId.slice(MODEL_CONNECTION_CREDENTIAL_SOURCE_PREFIX.length)
}

export class ModelConnectionConflictError extends Error {
  constructor(readonly snapshot: ModelConnectionSnapshot) {
    super('model connection registry revision changed')
    this.name = 'ModelConnectionConflictError'
  }
}

export type MaterializedModelConnections = {
  selected?: { profile: StoredProfile; config: ServeProviderConfig; model: string }
  providers: Map<string, ServeProviderConfig>
  proxy: RegistryDocument['proxy']
  routePools: RegistryDocument['routePools']
  localModelGateway: RegistryDocument['localModelGateway']
}

export class ModelConnectionRegistry {
  private readonly file: AtomicJsonFile<RegistryDocument>
  private listeners = new Set<(snapshot: ModelConnectionSnapshot) => void>()
  private changeOperation: Promise<void> = Promise.resolve()
  private lastAppliedRevision = -1
  private credentialHealthRevision = -1
  private credentialHealth = new Map<string, ProjectedCredentialHealth>()
  /** Plaintext is origin-process memory only; the transaction authority is durable. */
  private preparedCredentialSecrets = new Map<string, PreparedCredentialSecret>()
  private preparedCredentialSecretTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private credentialRecoveryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly registryInstanceId = randomUUID()

  constructor(private readonly options: {
    dataDir: string
    credentials: ExtensionCredentialStore
    modelCapabilities?: (
      model: string,
      profile?: Pick<ModelConnectionProfile, 'id' | 'presetSource' | 'baseUrl' | 'kind'>
    ) => ModelCapabilityMetadata
    onChanged?: (connections: MaterializedModelConnections) => Promise<void> | void
    retireLegacyCredentialSource?: (sourceId: string) => Promise<void>
    inspectCredentialSource?: (sourceId: string) => Promise<ModelConnectionCredentialStatus>
    credentialFenceTtlMs?: number
    nowMs?: () => number
    isProcessAlive?: (pid: number) => boolean
    beforeCredentialFenceInstall?: (providerId: string) => Promise<void>
    afterCredentialCommitRecord?: (providerId: string) => Promise<void>
    afterCredentialCommitWrite?: (providerId: string) => Promise<void>
    afterCredentialConnectWrite?: (providerId: string) => Promise<void>
    resolveCredentialSource?: (sourceId: string) => Promise<{
      apiKey: string
      headers?: Record<string, string>
    }>
  }) {
    const registryPath = join(options.dataDir, 'model-connections.v1.json')
    assertManagerAtomicJsonPath(registryPath)
    this.file = new AtomicJsonFile(
      registryPath,
      (value) => RegistryDocumentSchema.parse(value)
    )
  }

  async initialize(
    seed: readonly ModelConnectionSeed[] = [],
    globals?: {
      proxy?: RegistryDocument['proxy']
      routePools?: RegistryDocument['routePools']
      localModelGateway?: RegistryDocument['localModelGateway']
    }
  ): Promise<ModelConnectionSnapshot> {
    let current = await this.file.read(emptyDocument)
    await this.recoverExpiredCredentialTransactions(current)
    await this.drainCredentialRefCleanup()
    current = await this.file.read(emptyDocument)
    const newRegistry = Object.keys(current.profiles).length === 0 &&
      Object.keys(current.tombstones).length === 0
    if (seed.length > 0) {
      for (const input of seed) {
        const credentialSourceId = input.credentialSourceId?.trim() || undefined
        const { credentialSourceId: _credentialSourceId, ...publicInput } = input
        const request = ModelConnectionConnectRequestSchema.parse({
          ...publicInput,
          expectedRevision: current.revision,
          probe: false
        })
        const existing = request.id ? current.profiles[request.id] : undefined
        if (!existing) {
          const requestedId = normalizeProviderId(request.id ?? request.name)
          if (current.tombstones[requestedId]) {
            // Durable deletion intent is authoritative over stale AppSettings
            // seeds across GUI/Runtime restarts. Only an explicit connect API
            // may clear this tombstone and re-add the same id.
            continue
          }
          // A non-empty registry is authoritative for the current default, but
          // GUI-managed providers that were never imported must still become
          // visible to standalone TUI clients.
          await this.connectInternal(
            { ...request, select: newRegistry ? request.select : false },
            credentialSourceId,
            request.kind === 'antigravity-cli' || request.kind === 'gemini-cli-api'
          )
        } else {
          const reconciled = reconcileSeedProfile(existing, request)
          if (!sameStoredProfile(existing, reconciled)) {
            current = await this.file.update(emptyDocument, (document) => {
              assertRevision(
                document,
                current.revision,
                this.options.modelCapabilities,
                this.credentialHealth
              )
              const profile = requireProfile(document, existing.id)
              const nextProfile = reconcileSeedProfile(profile, request)
              return {
                ...document,
                revision: document.revision + 1,
                profiles: {
                  ...document.profiles,
                  [existing.id]: nextProfile
                },
                ...(document.defaultProviderId === existing.id && nextProfile.selectedModel
                  ? { defaultModel: nextProfile.selectedModel }
                  : {})
              }
            })
            await this.changed(current)
          }
          current = await this.file.read(emptyDocument)
          if (!current.profiles[existing.id]?.configured && request.credential?.trim()) {
            await this.replaceCredential(existing.id, {
              expectedRevision: current.revision,
              credential: request.credential
            })
          }
        }
        current = await this.file.read(emptyDocument)
      }
    }
    if (newRegistry && globals) {
      current = await this.file.update(emptyDocument, (document) => ({
        ...document,
        revision: document.revision + 1,
        proxy: globals.proxy ?? document.proxy,
        routePools: globals.routePools ?? document.routePools,
        localModelGateway: globals.localModelGateway ?? document.localModelGateway
      }))
    }
    await this.retryLegacyCredentialSourceRetirements()
    await this.applyLatest()
    this.scheduleCredentialRecoveries(await this.file.read(emptyDocument))
    return this.snapshot()
  }

  async snapshot(): Promise<ModelConnectionSnapshot> {
    return this.projectWithCredentialHealth(await this.file.read(emptyDocument))
  }

  async assertRevision(expectedRevision: number): Promise<void> {
    assertRevision(
      await this.file.read(emptyDocument),
      expectedRevision,
      this.options.modelCapabilities,
      this.credentialHealth
    )
  }

  subscribe(listener: (snapshot: ModelConnectionSnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async waitForRevision(
    sinceRevision: number,
    signal: AbortSignal,
    timeoutMs: number
  ): Promise<ModelConnectionSnapshot> {
    const initial = await this.snapshot()
    if (initial.revision > sinceRevision || signal.aborted || timeoutMs <= 0) return initial
    return new Promise((resolve) => {
      let settled = false
      let unsubscribe: (() => void) | undefined
      const finish = (snapshot: ModelConnectionSnapshot): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal.removeEventListener('abort', aborted)
        unsubscribe?.()
        resolve(snapshot)
      }
      const readLatest = (): void => { void this.snapshot().then(finish, () => finish(initial)) }
      const aborted = (): void => readLatest()
      const timer = setTimeout(readLatest, timeoutMs)
      timer.unref?.()
      unsubscribe = this.subscribe((snapshot) => {
        if (snapshot.revision > sinceRevision) finish(snapshot)
      })
      signal.addEventListener('abort', aborted, { once: true })
      // Close the read/subscribe race if a writer committed between them.
      readLatestIfChanged(this, sinceRevision, finish)
    })
  }

  async connect(raw: unknown): Promise<ModelConnectionSnapshot> {
    return this.connectInternal(raw)
  }

  /**
   * Runtime-only authenticated upsert used after OAuth, SDK, or official CLI
   * verification. Unlike public connect(), a stable preset id is updated in
   * place so reconnecting never allocates a duplicate `-2` profile.
   */
  async connectAuthenticated(
    raw: AuthenticatedModelConnectionInput
  ): Promise<ModelConnectionSnapshot> {
    const {
      externalAuthVerified = false,
      ...connection
    } = raw
    const input = ModelConnectionConnectRequestSchema.parse({
      ...connection,
      probe: false
    })
    const requestedId = input.id?.trim()
    if (!requestedId) throw new Error('authenticated model connection id is required')
    const connectedId = normalizeProviderId(requestedId)
    if (input.kind === 'http' && !input.baseUrl) {
      throw new Error('baseUrl is required for HTTP providers')
    }
    const credential = input.credential?.trim() ?? ''
    if (!credential && !externalAuthVerified) {
      throw new Error('authenticated model connection credential is required')
    }
    const profileFor = (
      current: RegistryDocument,
      credentialRef: string | undefined,
      incarnationId: string
    ): StoredProfile => {
      const existing = current.profiles[connectedId]
      const deleted = current.tombstones[connectedId]
      const models = uniqueModels(input.models)
      const selectedModel = input.selectedModel ?? models[0]
      if (selectedModel && models.length > 0 && !models.includes(selectedModel)) {
        throw new Error('selected model is not present in the provider model list')
      }
      const legacyCredentialSourceToRetire = this.options.retireLegacyCredentialSource
        ? existing?.legacyCredentialSourceToRetire ??
          existing?.credentialSourceId ??
          deleted?.legacyCredentialSourceToRetire
        : undefined
      return StoredProfileSchema.parse({
        id: connectedId,
        accountId: existing?.accountId ?? `account:${connectedId}`,
        name: input.name,
        presetSource: input.presetSource,
        kind: input.kind,
        authType: input.authType,
        baseUrl: input.baseUrl,
        endpointFormat: input.endpointFormat,
        configured: true,
        incarnationId,
        credentialMutationHighWater:
          existing?.credentialMutationHighWater ?? deleted?.credentialMutationHighWater,
        models,
        ...(input.modelCapabilities
          ? { modelCapabilities: capabilitiesForModels(input.modelCapabilities, models) }
          : {}),
        selectedModel,
        credentialRef,
        credentialSourceId: credentialRef ? undefined : existing?.credentialSourceId,
        ...(legacyCredentialSourceToRetire ? { legacyCredentialSourceToRetire } : {}),
        headers: existing?.headers
      })
    }

    if (!credential) {
      const document = await this.file.update(emptyDocument, (current) => {
        assertRevision(current, input.expectedRevision, this.options.modelCapabilities, this.credentialHealth)
        if (current.credentialTransactions[connectedId]) {
          throw new ModelConnectionConflictError(this.project(current))
        }
        const existing = current.profiles[connectedId]
        const profile = profileFor(
          current,
          existing?.credentialRef,
          existing?.incarnationId ?? randomUUID()
        )
        const tombstones = { ...current.tombstones }
        delete tombstones[connectedId]
        return {
          ...current,
          revision: current.revision + 1,
          profiles: { ...current.profiles, [connectedId]: profile },
          tombstones,
          ...(input.select && profile.selectedModel ? {
            defaultProviderId: connectedId,
            defaultAccountId: profile.accountId,
            defaultModel: profile.selectedModel
          } : {})
        }
      })
      await this.changed(document)
      await this.retireLegacyCredentialSource(connectedId)
      return this.projectWithCredentialHealth(document)
    }

    const operationToken = `authenticated:${randomUUID()}`
    const nextRef = `cred_${randomUUID()}`
    let previousRef: string | undefined
    const committing = await this.file.update(emptyDocument, (current) => {
      assertRevision(current, input.expectedRevision, this.options.modelCapabilities, this.credentialHealth)
      if (current.credentialTransactions[connectedId]) {
        throw new ModelConnectionConflictError(this.project(current))
      }
      const existing = current.profiles[connectedId]
      const incarnationId = existing?.incarnationId ?? randomUUID()
      previousRef = existing?.credentialRef
      return {
        ...current,
        revision: current.revision + 1,
        profiles: existing && !existing.incarnationId
          ? { ...current.profiles, [connectedId]: { ...existing, incarnationId } }
          : current.profiles,
        credentialTransactions: {
          ...current.credentialTransactions,
          [connectedId]: {
            operationToken,
            clientId: randomUUID(),
            generation: 1,
            incarnationId,
            phase: 'committing',
            expiresAt: this.nowMs() + this.credentialFenceTtlMs(),
            previous: existing ? previousCredentialState(existing) : { configured: false },
            nextCredentialRef: nextRef,
            writerInstanceId: this.registryInstanceId,
            writerPid: process.pid
          }
        }
      }
    })
    this.scheduleCredentialRecovery(connectedId, committing.credentialTransactions[connectedId])
    try {
      await this.changed(committing)
      await this.options.credentials.set(nextRef, { apiKey: credential })
    } catch (error) {
      await this.abandonCredentialWrite(connectedId, operationToken, nextRef)
      throw error
    }
    let document: RegistryDocument
    try {
      document = await this.file.update(emptyDocument, (current) => {
        const transaction = current.credentialTransactions[connectedId]
        const existing = current.profiles[connectedId]
        if (
          transaction?.operationToken !== operationToken ||
          transaction.phase !== 'committing' ||
          transaction.nextCredentialRef !== nextRef ||
          (existing && existing.incarnationId !== transaction.incarnationId)
        ) {
          throw new ModelConnectionConflictError(this.project(current))
        }
        const profile = profileFor(current, nextRef, transaction.incarnationId)
        const credentialTransactions = { ...current.credentialTransactions }
        delete credentialTransactions[connectedId]
        const tombstones = { ...current.tombstones }
        delete tombstones[connectedId]
        return {
          ...current,
          revision: current.revision + 1,
          profiles: { ...current.profiles, [connectedId]: profile },
          tombstones,
          credentialTransactions,
          credentialRefCleanup: appendCredentialRefs(
            current.credentialRefCleanup,
            this.nowMs(),
            previousRef
          ),
          ...(input.select && profile.selectedModel ? {
            defaultProviderId: connectedId,
            defaultAccountId: profile.accountId,
            defaultModel: profile.selectedModel
          } : {})
        }
      })
    } catch (error) {
      await this.retireStaleCredentialWrite(nextRef)
      throw error
    }
    this.cancelCredentialRecoveryTimer(connectedId)
    await this.changed(document)
    await this.drainCredentialRefCleanup()
    await this.retireLegacyCredentialSource(connectedId)
    return this.projectWithCredentialHealth(document)
  }

  private async connectInternal(
    raw: unknown,
    credentialSourceId?: string,
    trustedExternalAuth = false
  ): Promise<ModelConnectionSnapshot> {
    const input = ModelConnectionConnectRequestSchema.parse(raw)
    if (input.kind === 'http' && !input.baseUrl) throw new Error('baseUrl is required for HTTP providers')
    const models = input.probe && input.kind === 'http'
      ? await this.probeInput(input)
      : uniqueModels(input.models)
    const usesRequestTimeCredential = input.kind === 'http' && Boolean(credentialSourceId)
    const credential = usesRequestTimeCredential ? '' : input.credential?.trim() ?? ''
    const selectedModel = input.selectedModel ?? models[0]
    if (selectedModel && models.length > 0 && !models.includes(selectedModel)) {
      throw new Error('selected model is not present in the provider model list')
    }
    let connectedId = ''

    if (credential) {
      const nextRef = `cred_${randomUUID()}`
      const operationToken = `connect:${randomUUID()}`
      const clientId = randomUUID()
      let incarnationId = ''
      const reserved = await this.file.update(emptyDocument, (current) => {
        assertRevision(current, input.expectedRevision, this.options.modelCapabilities, this.credentialHealth)
        connectedId = allocateId(current, input.id ?? input.name)
        incarnationId = randomUUID()
        return {
          ...current,
          revision: current.revision + 1,
          credentialTransactions: {
            ...current.credentialTransactions,
            [connectedId]: {
              operationToken,
              clientId,
              generation: 1,
              incarnationId,
              phase: 'committing',
              expiresAt: this.nowMs() + this.credentialFenceTtlMs(),
              previous: { configured: false },
              nextCredentialRef: nextRef,
              writerInstanceId: this.registryInstanceId,
              writerPid: process.pid
            }
          },
          credentialRefCleanup: appendCredentialRefs(
            current.credentialRefCleanup,
            this.nowMs(),
            nextRef,
            this.registryInstanceId,
            process.pid
          )
        }
      })
      this.scheduleCredentialRecovery(connectedId, reserved.credentialTransactions[connectedId])
      try {
        await this.options.credentials.set(nextRef, { apiKey: credential })
        await this.options.afterCredentialConnectWrite?.(connectedId)
      } catch (error) {
        await this.abandonCredentialWrite(connectedId, operationToken, nextRef)
        throw error
      }
      let document: RegistryDocument
      try {
        document = await this.file.update(emptyDocument, (current) => {
          const transaction = current.credentialTransactions[connectedId]
          if (
            transaction?.operationToken !== operationToken ||
            transaction.phase !== 'committing' ||
            transaction.nextCredentialRef !== nextRef ||
            transaction.incarnationId !== incarnationId ||
            current.profiles[connectedId]
          ) {
            throw new ModelConnectionConflictError(this.project(current))
          }
          const deleted = current.tombstones[connectedId]
          const accountId = `account:${connectedId}`
          const profile = StoredProfileSchema.parse({
            id: connectedId,
            accountId,
            name: input.name,
            presetSource: input.presetSource,
            kind: input.kind,
            authType: input.authType,
            baseUrl: input.baseUrl,
            endpointFormat: input.endpointFormat,
            configured: true,
            incarnationId,
            credentialMutationHighWater: deleted?.credentialMutationHighWater,
            models,
            ...(input.modelCapabilities
              ? { modelCapabilities: capabilitiesForModels(input.modelCapabilities, models) }
              : {}),
            selectedModel,
            credentialRef: nextRef,
            ...(deleted?.legacyCredentialSourceToRetire && this.options.retireLegacyCredentialSource
              ? { legacyCredentialSourceToRetire: deleted.legacyCredentialSourceToRetire }
              : {})
          })
          const credentialTransactions = { ...current.credentialTransactions }
          delete credentialTransactions[connectedId]
          const credentialRefCleanup = { ...current.credentialRefCleanup }
          delete credentialRefCleanup[nextRef]
          const tombstones = { ...current.tombstones }
          delete tombstones[connectedId]
          return {
            ...current,
            revision: current.revision + 1,
            profiles: { ...current.profiles, [connectedId]: profile },
            tombstones,
            credentialTransactions,
            credentialRefCleanup,
            ...(input.select && selectedModel ? {
              defaultProviderId: connectedId,
              defaultAccountId: accountId,
              defaultModel: selectedModel
            } : {})
          }
        })
      } catch (error) {
        await this.abandonCredentialWrite(connectedId, operationToken, nextRef)
        throw error
      }
      this.cancelCredentialRecoveryTimer(connectedId)
      await this.changed(document)
      await this.drainCredentialRefCleanup()
      await this.retireLegacyCredentialSource(connectedId)
      return this.projectWithCredentialHealth(document)
    }

    const document = await this.file.update(emptyDocument, (current) => {
      assertRevision(current, input.expectedRevision, this.options.modelCapabilities, this.credentialHealth)
      const id = allocateId(current, input.id ?? input.name)
      connectedId = id
      const deleted = current.tombstones[id]
      const accountId = `account:${id}`
      const configured = Boolean(credentialSourceId) ||
        input.kind === 'agent-sdk' ||
        trustedExternalAuth
      const profile = StoredProfileSchema.parse({
        id,
        accountId,
        name: input.name,
        presetSource: input.presetSource,
        kind: input.kind,
        authType: input.authType,
        baseUrl: input.baseUrl,
        endpointFormat: input.endpointFormat,
        configured,
        incarnationId: randomUUID(),
        credentialMutationHighWater: deleted?.credentialMutationHighWater,
        models,
        ...(input.modelCapabilities
          ? { modelCapabilities: capabilitiesForModels(input.modelCapabilities, models) }
          : {}),
        selectedModel,
        credentialSourceId,
        ...(deleted?.legacyCredentialSourceToRetire && this.options.retireLegacyCredentialSource
          ? { legacyCredentialSourceToRetire: deleted.legacyCredentialSourceToRetire }
          : {})
      })
      const tombstones = { ...current.tombstones }
      delete tombstones[id]
      return {
        ...current,
        revision: current.revision + 1,
        profiles: { ...current.profiles, [id]: profile },
        tombstones,
        ...(input.select && configured && selectedModel ? {
          defaultProviderId: id,
          defaultAccountId: accountId,
          defaultModel: selectedModel
        } : {})
      }
    })
    await this.changed(document)
    if (document.profiles[connectedId]) await this.retireLegacyCredentialSource(connectedId)
    return this.projectWithCredentialHealth(document)
  }

  async patch(providerId: string, raw: unknown): Promise<ModelConnectionSnapshot> {
    const input = ModelConnectionPatchRequestSchema.parse(raw)
    const { expectedRevision: _expectedRevision, ...changes } = input
    const document = await this.file.update(emptyDocument, (current) => {
      assertRevision(current, input.expectedRevision, this.options.modelCapabilities, this.credentialHealth)
      const profile = requireProfile(current, providerId)
      if (current.credentialTransactions[providerId]) {
        throw new ModelConnectionConflictError(this.project(current))
      }
      const kind = input.kind ?? profile.kind
      const baseUrl = input.baseUrl ?? profile.baseUrl
      if (kind === 'http' && !baseUrl) throw new Error('baseUrl is required for HTTP providers')
      const models = input.models ? uniqueModels(input.models) : profile.models
      const modelCapabilities = input.modelCapabilities
        ? capabilitiesForModels(input.modelCapabilities, models)
        : profile.modelCapabilities
          ? capabilitiesForModels(profile.modelCapabilities, models)
          : undefined
      const selectedModel = input.selectedModel ?? profile.selectedModel
      if (selectedModel && models.length > 0 && !models.includes(selectedModel)) {
        throw new Error('selected model is not present in the provider model list')
      }
      return {
        ...current,
        revision: current.revision + 1,
        profiles: {
          ...current.profiles,
          [providerId]: StoredProfileSchema.parse({
            ...profile,
            ...changes,
            models,
            ...(modelCapabilities ? { modelCapabilities } : {}),
            selectedModel
          })
        },
        ...(current.defaultProviderId === providerId && selectedModel ? { defaultModel: selectedModel } : {})
      }
    })
    await this.changed(document)
    return this.projectWithCredentialHealth(document)
  }

  /**
   * Installs a secret-free fence in the Manager-owned Registry document. The
   * client id/generation high-water survives a successful commit, so a delayed
   * request from an older renderer generation cannot re-fence the final key.
   */
  async fenceCredential(providerId: string, raw: unknown): Promise<ModelConnectionSnapshot> {
    const input = ModelConnectionCredentialFenceRequestSchema.parse(raw)
    const token = parseCredentialOperationToken(input.operationToken)
    await this.options.beforeCredentialFenceInstall?.(providerId)
    let supersededToken: string | undefined
    const document = await this.file.update(emptyDocument, (current) => {
      const profile = requireProfile(current, providerId)
      const active = current.credentialTransactions[providerId]
      if (
        active?.operationToken === input.operationToken &&
        active.incarnationId === profile.incarnationId
      ) return current
      assertRevision(current, input.expectedRevision, this.options.modelCapabilities, this.credentialHealth)
      if (active?.phase === 'recovering') {
        throw new ModelConnectionConflictError(this.project(current))
      }
      const incarnationId = profile.incarnationId ?? randomUUID()
      const highWater = profile.credentialMutationHighWater?.[token.clientId] ?? 0
      if (token.generation <= highWater) {
        throw new ModelConnectionConflictError(this.project(current))
      }
      supersededToken = active?.operationToken
      const credentialTransactions = { ...current.credentialTransactions }
      credentialTransactions[providerId] = {
        operationToken: input.operationToken,
        clientId: token.clientId,
        generation: token.generation,
        incarnationId,
        phase: 'fenced',
        expiresAt: this.nowMs() + this.credentialFenceTtlMs(),
        previous: previousCredentialState(profile)
      }
      return {
        ...current,
        revision: current.revision + 1,
        profiles: {
          ...current.profiles,
          [providerId]: {
            ...profile,
            incarnationId,
            credentialMutationHighWater: boundedCredentialHighWater(
              profile.credentialMutationHighWater,
              token.clientId,
              token.generation
            )
          }
        },
        credentialTransactions,
        credentialRefCleanup: appendCredentialRefs(
          current.credentialRefCleanup,
          this.nowMs(),
          active?.nextCredentialRef,
          active?.writerInstanceId,
          active?.writerPid
        )
      }
    })
    const local = this.preparedCredentialSecrets.get(providerId)
    if (local && local.operationToken !== input.operationToken) {
      this.clearPreparedCredentialSecret(providerId, local.operationToken)
    }
    if (supersededToken && supersededToken !== input.operationToken) {
      this.cancelCredentialRecoveryTimer(providerId)
    }
    this.scheduleCredentialRecovery(providerId, document.credentialTransactions[providerId])
    await this.changed(document)
    await this.drainCredentialRefCleanup()
    return this.projectWithCredentialHealth(await this.file.read(emptyDocument))
  }

  /**
   * Stages a protected credential behind a provider-scoped fence. A prepared
   * value is deliberately absent from the durable Registry document and all
   * credential consumers fail closed until the matching operation token is
   * committed. A prepare without its previously admitted fence is rejected.
   */
  async prepareCredential(providerId: string, raw: unknown): Promise<ModelConnectionSnapshot> {
    const input = ModelConnectionCredentialPrepareRequestSchema.parse(raw)
    let incarnationId = ''
    const document = await this.file.update(emptyDocument, (current) => {
      assertRevision(current, input.expectedRevision, this.options.modelCapabilities, this.credentialHealth)
      const profile = requireProfile(current, providerId)
      const transaction = requireCredentialTransaction(current, providerId, input.operationToken)
      if (!profile.incarnationId || transaction.incarnationId !== profile.incarnationId) {
        throw new ModelConnectionConflictError(this.project(current))
      }
      incarnationId = transaction.incarnationId
      return {
        ...current,
        revision: current.revision + 1,
        credentialTransactions: {
          ...current.credentialTransactions,
          [providerId]: {
            ...transaction,
            phase: 'prepared',
            expiresAt: this.nowMs() + this.credentialFenceTtlMs()
          }
        }
      }
    })
    const latest = await this.file.read(emptyDocument)
    const latestTransaction = latest.credentialTransactions[providerId]
    if (
      latestTransaction?.operationToken !== input.operationToken ||
      latestTransaction.incarnationId !== incarnationId ||
      latestTransaction.phase !== 'prepared'
    ) {
      throw new ModelConnectionConflictError(await this.projectWithCredentialHealth(latest))
    }
    this.clearPreparedCredentialSecret(providerId)
    this.preparedCredentialSecrets.set(providerId, {
      operationToken: input.operationToken,
      incarnationId,
      credential: input.credential.trim()
    })
    this.schedulePreparedCredentialSecretExpiry(
      providerId,
      input.operationToken,
      latestTransaction.expiresAt
    )
    this.scheduleCredentialRecovery(providerId, latestTransaction)
    await this.changed(document)
    return this.projectWithCredentialHealth(await this.file.read(emptyDocument))
  }

  /** Commits only the latest prepared token for this provider. */
  async commitPreparedCredential(providerId: string, raw: unknown): Promise<ModelConnectionSnapshot> {
    const input = ModelConnectionCredentialCommitRequestSchema.parse(raw)
    const pending = this.preparedCredentialSecrets.get(providerId)
    if (!pending || pending.operationToken !== input.operationToken) {
      throw new ModelConnectionConflictError(await this.snapshot())
    }
    const nextRef = `cred_${randomUUID()}`
    let previousRef: string | undefined
    let legacyCredentialSourceToRetire: string | undefined
    const committing = await this.file.update(emptyDocument, (current) => {
      assertRevision(current, input.expectedRevision, this.options.modelCapabilities, this.credentialHealth)
      const transaction = requireCredentialTransaction(current, providerId, input.operationToken)
      const profile = requireProfile(current, providerId)
      if (
        transaction.phase !== 'prepared' ||
        transaction.incarnationId !== profile.incarnationId ||
        transaction.incarnationId !== pending.incarnationId
      ) {
        throw new ModelConnectionConflictError(this.project(current))
      }
      previousRef = profile.credentialRef
      legacyCredentialSourceToRetire = this.options.retireLegacyCredentialSource
        ? profile.legacyCredentialSourceToRetire ?? profile.credentialSourceId
        : undefined
      return {
        ...current,
        revision: current.revision + 1,
        credentialTransactions: {
          ...current.credentialTransactions,
          [providerId]: {
            ...transaction,
            phase: 'committing',
            expiresAt: this.nowMs() + this.credentialFenceTtlMs(),
            nextCredentialRef: nextRef,
            writerInstanceId: this.registryInstanceId,
            writerPid: process.pid
          }
        }
      }
    })
    this.scheduleCredentialRecovery(providerId, committing.credentialTransactions[providerId])
    try {
      await this.changed(committing)
      await this.options.afterCredentialCommitRecord?.(providerId)
      await this.options.credentials.set(nextRef, { apiKey: pending.credential })
    } catch (error) {
      await this.abandonCredentialWrite(providerId, input.operationToken, nextRef)
      throw error
    }
    await this.options.afterCredentialCommitWrite?.(providerId)
    let document: RegistryDocument
    try {
      document = await this.file.update(emptyDocument, (current) => {
        const transaction = requireCredentialTransaction(current, providerId, input.operationToken)
        const profile = requireProfile(current, providerId)
        if (
          transaction.phase !== 'committing' ||
          transaction.nextCredentialRef !== nextRef ||
          transaction.incarnationId !== profile.incarnationId ||
          transaction.incarnationId !== pending.incarnationId
        ) {
          throw new ModelConnectionConflictError(this.project(current))
        }
        const credentialTransactions = { ...current.credentialTransactions }
        delete credentialTransactions[providerId]
        return {
          ...current,
          revision: current.revision + 1,
          profiles: {
            ...current.profiles,
            [providerId]: {
              ...profile,
              credentialRef: nextRef,
              credentialSourceId: undefined,
              ...(legacyCredentialSourceToRetire
                ? { legacyCredentialSourceToRetire }
                : {}),
              configured: true
            }
          },
          credentialTransactions,
          credentialRefCleanup: appendCredentialRefs(
            current.credentialRefCleanup,
            this.nowMs(),
            previousRef
          )
        }
      })
    } catch (error) {
      await this.retireStaleCredentialWrite(nextRef)
      throw error
    } finally {
      this.clearPreparedCredentialSecret(providerId, input.operationToken)
    }
    this.cancelCredentialRecoveryTimer(providerId)
    await this.changed(document)
    await this.drainCredentialRefCleanup()
    await this.retireLegacyCredentialSource(providerId)
    return this.projectWithCredentialHealth(await this.file.read(emptyDocument))
  }

  async replaceCredential(providerId: string, raw: unknown): Promise<ModelConnectionSnapshot> {
    const input = ModelConnectionCredentialRequestSchema.parse(raw)
    const nextRef = `cred_${randomUUID()}`
    const operationToken = `replace:${randomUUID()}`
    let previousRef: string | undefined
    let legacyCredentialSourceToRetire: string | undefined
    const committing = await this.file.update(emptyDocument, (current) => {
      assertRevision(current, input.expectedRevision, this.options.modelCapabilities, this.credentialHealth)
      if (current.credentialTransactions[providerId]) {
        throw new ModelConnectionConflictError(this.project(current))
      }
      const profile = requireProfile(current, providerId)
      const incarnationId = profile.incarnationId ?? randomUUID()
      previousRef = profile.credentialRef
      legacyCredentialSourceToRetire = this.options.retireLegacyCredentialSource
        ? profile.legacyCredentialSourceToRetire ?? profile.credentialSourceId
        : undefined
      return {
        ...current,
        revision: current.revision + 1,
        profiles: profile.incarnationId
          ? current.profiles
          : { ...current.profiles, [providerId]: { ...profile, incarnationId } },
        credentialTransactions: {
          ...current.credentialTransactions,
          [providerId]: {
            operationToken,
            clientId: randomUUID(),
            generation: 1,
            incarnationId,
            phase: 'committing',
            expiresAt: this.nowMs() + this.credentialFenceTtlMs(),
            previous: previousCredentialState(profile),
            nextCredentialRef: nextRef,
            writerInstanceId: this.registryInstanceId,
            writerPid: process.pid
          }
        }
      }
    })
    this.scheduleCredentialRecovery(providerId, committing.credentialTransactions[providerId])
    try {
      await this.changed(committing)
      await this.options.credentials.set(nextRef, { apiKey: input.credential.trim() })
    } catch (error) {
      await this.abandonCredentialWrite(providerId, operationToken, nextRef)
      throw error
    }
    let document: RegistryDocument
    try {
      document = await this.file.update(emptyDocument, (current) => {
        const transaction = current.credentialTransactions[providerId]
        const profile = current.profiles[providerId]
        if (
          transaction?.operationToken !== operationToken ||
          transaction.phase !== 'committing' ||
          transaction.nextCredentialRef !== nextRef ||
          !profile ||
          profile.incarnationId !== transaction.incarnationId
        ) {
          throw new ModelConnectionConflictError(this.project(current))
        }
        const credentialTransactions = { ...current.credentialTransactions }
        delete credentialTransactions[providerId]
        return {
          ...current,
          revision: current.revision + 1,
          profiles: {
            ...current.profiles,
            [providerId]: {
              ...profile,
              credentialRef: nextRef,
              credentialSourceId: undefined,
              ...(legacyCredentialSourceToRetire
                ? { legacyCredentialSourceToRetire }
                : {}),
              configured: true
            }
          },
          credentialTransactions,
          credentialRefCleanup: appendCredentialRefs(
            current.credentialRefCleanup,
            this.nowMs(),
            previousRef
          )
        }
      })
    } catch (error) {
      await this.retireStaleCredentialWrite(nextRef)
      throw error
    }
    this.cancelCredentialRecoveryTimer(providerId)
    await this.changed(document)
    await this.drainCredentialRefCleanup()
    await this.retireLegacyCredentialSource(providerId)
    return this.projectWithCredentialHealth(await this.file.read(emptyDocument))
  }

  async clearCredential(
    providerId: string,
    expectedRevision: number
  ): Promise<ModelConnectionSnapshot> {
    let previousRef: string | undefined
    let legacyCredentialSourceToRetire: string | undefined
    let cancelledTransactionToken: string | undefined
    const document = await this.file.update(emptyDocument, (current) => {
      assertRevision(current, expectedRevision, this.options.modelCapabilities, this.credentialHealth)
      const profile = requireProfile(current, providerId)
      previousRef = profile.credentialRef
      legacyCredentialSourceToRetire = this.options.retireLegacyCredentialSource
        ? profile.legacyCredentialSourceToRetire ?? profile.credentialSourceId
        : undefined
      const transaction = current.credentialTransactions[providerId]
      if (transaction?.phase === 'recovering') {
        throw new ModelConnectionConflictError(this.project(current))
      }
      cancelledTransactionToken = transaction?.operationToken
      const credentialTransactions = { ...current.credentialTransactions }
      delete credentialTransactions[providerId]
      const configured =
        profile.kind === 'agent-sdk' ||
        profile.kind === 'antigravity-cli' ||
        profile.kind === 'cursor-sdk'
      const profiles = {
        ...current.profiles,
        [providerId]: {
          ...profile,
          credentialRef: undefined,
          credentialSourceId: undefined,
          ...(legacyCredentialSourceToRetire ? { legacyCredentialSourceToRetire } : {}),
          configured
        }
      }
      const fallback = !configured && current.defaultProviderId === providerId
        ? configuredFallback(Object.values(profiles).filter((candidate) => candidate.id !== providerId))
        : undefined
      return {
        schemaVersion: 1,
        revision: current.revision + 1,
        profiles,
        tombstones: current.tombstones,
        credentialTransactions,
        credentialRefCleanup: appendCredentialRefs(
          appendCredentialRefs(current.credentialRefCleanup, this.nowMs(), previousRef),
          this.nowMs(),
          transaction?.nextCredentialRef,
          transaction?.writerInstanceId,
          transaction?.writerPid
        ),
        proxy: current.proxy,
        routePools: current.routePools,
        localModelGateway: current.localModelGateway,
        ...(!configured && current.defaultProviderId === providerId
          ? fallback ? {
              defaultProviderId: fallback.profile.id,
              defaultAccountId: fallback.profile.accountId,
              defaultModel: fallback.model
            } : {}
          : {
              defaultProviderId: current.defaultProviderId,
              defaultAccountId: current.defaultAccountId,
              defaultModel: current.defaultModel
            })
      }
    })
    this.clearPreparedCredentialSecret(providerId, cancelledTransactionToken)
    this.cancelCredentialRecoveryTimer(providerId)
    await this.changed(document)
    await this.drainCredentialRefCleanup()
    await this.retireLegacyCredentialSource(providerId)
    return this.projectWithCredentialHealth(await this.file.read(emptyDocument))
  }

  async delete(providerId: string, expectedRevision: number): Promise<ModelConnectionSnapshot> {
    let credentialRef: string | undefined
    let legacyCredentialSourceToRetire: string | undefined
    let cancelledTransactionToken: string | undefined
    const document = await this.file.update(emptyDocument, (current) => {
      assertRevision(current, expectedRevision, this.options.modelCapabilities, this.credentialHealth)
      const profile = requireProfile(current, providerId)
      credentialRef = profile.credentialRef
      legacyCredentialSourceToRetire = this.options.retireLegacyCredentialSource
        ? profile.legacyCredentialSourceToRetire ?? profile.credentialSourceId
        : undefined
      const transaction = current.credentialTransactions[providerId]
      if (transaction?.phase === 'recovering') {
        throw new ModelConnectionConflictError(this.project(current))
      }
      cancelledTransactionToken = transaction?.operationToken
      const credentialTransactions = { ...current.credentialTransactions }
      delete credentialTransactions[providerId]
      const profiles = { ...current.profiles }
      delete profiles[providerId]
      const fallback = configuredFallback(Object.values(profiles))
      return {
        schemaVersion: 1,
        revision: current.revision + 1,
        profiles,
        tombstones: {
          ...current.tombstones,
          [providerId]: {
            deletedRevision: current.revision + 1,
            credentialMutationHighWater: profile.credentialMutationHighWater,
            ...(legacyCredentialSourceToRetire ? { legacyCredentialSourceToRetire } : {})
          }
        },
        credentialTransactions,
        credentialRefCleanup: appendCredentialRefs(
          appendCredentialRefs(current.credentialRefCleanup, this.nowMs(), credentialRef),
          this.nowMs(),
          transaction?.nextCredentialRef,
          transaction?.writerInstanceId,
          transaction?.writerPid
        ),
        proxy: current.proxy,
        routePools: current.routePools,
        localModelGateway: current.localModelGateway,
        ...(current.defaultProviderId === providerId
          ? fallback ? {
              defaultProviderId: fallback.profile.id,
              defaultAccountId: fallback.profile.accountId,
              defaultModel: fallback.model
            } : {}
          : {
              defaultProviderId: current.defaultProviderId,
              defaultAccountId: current.defaultAccountId,
              defaultModel: current.defaultModel
            })
      }
    })
    this.clearPreparedCredentialSecret(providerId, cancelledTransactionToken)
    this.cancelCredentialRecoveryTimer(providerId)
    await this.changed(document)
    await this.drainCredentialRefCleanup()
    await this.retireDeletedLegacyCredentialSource(providerId)
    return this.projectWithCredentialHealth(await this.file.read(emptyDocument))
  }

  async select(raw: unknown): Promise<ModelConnectionSnapshot> {
    const input = ModelConnectionSelectRequestSchema.parse(raw)
    const document = await this.file.update(emptyDocument, (current) => {
      assertRevision(current, input.expectedRevision, this.options.modelCapabilities, this.credentialHealth)
      const profile = requireProfile(current, input.providerId)
      if (current.credentialTransactions[profile.id]) {
        throw new Error('provider credential replacement is pending')
      }
      if (!profile.configured) throw new Error('provider is not connected')
      if (input.accountId && input.accountId !== profile.accountId) {
        throw new Error('account does not belong to the selected provider')
      }
      if (profile.models.length > 0 && !profile.models.includes(input.model)) {
        throw new Error('model is not available for this provider')
      }
      const updated = { ...profile, selectedModel: input.model }
      return {
        ...current,
        revision: current.revision + 1,
        profiles: { ...current.profiles, [profile.id]: updated },
        defaultProviderId: profile.id,
        defaultAccountId: input.accountId ?? profile.accountId,
        defaultModel: input.model
      }
    })
    await this.changed(document)
    return this.projectWithCredentialHealth(document)
  }

  /**
   * Reconcile an explicit, authenticated configuration selection after its
   * provider catalog has been imported. Ordinary initialize() calls do not use
   * this path, so a daemon restart cannot replace a newer registry selection
   * with a stale config.json value.
   */
  async synchronizeDefaultSelection(raw: {
    providerId: string
    accountId?: string
    model: string
  }): Promise<ModelConnectionSnapshot> {
    const input = ModelConnectionSelectRequestSchema
      .omit({ expectedRevision: true })
      .parse(raw)
    let changed = false
    const document = await this.file.update(emptyDocument, (current) => {
      const profile = requireProfile(current, input.providerId)
      if (current.credentialTransactions[profile.id]) {
        throw new Error('provider credential replacement is pending')
      }
      if (!profile.configured) throw new Error('provider is not connected')
      if (input.accountId && input.accountId !== profile.accountId) {
        throw new Error('account does not belong to the selected provider')
      }
      if (profile.models.length > 0 && !profile.models.includes(input.model)) {
        throw new Error('model is not available for this provider')
      }
      const accountId = input.accountId ?? profile.accountId
      if (
        current.defaultProviderId === profile.id &&
        current.defaultAccountId === accountId &&
        current.defaultModel === input.model &&
        profile.selectedModel === input.model
      ) {
        return current
      }
      changed = true
      return {
        ...current,
        revision: current.revision + 1,
        profiles: {
          ...current.profiles,
          [profile.id]: { ...profile, selectedModel: input.model }
        },
        defaultProviderId: profile.id,
        defaultAccountId: accountId,
        defaultModel: input.model
      }
    })
    if (changed) await this.changed(document)
    return this.projectWithCredentialHealth(document)
  }

  async updateGlobals(raw: unknown): Promise<ModelConnectionSnapshot> {
    const input = ModelConnectionGlobalsRequestSchema.parse(raw)
    const document = await this.file.update(emptyDocument, (current) => {
      assertRevision(current, input.expectedRevision, this.options.modelCapabilities, this.credentialHealth)
      return {
        ...current,
        revision: current.revision + 1,
        proxy: input.proxy,
        routePools: input.routePools,
        localModelGateway: input.localModelGateway
      }
    })
    await this.changed(document)
    return this.projectWithCredentialHealth(document)
  }

  async probe(providerId: string): Promise<{ ok: true; models: string[] }> {
    const document = await this.readDocumentForCredentialConsumer(providerId)
    if (document.credentialTransactions[providerId]) {
      throw new Error('provider credential replacement is pending')
    }
    const profile = requireProfile(document, providerId)
    const credential = profile.credentialRef
      ? await this.options.credentials.get(profile.credentialRef)
      : null
    const credentialSourceId = profile.credentialRef
      ? modelConnectionCredentialSourceId(profile.id)
      : profile.credentialSourceId
    const resolved = credentialSourceId && this.options.resolveCredentialSource
      ? await this.options.resolveCredentialSource(credentialSourceId)
      : materializeLegacyProviderCredential(credential?.apiKey ?? '')
    const models = await probeModels({
      kind: profile.kind,
      baseUrl: profile.baseUrl,
      endpointFormat: profile.endpointFormat,
      apiKey: resolved.apiKey,
      headers: { ...(profile.headers ?? {}), ...(resolved.headers ?? {}) },
      fallbackModels: profile.models,
      proxyUrl: document.proxy.enabled ? document.proxy.url : ''
    })
    return { ok: true, models }
  }

  /**
   * Internal compatibility hook for rolling-upgrade clients. The returned
   * material must only be copied into Kun's protected account store and must
   * never cross HTTP, logs, ordinary settings, or terminal output.
   */
  async credentialForCompatibility(providerId: string): Promise<string | null> {
    const document = await this.readDocumentForCredentialConsumer(providerId)
    if (document.credentialTransactions[providerId]) return null
    const profile = requireProfile(document, providerId)
    if (!profile.credentialRef) return null
    const credential = await this.options.credentials.get(profile.credentialRef)
    return credential?.apiKey?.trim() || null
  }

  /**
   * Main-only bridge for request paths that have not moved into Kun yet. A
   * Registry profile without a credentialRef is authoritative unless it is
   * still explicitly bound to a legacy settings source. No HTTP route exposes
   * this result.
   */
  async credentialStateForInternalConsumer(providerId: string): Promise<{
    authoritative: boolean
    apiKey: string
  }> {
    const document = await this.readDocumentForCredentialConsumer(providerId)
    if (document.credentialTransactions[providerId]) {
      return { authoritative: true, apiKey: '' }
    }
    const profile = document.profiles[providerId]
    if (!profile || (!profile.credentialRef && profile.credentialSourceId)) {
      return { authoritative: false, apiKey: '' }
    }
    if (!profile.credentialRef) return { authoritative: true, apiKey: '' }
    let credential: Awaited<ReturnType<ExtensionCredentialStore['get']>> = null
    try {
      credential = await this.options.credentials.get(profile.credentialRef)
    } catch {
      // An unreadable credential must not break unrelated Main-process model
      // consumers. The public snapshot carries the safe per-provider status.
    }
    return { authoritative: true, apiKey: credential?.apiKey?.trim() ?? '' }
  }

  /** Resolves a Registry-owned protected credential for request-time refresh. */
  async resolveApiKey(sourceId: string): Promise<{ apiKey: string } | null> {
    const providerId = providerIdFromCredentialSource(sourceId)
    if (!providerId) return null
    const document = await this.readDocumentForCredentialConsumer(providerId)
    if (document.credentialTransactions[providerId]) return null
    const profile = document.profiles[providerId]
    if (!profile?.credentialRef) return null
    const credential = await this.options.credentials.get(profile.credentialRef)
    const apiKey = credential?.apiKey?.trim() ?? ''
    return apiKey ? { apiKey } : null
  }

  /** Atomically rotates a Registry-owned protected credential in place. */
  async updateResolvedApiKey(
    sourceId: string,
    expectedApiKey: string,
    apiKey: string
  ): Promise<boolean> {
    const providerId = providerIdFromCredentialSource(sourceId)
    const trimmed = apiKey.trim()
    if (!providerId || !trimmed) return false
    const initial = await this.readDocumentForCredentialConsumer(providerId)
    if (initial.credentialTransactions[providerId]) return false
    const initialProfile = initial.profiles[providerId]
    if (!initialProfile?.credentialRef || !initialProfile.incarnationId) return false
    const incarnationId = initialProfile.incarnationId
    const currentCredential = await this.options.credentials.get(initialProfile.credentialRef)
    if (currentCredential?.apiKey?.trim() !== expectedApiKey.trim()) return false

    const operationToken = `refresh:${randomUUID()}`
    const nextRef = `cred_${randomUUID()}`
    let previousRef: string | undefined
    let committing: RegistryDocument
    try {
      committing = await this.file.update(emptyDocument, (current) => {
        if (current.credentialTransactions[providerId]) {
          throw new ModelConnectionConflictError(this.project(current))
        }
        const profile = current.profiles[providerId]
        if (
          !profile?.credentialRef ||
          profile.credentialRef !== initialProfile.credentialRef ||
          profile.incarnationId !== incarnationId
        ) {
          throw new ModelConnectionConflictError(this.project(current))
        }
        previousRef = profile.credentialRef
        return {
          ...current,
          revision: current.revision + 1,
          credentialTransactions: {
            ...current.credentialTransactions,
            [providerId]: {
              operationToken,
              clientId: randomUUID(),
              generation: 1,
              incarnationId,
              phase: 'committing',
              expiresAt: this.nowMs() + this.credentialFenceTtlMs(),
              previous: previousCredentialState(profile),
              nextCredentialRef: nextRef,
              writerInstanceId: this.registryInstanceId,
              writerPid: process.pid
            }
          }
        }
      })
    } catch (error) {
      if (error instanceof ModelConnectionConflictError) return false
      throw error
    }
    this.scheduleCredentialRecovery(providerId, committing.credentialTransactions[providerId])
    try {
      await this.changed(committing)
      await this.options.credentials.set(nextRef, {
        ...currentCredential,
        apiKey: trimmed
      })
    } catch (error) {
      await this.abandonCredentialWrite(providerId, operationToken, nextRef)
      throw error
    }
    let finalized: RegistryDocument
    try {
      finalized = await this.file.update(emptyDocument, (current) => {
        const transaction = current.credentialTransactions[providerId]
        const profile = current.profiles[providerId]
        if (
          transaction?.operationToken !== operationToken ||
          transaction.phase !== 'committing' ||
          transaction.nextCredentialRef !== nextRef ||
          !profile ||
          profile.incarnationId !== incarnationId ||
          profile.credentialRef !== previousRef
        ) {
          throw new ModelConnectionConflictError(this.project(current))
        }
        const credentialTransactions = { ...current.credentialTransactions }
        delete credentialTransactions[providerId]
        return {
          ...current,
          revision: current.revision + 1,
          profiles: {
            ...current.profiles,
            [providerId]: { ...profile, credentialRef: nextRef }
          },
          credentialTransactions,
          credentialRefCleanup: appendCredentialRefs(
            current.credentialRefCleanup,
            this.nowMs(),
            previousRef
          )
        }
      })
    } catch (error) {
      await this.retireStaleCredentialWrite(nextRef)
      if (error instanceof ModelConnectionConflictError) return false
      throw error
    }
    this.cancelCredentialRecoveryTimer(providerId)
    await this.drainCredentialRefCleanup()
    // Keep live consumers monotonic without synchronously rebuilding the model
    // client that initiated this request-time OAuth refresh.
    void this.changed(finalized).catch(() => undefined)
    return true
  }

  async materialize(): Promise<MaterializedModelConnections> {
    const document = await this.file.read(emptyDocument)
    await this.recoverExpiredCredentialTransactions(document)
    return this.materializeDocument(await this.file.read(emptyDocument))
  }

  private async materializeDocument(
    document: RegistryDocument,
    recoveryProviderId?: string
  ): Promise<MaterializedModelConnections> {
    const providers = new Map<string, ServeProviderConfig>()
    let selected: MaterializedModelConnections['selected']
    for (const profile of Object.values(document.profiles)) {
      const credentialReplacementPending = Boolean(
        document.credentialTransactions[profile.id] && profile.id !== recoveryProviderId
      )
      let credential: Awaited<ReturnType<ExtensionCredentialStore['get']>> = null
      if (profile.credentialRef && !credentialReplacementPending) {
        try {
          credential = await this.options.credentials.get(profile.credentialRef)
        } catch {
          // Keep materializing the remaining providers. Request-time resolution
          // for this provider will fail closed until its credential is replaced.
        }
      }
      const material = materializeLegacyProviderCredential(credential?.apiKey ?? '')
      const credentialSourceId = credentialReplacementPending
        ? undefined
        : profile.credentialRef
          ? modelConnectionCredentialSourceId(profile.id)
          : profile.credentialSourceId
      // A managed source is authoritative and may already have rotated beyond
      // the Registry's pre-migration credential copy. Never expose that stale
      // copy as a fallback client key.
      const usesRequestTimeCredential = !credentialReplacementPending &&
        profile.kind === 'http' &&
        !profile.credentialRef &&
        Boolean(profile.credentialSourceId)
      const apiKey = usesRequestTimeCredential ? '' : material.apiKey
      const materialHeaders = usesRequestTimeCredential ? undefined : material.headers
      const config: ServeProviderConfig =
        profile.kind === 'agent-sdk' ||
        profile.kind === 'antigravity-cli' ||
        profile.kind === 'cursor-sdk' ||
        profile.kind === 'gemini-cli-api'
        ? {
            kind: profile.kind,
            apiKey,
            ...(credentialSourceId ? { credentialSourceId } : {}),
            models: [...profile.models],
            ...(profile.modelCapabilities ? { modelCapabilities: profile.modelCapabilities } : {}),
            ...(profile.selectedModel ? { selectedModel: profile.selectedModel } : {})
          }
        : profile.kind === 'gemini-code-assist'
          ? {
              kind: 'gemini-code-assist',
              apiKey,
              ...(credentialSourceId ? { credentialSourceId } : {}),
              baseUrl: profile.baseUrl!,
              endpointFormat: profile.endpointFormat,
              models: [...profile.models],
              ...(profile.modelCapabilities ? { modelCapabilities: profile.modelCapabilities } : {}),
              ...(profile.selectedModel ? { selectedModel: profile.selectedModel } : {}),
              ...(material.geminiAuth ? { geminiAuth: material.geminiAuth } : {})
            }
          : {
              kind: 'http',
              apiKey,
              ...(credentialSourceId ? { credentialSourceId } : {}),
              baseUrl: profile.baseUrl!,
              endpointFormat: profile.endpointFormat,
              models: [...profile.models],
              ...(profile.modelCapabilities ? { modelCapabilities: profile.modelCapabilities } : {}),
              ...(profile.selectedModel ? { selectedModel: profile.selectedModel } : {}),
              ...(materialHeaders || profile.headers
                ? { headers: { ...(profile.headers ?? {}), ...(materialHeaders ?? {}) } }
                : {})
            }
      providers.set(profile.id, config)
      if (profile.id === document.defaultProviderId && document.defaultModel) {
        selected = { profile, config, model: document.defaultModel }
      }
    }
    return {
      providers,
      proxy: document.proxy,
      routePools: document.routePools,
      localModelGateway: document.localModelGateway,
      ...(selected ? { selected } : {})
    }
  }

  private async probeInput(input: ModelConnectionConnectRequest): Promise<string[]> {
    return probeModels({
      kind: input.kind,
      baseUrl: input.baseUrl,
      endpointFormat: input.endpointFormat,
      apiKey: input.credential?.trim() ?? '',
      fallbackModels: input.models,
      proxyUrl: ''
    })
  }

  private async apply(document: RegistryDocument): Promise<void> {
    await this.options.onChanged?.(await this.materializeDocument(document))
  }

  private async retryLegacyCredentialSourceRetirements(): Promise<void> {
    const document = await this.file.read(emptyDocument)
    for (const profile of Object.values(document.profiles)) {
      if (profile.legacyCredentialSourceToRetire) {
        await this.retireLegacyCredentialSource(profile.id)
      }
    }
    for (const [providerId, tombstone] of Object.entries(document.tombstones)) {
      if (tombstone.legacyCredentialSourceToRetire) {
        await this.retireDeletedLegacyCredentialSource(providerId)
      }
    }
  }

  private async retireLegacyCredentialSource(providerId: string): Promise<void> {
    const retire = this.options.retireLegacyCredentialSource
    if (!retire) return
    const profile = (await this.file.read(emptyDocument)).profiles[providerId]
    const sourceId = profile?.legacyCredentialSourceToRetire
    if (!sourceId) return
    try {
      await retire(sourceId)
      await this.file.update(emptyDocument, (current) => {
        const currentProfile = current.profiles[providerId]
        if (currentProfile?.legacyCredentialSourceToRetire !== sourceId) return current
        return {
          ...current,
          profiles: {
            ...current.profiles,
            [providerId]: {
              ...currentProfile,
              legacyCredentialSourceToRetire: undefined
            }
          }
        }
      })
    } catch (error) {
      console.warn('[kun] Registry credential replaced, but its legacy source retirement is pending.', {
        providerId,
        sourceId,
        message: error instanceof Error ? error.message : String(error)
      })
    }
  }

  private async retireDeletedLegacyCredentialSource(providerId: string): Promise<void> {
    const retire = this.options.retireLegacyCredentialSource
    if (!retire) return
    const tombstone = (await this.file.read(emptyDocument)).tombstones[providerId]
    const sourceId = tombstone?.legacyCredentialSourceToRetire
    if (!sourceId) return
    try {
      await retire(sourceId)
      await this.file.update(emptyDocument, (current) => {
        const currentTombstone = current.tombstones[providerId]
        if (currentTombstone?.legacyCredentialSourceToRetire !== sourceId) return current
        return {
          ...current,
          tombstones: {
            ...current.tombstones,
            [providerId]: {
              ...currentTombstone,
              legacyCredentialSourceToRetire: undefined
            }
          }
        }
      })
    } catch (error) {
      console.warn('[kun] Deleted Registry provider still has a pending legacy source retirement.', {
        providerId,
        sourceId,
        message: error instanceof Error ? error.message : String(error)
      })
    }
  }

  private async changed(_document: RegistryDocument): Promise<void> {
    await this.applyLatest()
  }

  private nowMs(): number {
    return this.options.nowMs?.() ?? Date.now()
  }

  private credentialFenceTtlMs(): number {
    const configured = this.options.credentialFenceTtlMs
    return configured !== undefined && Number.isFinite(configured) && configured > 0
      ? configured
      : 60_000
  }

  private clearPreparedCredentialSecret(providerId: string, operationToken?: string): void {
    const pending = this.preparedCredentialSecrets.get(providerId)
    if (!pending || (operationToken && pending.operationToken !== operationToken)) return
    this.preparedCredentialSecrets.delete(providerId)
    const timerKey = preparedCredentialSecretTimerKey(providerId, pending.operationToken)
    const timer = this.preparedCredentialSecretTimers.get(timerKey)
    if (timer) clearTimeout(timer)
    this.preparedCredentialSecretTimers.delete(timerKey)
  }

  private schedulePreparedCredentialSecretExpiry(
    providerId: string,
    operationToken: string,
    expiresAt: number
  ): void {
    const timerKey = preparedCredentialSecretTimerKey(providerId, operationToken)
    const previous = this.preparedCredentialSecretTimers.get(timerKey)
    if (previous) clearTimeout(previous)
    const timer = setTimeout(() => {
      this.clearPreparedCredentialSecret(providerId, operationToken)
      this.preparedCredentialSecretTimers.delete(timerKey)
    }, Math.min(Math.max(0, expiresAt - this.nowMs()), 2_147_483_647))
    timer.unref?.()
    this.preparedCredentialSecretTimers.set(timerKey, timer)
  }

  private cancelCredentialRecoveryTimer(providerId: string): void {
    const timer = this.credentialRecoveryTimers.get(providerId)
    if (timer) clearTimeout(timer)
    this.credentialRecoveryTimers.delete(providerId)
  }

  private scheduleCredentialRecoveries(document: RegistryDocument): void {
    for (const [providerId, transaction] of Object.entries(document.credentialTransactions)) {
      this.scheduleCredentialRecovery(providerId, transaction)
    }
  }

  private scheduleCredentialRecovery(
    providerId: string,
    transaction: CredentialTransaction | undefined
  ): void {
    this.cancelCredentialRecoveryTimer(providerId)
    if (!transaction) return
    const delay = transaction.phase === 'recovering'
      ? 1_000
      : Math.max(0, transaction.expiresAt - this.nowMs())
    const timer = setTimeout(() => {
      void this.recoverExpiredCredentialTransaction(providerId, transaction.operationToken)
        .catch(() => undefined)
        .finally(async () => {
          const current = (await this.file.read(emptyDocument)).credentialTransactions[providerId]
          if (current) this.scheduleCredentialRecovery(providerId, current)
        })
    }, Math.min(delay, 2_147_483_647))
    timer.unref?.()
    this.credentialRecoveryTimers.set(providerId, timer)
  }

  private async readDocumentForCredentialConsumer(providerId: string): Promise<RegistryDocument> {
    await this.recoverExpiredCredentialTransaction(providerId).catch(() => undefined)
    return this.file.read(emptyDocument)
  }

  private async recoverExpiredCredentialTransactions(document: RegistryDocument): Promise<void> {
    for (const [providerId, transaction] of Object.entries(document.credentialTransactions)) {
      const writerDied = transaction.writerPid !== undefined && !this.isProcessAlive(transaction.writerPid)
      if (transaction.phase === 'recovering' || transaction.expiresAt <= this.nowMs() || writerDied) {
        await this.recoverExpiredCredentialTransaction(providerId, transaction.operationToken)
          .catch(() => undefined)
      } else {
        this.scheduleCredentialRecovery(providerId, transaction)
      }
    }
  }

  /**
   * Restores the previous durable credential while the global fence remains
   * installed. Only after the live apply succeeds is the matching transaction
   * removed. A failed apply therefore remains fail-closed and is retried.
   */
  private async recoverExpiredCredentialTransaction(
    providerId: string,
    operationToken?: string
  ): Promise<boolean> {
    let recover = false
    let removedOrphan = false
    let durableTokenMissingOrMismatch = false
    let token = operationToken
    const recovering = await this.file.update(emptyDocument, (current) => {
      const transaction = current.credentialTransactions[providerId]
      if (!transaction || (token && transaction.operationToken !== token)) {
        durableTokenMissingOrMismatch = true
        return current
      }
      token = transaction.operationToken
      const writerDied = transaction.writerPid !== undefined && !this.isProcessAlive(transaction.writerPid)
      if (
        transaction.phase !== 'recovering' &&
        transaction.expiresAt > this.nowMs() &&
        !writerDied
      ) {
        return current
      }
      if (
        transaction.phase === 'recovering' &&
        transaction.recoveryOwnerId !== this.registryInstanceId &&
        transaction.recoveryOwnerPid !== undefined &&
        this.isProcessAlive(transaction.recoveryOwnerPid)
      ) {
        return current
      }
      const profile = current.profiles[providerId]
      if (!profile || profile.incarnationId !== transaction.incarnationId) {
        const credentialTransactions = { ...current.credentialTransactions }
        delete credentialTransactions[providerId]
        removedOrphan = true
        return {
          ...current,
          revision: current.revision + 1,
          credentialTransactions,
          credentialRefCleanup: appendCredentialRefs(
            current.credentialRefCleanup,
            this.nowMs(),
            transaction.nextCredentialRef,
            transaction.writerInstanceId,
            transaction.writerPid
          )
        }
      }
      recover = true
      if (
        transaction.phase === 'recovering' &&
        transaction.recoveryOwnerId === this.registryInstanceId &&
        (!transaction.nextCredentialRef || Boolean(current.credentialRefCleanup[transaction.nextCredentialRef]))
      ) return current
      return {
        ...current,
        revision: current.revision + 1,
        credentialTransactions: {
          ...current.credentialTransactions,
          [providerId]: {
            ...transaction,
            phase: 'recovering',
            recoveryOwnerId: this.registryInstanceId,
            recoveryOwnerPid: process.pid
          }
        },
        credentialRefCleanup: appendCredentialRefs(
          current.credentialRefCleanup,
          this.nowMs(),
          transaction.nextCredentialRef,
          transaction.writerInstanceId,
          transaction.writerPid
        )
      }
    })
    // Another Registry can supersede, commit, clear, or delete the durable
    // transaction without touching this process's prepared plaintext. The old
    // timer still identifies its local token, so release only that generation
    // and leave the newer durable state completely untouched.
    if (durableTokenMissingOrMismatch && operationToken) {
      this.clearPreparedCredentialSecret(providerId, operationToken)
    }
    if (removedOrphan) {
      this.clearPreparedCredentialSecret(providerId, token)
      this.cancelCredentialRecoveryTimer(providerId)
      await this.changed(recovering)
      await this.drainCredentialRefCleanup()
      return true
    }
    if (!recover || !token) {
      const current = recovering.credentialTransactions[providerId]
      if (current) this.scheduleCredentialRecovery(providerId, current)
      return false
    }

    const operation = this.changeOperation.then(async () => {
      const current = await this.file.read(emptyDocument)
      const transaction = current.credentialTransactions[providerId]
      if (
        transaction?.operationToken !== token ||
        transaction.phase !== 'recovering' ||
        transaction.recoveryOwnerId !== this.registryInstanceId
      ) return false
      await this.options.onChanged?.(await this.materializeDocument(current, providerId))
      const afterApply = await this.file.read(emptyDocument)
      const afterTransaction = afterApply.credentialTransactions[providerId]
      if (
        afterTransaction?.operationToken !== token ||
        afterTransaction.phase !== 'recovering' ||
        afterTransaction.recoveryOwnerId !== this.registryInstanceId
      ) {
        await this.apply(afterApply)
        return false
      }
      return true
    })
    this.changeOperation = operation.then(() => undefined, () => undefined)
    let applied: boolean
    try {
      applied = await operation
    } catch (error) {
      const current = (await this.file.read(emptyDocument)).credentialTransactions[providerId]
      if (current?.operationToken === token) this.scheduleCredentialRecovery(providerId, current)
      throw error
    }
    if (!applied) return false

    let finalized = false
    const document = await this.file.update(emptyDocument, (current) => {
      const transaction = current.credentialTransactions[providerId]
      const profile = current.profiles[providerId]
      if (
        transaction?.operationToken !== token ||
        transaction.phase !== 'recovering' ||
        transaction.recoveryOwnerId !== this.registryInstanceId ||
        !profile ||
        profile.incarnationId !== transaction.incarnationId
      ) return current
      const credentialTransactions = { ...current.credentialTransactions }
      delete credentialTransactions[providerId]
      finalized = true
      return {
        ...current,
        revision: current.revision + 1,
        credentialTransactions
      }
    })
    if (!finalized) {
      await this.applyLatest()
      return false
    }
    this.clearPreparedCredentialSecret(providerId, token)
    this.cancelCredentialRecoveryTimer(providerId)
    await this.changed(document)
    await this.drainCredentialRefCleanup()
    return true
  }

  private async drainCredentialRefCleanup(): Promise<void> {
    const initial = await this.file.read(emptyDocument)
    for (const entry of Object.values(initial.credentialRefCleanup)) {
      const { reference } = entry
      const current = await this.file.read(emptyDocument)
      const latestEntry = current.credentialRefCleanup[reference]
      if (!latestEntry) continue
      if (credentialReferenceIsLive(current, reference)) continue
      if (latestEntry.writerPid && this.isProcessAlive(latestEntry.writerPid)) continue
      try {
        await this.options.credentials.delete(reference)
      } catch {
        continue
      }
      await this.file.update(emptyDocument, (latest) => {
        const candidate = latest.credentialRefCleanup[reference]
        if (!candidate || credentialReferenceIsLive(latest, reference)) return latest
        if (candidate.writerPid && this.isProcessAlive(candidate.writerPid)) return latest
        const credentialRefCleanup = { ...latest.credentialRefCleanup }
        delete credentialRefCleanup[reference]
        return { ...latest, credentialRefCleanup }
      })
    }
  }

  private isProcessAlive(pid: number): boolean {
    return this.options.isProcessAlive?.(pid) ?? processIsAlive(pid)
  }

  private async retireStaleCredentialWrite(reference: string): Promise<void> {
    let deleted = false
    try {
      await this.options.credentials.delete(reference)
      deleted = true
    } catch {
      // The writer is still able to durably acknowledge that it will never
      // write this ref again. Preserve a retryable cleanup entry without the
      // live-writer lease instead of dropping the ref after a failed delete.
    }
    await this.file.update(emptyDocument, (current) => {
      const entry = current.credentialRefCleanup[reference]
      if (!entry || credentialReferenceIsLive(current, reference)) return current
      if (entry.writerInstanceId && entry.writerInstanceId !== this.registryInstanceId) return current
      const credentialRefCleanup = { ...current.credentialRefCleanup }
      if (deleted) {
        delete credentialRefCleanup[reference]
      } else {
        credentialRefCleanup[reference] = {
          reference,
          enqueuedAt: entry.enqueuedAt
        }
      }
      return { ...current, credentialRefCleanup }
    })
  }

  private async abandonCredentialWrite(
    providerId: string,
    operationToken: string,
    reference: string
  ): Promise<void> {
    await this.options.credentials.delete(reference).catch(() => undefined)
    await this.file.update(emptyDocument, (current) => {
      const transaction = current.credentialTransactions[providerId]
      if (
        transaction?.operationToken !== operationToken ||
        transaction.nextCredentialRef !== reference ||
        transaction.writerInstanceId !== this.registryInstanceId
      ) {
        const entry = current.credentialRefCleanup[reference]
        if (
          !entry ||
          entry.writerInstanceId !== this.registryInstanceId ||
          credentialReferenceIsLive(current, reference)
        ) return current
        return {
          ...current,
          credentialRefCleanup: {
            ...current.credentialRefCleanup,
            [reference]: {
              reference,
              enqueuedAt: entry.enqueuedAt
            }
          }
        }
      }
      return {
        ...current,
        revision: current.revision + 1,
        credentialTransactions: {
          ...current.credentialTransactions,
          [providerId]: {
            ...transaction,
            phase: 'recovering',
            expiresAt: this.nowMs(),
            writerInstanceId: undefined,
            writerPid: undefined,
            recoveryOwnerId: this.registryInstanceId,
            recoveryOwnerPid: process.pid
          }
        },
        credentialRefCleanup: appendCredentialRefs(
          current.credentialRefCleanup,
          this.nowMs(),
          reference
        )
      }
    })
    await this.recoverExpiredCredentialTransaction(providerId, operationToken).catch(() => undefined)
    await this.drainCredentialRefCleanup()
  }

  /**
   * Registry file updates are already serialized by AtomicJsonFile, but live
   * application can include slower asynchronous model-runtime construction.
   * Serialize that second phase as well and always read the newest durable
   * document when a queued application begins. This prevents an older GUI/TUI
   * write from finishing late and replacing a newer runtime generation.
   */
  private async applyLatest(): Promise<void> {
    const operation = this.changeOperation.then(async () => {
      const document = await this.file.read(emptyDocument)
      if (document.revision <= this.lastAppliedRevision) return
      await this.apply(document)
      this.lastAppliedRevision = document.revision
      const snapshot = await this.projectWithCredentialHealth(document)
      for (const listener of this.listeners) listener(snapshot)
    })
    this.changeOperation = operation.catch(() => undefined)
    await operation
  }

  private project(document: RegistryDocument): ModelConnectionSnapshot {
    return project(document, this.options.modelCapabilities, this.credentialHealth)
  }

  private async projectWithCredentialHealth(
    document: RegistryDocument
  ): Promise<ModelConnectionSnapshot> {
    const health = await this.inspectCredentialHealth(document)
    if (document.revision >= this.credentialHealthRevision) {
      this.credentialHealthRevision = document.revision
      this.credentialHealth = new Map(health)
    }
    return project(document, this.options.modelCapabilities, health)
  }

  private async inspectCredentialHealth(
    document: RegistryDocument
  ): Promise<ReadonlyMap<string, ProjectedCredentialHealth>> {
    const entries = await Promise.all(Object.values(document.profiles).map(async (profile) => {
      if (document.credentialTransactions[profile.id]) {
        return [profile.id, credentialHealth('missing')] as const
      }
      if (profile.credentialRef) {
        try {
          const credential = await this.options.credentials.get(profile.credentialRef)
          return [profile.id, credential?.apiKey?.trim()
            ? credentialHealth('ready')
            : credentialHealth('missing')] as const
        } catch {
          return [profile.id, credentialHealth('unreadable')] as const
        }
      }
      if (profile.credentialSourceId && this.options.inspectCredentialSource) {
        try {
          const status = await this.options.inspectCredentialSource(profile.credentialSourceId)
          return [profile.id, credentialHealth(status)] as const
        } catch {
          return [profile.id, credentialHealth('unreadable')] as const
        }
      }
      if (!profile.configured && profile.kind === 'http') {
        return [profile.id, credentialHealth('missing')] as const
      }
      return null
    }))
    return new Map(entries.filter((entry): entry is NonNullable<typeof entry> => entry !== null))
  }
}

type ProjectedCredentialHealth = {
  credentialStatus: ModelConnectionCredentialStatus
  credentialErrorCode?: ModelConnectionCredentialErrorCode
}

function credentialHealth(status: ModelConnectionCredentialStatus): ProjectedCredentialHealth {
  if (status === 'missing') {
    return { credentialStatus: status, credentialErrorCode: 'credential_missing' }
  }
  if (status === 'unreadable') {
    return { credentialStatus: status, credentialErrorCode: 'credential_unreadable' }
  }
  return { credentialStatus: status }
}

function readLatestIfChanged(
  registry: ModelConnectionRegistry,
  sinceRevision: number,
  finish: (snapshot: ModelConnectionSnapshot) => void
): void {
  void registry.snapshot().then((snapshot) => {
    if (snapshot.revision > sinceRevision) finish(snapshot)
  })
}

function parseCredentialOperationToken(operationToken: string): {
  clientId: string
  generation: number
} {
  const [, clientId = '', generationRaw = ''] = operationToken.split(':')
  const generation = Number(generationRaw)
  if (!clientId || !Number.isSafeInteger(generation) || generation <= 0) {
    throw new Error('invalid credential operation token')
  }
  return { clientId, generation }
}

function previousCredentialState(profile: StoredProfile): CredentialTransaction['previous'] {
  return {
    credentialRef: profile.credentialRef,
    credentialSourceId: profile.credentialSourceId,
    legacyCredentialSourceToRetire: profile.legacyCredentialSourceToRetire,
    configured: profile.configured
  }
}

function boundedCredentialHighWater(
  current: StoredProfile['credentialMutationHighWater'],
  clientId: string,
  generation: number
): Record<string, number> {
  const previousClients = Object.entries(current ?? {})
    .filter(([existingClientId]) => existingClientId !== clientId)
    .slice(-63)
  return Object.fromEntries([...previousClients, [clientId, generation]])
}

function appendCredentialRefs(
  current: RegistryDocument['credentialRefCleanup'],
  enqueuedAt: number,
  reference?: string,
  writerInstanceId?: string,
  writerPid?: number
): RegistryDocument['credentialRefCleanup'] {
  if (!reference) return current
  const existing = current[reference]
  if (existing && !existing.writerInstanceId) return current
  return {
    ...current,
    [reference]: {
      reference,
      enqueuedAt,
      ...(writerInstanceId ? { writerInstanceId } : {}),
      ...(writerPid ? { writerPid } : {})
    }
  }
}

function requireCredentialTransaction(
  document: RegistryDocument,
  providerId: string,
  operationToken: string
): CredentialTransaction {
  const transaction = document.credentialTransactions[providerId]
  if (!transaction || transaction.operationToken !== operationToken) {
    throw new ModelConnectionConflictError(project(document))
  }
  return transaction
}

function credentialReferenceIsLive(document: RegistryDocument, reference: string): boolean {
  return Object.values(document.profiles).some((profile) => profile.credentialRef === reference) ||
    Object.values(document.credentialTransactions)
      .some((transaction) => transaction.nextCredentialRef === reference)
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function emptyDocument(): RegistryDocument {
  return {
    schemaVersion: 1,
    revision: 0,
    profiles: {},
    tombstones: {},
    credentialTransactions: {},
    credentialRefCleanup: {},
    proxy: { enabled: false, url: '' },
    routePools: [],
    localModelGateway: { enabled: false }
  }
}

function configuredFallback(
  profiles: readonly StoredProfile[]
): { profile: StoredProfile; model: string } | undefined {
  for (const profile of profiles) {
    if (!profile.configured) continue
    const model = profile.selectedModel ?? profile.models[0]
    if (model) return { profile, model }
  }
  return undefined
}

function reconcileSeedProfile(
  existing: StoredProfile,
  request: ModelConnectionConnectRequest
): StoredProfile {
  const incomingModels = uniqueModels([
    ...request.models,
    ...(request.selectedModel ? [request.selectedModel] : [])
  ])
  const migrateGeminiSubscription =
    existing.id === 'gemini-subscription' &&
    existing.kind === 'gemini-code-assist' &&
    request.kind === 'antigravity-cli'
  // Once a profile exists, the Registry owns its catalog and selection.
  // AppSettings seeds are a compatibility import, not a union source: using
  // them to add models would resurrect a user-deleted model after restart.
  // The one exception is the explicit one-time Gemini transport migration.
  const models = migrateGeminiSubscription && incomingModels.length > 0
    ? incomingModels
    : existing.models
  const selectedModel = migrateGeminiSubscription
    ? request.selectedModel ?? models[0]
    : existing.selectedModel ?? models[0]
  const modelCapabilities = migrateGeminiSubscription && request.modelCapabilities
    ? capabilitiesForModels(request.modelCapabilities, models)
    : existing.modelCapabilities

  return StoredProfileSchema.parse({
    ...existing,
    // Credential ownership is imported only when a profile is first created.
    // Re-applying GUI/settings seeds must never replace a Registry-owned
    // credentialRef, resurrect a cleared credential, or switch an existing
    // profile back to a legacy settings:provider:* source.
    ...(migrateGeminiSubscription
      ? {
          kind: request.kind,
          authType: request.authType,
          baseUrl: request.baseUrl,
          endpointFormat: request.endpointFormat,
          configured: true,
          ...(request.presetSource ? { presetSource: request.presetSource } : {})
        }
      : {}),
    models,
    ...(modelCapabilities ? { modelCapabilities } : {}),
    ...(selectedModel ? { selectedModel } : {})
  })
}

function sameStoredProfile(left: StoredProfile, right: StoredProfile): boolean {
  return left.id === right.id &&
    left.accountId === right.accountId &&
    left.name === right.name &&
    left.presetSource === right.presetSource &&
    left.kind === right.kind &&
    left.authType === right.authType &&
    left.baseUrl === right.baseUrl &&
    left.endpointFormat === right.endpointFormat &&
    left.configured === right.configured &&
    left.incarnationId === right.incarnationId &&
    left.selectedModel === right.selectedModel &&
    left.credentialRef === right.credentialRef &&
    left.credentialSourceId === right.credentialSourceId &&
    left.legacyCredentialSourceToRetire === right.legacyCredentialSourceToRetire &&
    sameModels(left.models, right.models) &&
    sameCapabilities(left.modelCapabilities, right.modelCapabilities)
}

function project(
  document: RegistryDocument,
  resolveModelCapabilities?: (
    model: string,
    profile?: Pick<ModelConnectionProfile, 'id' | 'presetSource' | 'baseUrl' | 'kind'>
  ) => ModelCapabilityMetadata,
  credentialHealthByProvider: ReadonlyMap<string, ProjectedCredentialHealth> = new Map()
): ModelConnectionSnapshot {
  return ModelConnectionSnapshotSchema.parse({
    schemaVersion: 1,
    revision: document.revision,
    providers: Object.values(document.profiles)
      .map(({
        incarnationId: _incarnationId,
        credentialMutationHighWater: _credentialMutationHighWater,
        credentialRef: _credentialRef,
        credentialSourceId: _credentialSourceId,
        legacyCredentialSourceToRetire: _legacyCredentialSourceToRetire,
        headers: _headers,
        ...profile
      }) => {
        const modelCapabilities = Object.fromEntries(profile.models.flatMap((model) => {
          const stored = profile.modelCapabilities?.[model] ??
            profile.modelCapabilities?.[model.trim().toLowerCase()]
          const derived = resolveModelCapabilities?.(model, profile)
          const capability = mergeProjectedCapability(stored, derived, profile, model)
          return capability ? [[model, { ...capability, id: model }]] : []
        }))
        return {
          ...profile,
          ...credentialHealthByProvider.get(profile.id),
          ...(Object.keys(modelCapabilities).length > 0 ? { modelCapabilities } : {})
        }
      })
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
    defaultProviderId: document.defaultProviderId,
    defaultAccountId: document.defaultAccountId,
    defaultModel: document.defaultModel,
    proxy: document.proxy,
    routePools: document.routePools,
    localModelGateway: document.localModelGateway
  })
}

function mergeProjectedCapability(
  stored: ModelCapabilityMetadata | undefined,
  derived: ModelCapabilityMetadata | undefined,
  profile: Pick<ModelConnectionProfile, 'id' | 'endpointFormat'>,
  model: string
): ModelCapabilityMetadata | undefined {
  if (!stored) return derived
  const serviceTiers = stored.serviceTiers ?? derived?.serviceTiers
  if (!derived?.reasoning || stored.reasoning === derived.reasoning) {
    return serviceTiers ? { ...stored, serviceTiers: [...serviceTiers] } : stored
  }
  const placeholder = stored.reasoning?.requestProtocol === 'none' &&
    derived.reasoning.requestProtocol !== 'none' &&
    stored.reasoning.defaultEffort === 'auto' &&
    stored.reasoning.supportedEfforts.every((effort) => effort === 'auto' || effort === 'off')
  const chatResponsesMismatch =
    profile.endpointFormat === 'chat_completions' &&
    stored.reasoning?.requestProtocol === 'openai-responses' &&
    derived.reasoning.requestProtocol === 'openai-chat-completions' &&
    (
      (profile.id.toLowerCase().includes('kimi-code') && model.trim().toLowerCase() === 'k3') ||
      (profile.id.toLowerCase().includes('opencode-go') &&
        model.trim().toLowerCase().endsWith('grok-4.5'))
    )
  if (!stored.reasoning || placeholder || chatResponsesMismatch) {
    return {
      ...stored,
      reasoning: derived.reasoning,
      ...(serviceTiers ? { serviceTiers: [...serviceTiers] } : {})
    }
  }
  return serviceTiers ? { ...stored, serviceTiers: [...serviceTiers] } : stored
}

function assertRevision(
  document: RegistryDocument,
  expected: number,
  resolveModelCapabilities?: (
    model: string,
    profile?: Pick<ModelConnectionProfile, 'id' | 'presetSource' | 'baseUrl' | 'kind'>
  ) => ModelCapabilityMetadata,
  credentialHealthByProvider: ReadonlyMap<string, ProjectedCredentialHealth> = new Map()
): void {
  if (document.revision !== expected) {
    throw new ModelConnectionConflictError(project(
      document,
      resolveModelCapabilities,
      credentialHealthByProvider
    ))
  }
}

function requireProfile(document: RegistryDocument, providerId: string): StoredProfile {
  const profile = document.profiles[providerId]
  if (!profile) throw new Error('model connection not found')
  return profile
}

function capabilitiesForModels(
  input: Record<string, ModelCapabilityMetadata>,
  models: readonly string[]
): Record<string, ModelCapabilityMetadata> {
  return Object.fromEntries(models.flatMap((model) => {
    const capability = input[model] ?? input[model.trim().toLowerCase()]
    return capability ? [[model, { ...capability, id: model }]] : []
  }))
}

function sameCapabilities(
  left: Record<string, ModelCapabilityMetadata> | undefined,
  right: Record<string, ModelCapabilityMetadata> | undefined
): boolean {
  return JSON.stringify(left ?? {}) === JSON.stringify(right ?? {})
}

function allocateId(document: RegistryDocument, requested: string): string {
  const base = normalizeProviderId(requested) || 'provider'
  if (!document.profiles[base] && !document.credentialTransactions[base]) return base
  for (let index = 2; index < 10_000; index += 1) {
    const candidate = `${base}-${index}`
    if (!document.profiles[candidate] && !document.credentialTransactions[candidate]) return candidate
  }
  throw new Error('unable to allocate provider id')
}

function normalizeProviderId(requested: string): string {
  return requested.trim().toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 100)
}

function preparedCredentialSecretTimerKey(providerId: string, operationToken: string): string {
  return `${providerId}\u0000${operationToken}`
}

function uniqueModels(models: readonly string[]): string[] {
  return [...new Set(models.map((model) => model.trim()).filter(Boolean))]
}

function sameModels(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((model, index) => model === right[index])
}

async function probeModels(input: {
  kind: ModelConnectionProfile['kind']
  baseUrl?: string
  endpointFormat?: ModelConnectionProfile['endpointFormat']
  apiKey: string
  headers?: Record<string, string>
  fallbackModels: readonly string[]
  proxyUrl: string
}): Promise<string[]> {
  if (input.kind !== 'http') return uniqueModels(input.fallbackModels)
  if (!input.baseUrl) throw new Error('provider probe failed: HTTP provider has no base URL')
  const url = modelsUrl(input.baseUrl, input.endpointFormat)
  const usesAnthropicHeaders = input.endpointFormat === 'messages'
  const authHeaders: Record<string, string> = input.apiKey
    ? usesAnthropicHeaders
      ? { 'x-api-key': input.apiKey, 'anthropic-version': '2023-06-01' }
      : { authorization: `Bearer ${input.apiKey}` }
    : {}
  const fetchImpl = createProxyFetch(input.proxyUrl) ?? fetch
  const response = await fetchImpl(url, {
    headers: { ...(input.headers ?? {}), ...authHeaders },
    signal: AbortSignal.timeout(15_000)
  })
  if (!response.ok) throw new Error(`provider probe failed with HTTP ${response.status}`)
  const value = await response.json().catch(() => ({})) as { data?: Array<{ id?: unknown }>; models?: unknown[] }
  const discovered = Array.isArray(value.data)
    ? value.data.flatMap((entry) => typeof entry?.id === 'string' ? [entry.id] : [])
    : Array.isArray(value.models)
      ? value.models.flatMap((entry) => typeof entry === 'string' ? [entry] : [])
      : []
  return uniqueModels([...discovered, ...input.fallbackModels])
}

function modelsUrl(
  baseUrl: string,
  endpointFormat: ModelConnectionProfile['endpointFormat'] | undefined
): string {
  if (endpointFormat === 'custom_endpoint') {
    throw new Error(
      'provider probe failed: custom_endpoint does not define a models URL; configure models explicitly with probe disabled'
    )
  }
  const url = new URL(baseUrl)
  url.search = ''
  url.hash = ''
  const segments = url.pathname.split('/').filter(Boolean)
  const last = segments.at(-1)?.toLowerCase()
  if (last === 'models') {
    url.pathname = `/${segments.join('/')}`
    return url.toString()
  }
  if (last === 'responses' || last === 'messages') {
    segments.pop()
  } else if (last === 'completions' && segments.at(-2)?.toLowerCase() === 'chat') {
    segments.splice(-2)
  }
  const version = segments.at(-1)?.toLowerCase()
  if (version === 'beta') {
    segments[segments.length - 1] = 'v1'
  } else if (!version || !/^v\d+$/u.test(version)) {
    segments.push('v1')
  }
  if (segments.at(-1)?.toLowerCase() !== 'models') segments.push('models')
  url.pathname = `/${segments.join('/')}`
  return url.toString()
}
