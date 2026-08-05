import { join } from 'node:path'
import { z } from 'zod'
import { AtomicJsonFile } from '../extensions/atomic-json.js'
import type { ServeProviderConfig } from '../config/kun-config.js'
import type { ModelCapabilityMetadata } from '../contracts/capabilities.js'
import {
  ModelConnectionConnectRequestSchema,
  ModelConnectionCredentialRequestSchema,
  ModelConnectionGlobalsRequestSchema,
  ModelConnectionPatchRequestSchema,
  ModelConnectionSelectRequestSchema,
  ModelConnectionSnapshotSchema,
  type ModelConnectionConnectRequest,
  type ModelConnectionProfile,
  type ModelConnectionSnapshot
} from '../contracts/model-connections.js'
import { materializeLegacyProviderCredential } from './legacy-provider-credential-migration.js'
import type { ExtensionCredentialStore } from './extension-credential-store.js'
import { createProxyFetch } from '../adapters/model/proxy-fetch.js'

const StoredProfileSchema = ModelConnectionSnapshotSchema.shape.providers.element.extend({
  credentialRef: z.string().min(1).max(256).optional(),
  credentialSourceId: z.string().min(1).max(256).optional(),
  legacyCredentialSourceToRetire: z.string().min(1).max(256).optional(),
  headers: z.record(z.string(), z.string()).optional()
})
const DeletedProfileTombstoneSchema = z.object({
  deletedRevision: z.number().int().nonnegative(),
  legacyCredentialSourceToRetire: z.string().min(1).max(256).optional()
}).strict()
const RegistryDocumentSchema = z.object({
  schemaVersion: z.literal(1),
  revision: z.number().int().nonnegative(),
  profiles: z.record(z.string(), StoredProfileSchema),
  tombstones: z.record(z.string(), DeletedProfileTombstoneSchema).default({}),
  defaultProviderId: z.string().min(1).optional(),
  defaultAccountId: z.string().min(1).optional(),
  defaultModel: z.string().min(1).optional(),
  proxy: ModelConnectionSnapshotSchema.shape.proxy,
  routePools: ModelConnectionSnapshotSchema.shape.routePools,
  localModelGateway: ModelConnectionSnapshotSchema.shape.localModelGateway
}).strict()
type RegistryDocument = z.infer<typeof RegistryDocumentSchema>
type StoredProfile = z.infer<typeof StoredProfileSchema>

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

  constructor(private readonly options: {
    dataDir: string
    credentials: ExtensionCredentialStore
    modelCapabilities?: (
      model: string,
      profile?: Pick<ModelConnectionProfile, 'id' | 'presetSource' | 'baseUrl' | 'kind'>
    ) => ModelCapabilityMetadata
    onChanged?: (connections: MaterializedModelConnections) => Promise<void> | void
    retireLegacyCredentialSource?: (sourceId: string) => Promise<void>
    resolveCredentialSource?: (sourceId: string) => Promise<{
      apiKey: string
      headers?: Record<string, string>
    }>
  }) {
    this.file = new AtomicJsonFile(
      join(options.dataDir, 'model-connections.v1.json'),
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
              assertRevision(document, current.revision, this.options.modelCapabilities)
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
    return this.project(current)
  }

  async snapshot(): Promise<ModelConnectionSnapshot> {
    return this.project(await this.file.read(emptyDocument))
  }

  async assertRevision(expectedRevision: number): Promise<void> {
    assertRevision(await this.file.read(emptyDocument), expectedRevision, this.options.modelCapabilities)
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
    if (input.kind === 'http' && !input.baseUrl) {
      throw new Error('baseUrl is required for HTTP providers')
    }
    const credential = input.credential?.trim() ?? ''
    if (!credential && !externalAuthVerified) {
      throw new Error('authenticated model connection credential is required')
    }
    const nextRef = credential
      ? await this.options.credentials.create({ apiKey: credential })
      : undefined
    let previousRef: string | undefined
    let document: RegistryDocument
    try {
      document = await this.file.update(emptyDocument, (current) => {
        assertRevision(current, input.expectedRevision, this.options.modelCapabilities)
        const id = normalizeProviderId(requestedId)
        const existing = current.profiles[id]
        const deleted = current.tombstones[id]
        previousRef = nextRef ? existing?.credentialRef : undefined
        const models = uniqueModels(input.models)
        const selectedModel = input.selectedModel ?? models[0]
        if (selectedModel && models.length > 0 && !models.includes(selectedModel)) {
          throw new Error('selected model is not present in the provider model list')
        }
        const accountId = existing?.accountId ?? `account:${id}`
        const credentialRef = nextRef ?? existing?.credentialRef
        const profile = StoredProfileSchema.parse({
          id,
          accountId,
          name: input.name,
          presetSource: input.presetSource,
          kind: input.kind,
          authType: input.authType,
          baseUrl: input.baseUrl,
          endpointFormat: input.endpointFormat,
          configured: true,
          models,
          ...(input.modelCapabilities
            ? { modelCapabilities: capabilitiesForModels(input.modelCapabilities, models) }
            : {}),
          selectedModel,
          credentialRef,
          // A newly committed runtime-owned credential replaces any imported
          // request-time source. Official CLI verification intentionally
          // leaves an existing source untouched when no credential is copied.
          credentialSourceId: nextRef
            ? undefined
            : existing?.credentialSourceId,
          ...(deleted?.legacyCredentialSourceToRetire && this.options.retireLegacyCredentialSource
            ? { legacyCredentialSourceToRetire: deleted.legacyCredentialSourceToRetire }
            : {}),
          headers: existing?.headers
        })
        const tombstones = { ...current.tombstones }
        delete tombstones[id]
        return {
          ...current,
          revision: current.revision + 1,
          profiles: { ...current.profiles, [id]: profile },
          tombstones,
          ...(input.select && selectedModel ? {
            defaultProviderId: id,
            defaultAccountId: accountId,
            defaultModel: selectedModel
          } : {})
        }
      })
    } catch (error) {
      if (nextRef) await this.options.credentials.delete(nextRef).catch(() => undefined)
      throw error
    }
    try {
      await this.changed(document)
      await this.retireLegacyCredentialSource(normalizeProviderId(requestedId))
    } finally {
      if (previousRef && previousRef !== nextRef) {
        await this.options.credentials.delete(previousRef).catch(() => undefined)
      }
    }
    return this.project(document)
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
    const credentialRef = credential
      ? await this.options.credentials.create({ apiKey: credential })
      : undefined
    let document: RegistryDocument
    try {
      document = await this.file.update(emptyDocument, (current) => {
        assertRevision(current, input.expectedRevision, this.options.modelCapabilities)
        const id = allocateId(current, input.id ?? input.name)
        const deleted = current.tombstones[id]
        const accountId = `account:${id}`
        const selectedModel = input.selectedModel ?? models[0]
        const configured = Boolean(credentialRef || credentialSourceId) ||
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
          models,
          ...(input.modelCapabilities
            ? { modelCapabilities: capabilitiesForModels(input.modelCapabilities, models) }
            : {}),
          selectedModel,
          credentialRef,
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
    } catch (error) {
      if (credentialRef) await this.options.credentials.delete(credentialRef).catch(() => undefined)
      throw error
    }
    // The durable document now owns credentialRef. If live application fails,
    // retain the referenced secret so a restart or subsequent reconciliation
    // can recover; deleting it here would corrupt the committed registry.
    await this.changed(document)
    const connectedId = normalizeProviderId(input.id ?? input.name)
    if (document.profiles[connectedId]) await this.retireLegacyCredentialSource(connectedId)
    return this.project(document)
  }

  async patch(providerId: string, raw: unknown): Promise<ModelConnectionSnapshot> {
    const input = ModelConnectionPatchRequestSchema.parse(raw)
    const { expectedRevision: _expectedRevision, ...changes } = input
    const document = await this.file.update(emptyDocument, (current) => {
      assertRevision(current, input.expectedRevision, this.options.modelCapabilities)
      const profile = requireProfile(current, providerId)
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
    return this.project(document)
  }

  async replaceCredential(providerId: string, raw: unknown): Promise<ModelConnectionSnapshot> {
    const input = ModelConnectionCredentialRequestSchema.parse(raw)
    const nextRef = await this.options.credentials.create({ apiKey: input.credential.trim() })
    let previousRef: string | undefined
    let legacyCredentialSourceToRetire: string | undefined
    let document: RegistryDocument
    try {
      document = await this.file.update(emptyDocument, (current) => {
        assertRevision(current, input.expectedRevision, this.options.modelCapabilities)
        const profile = requireProfile(current, providerId)
        previousRef = profile.credentialRef
        legacyCredentialSourceToRetire = this.options.retireLegacyCredentialSource
          ? profile.legacyCredentialSourceToRetire ?? profile.credentialSourceId
          : undefined
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
          }
        }
      })
    } catch (error) {
      await this.options.credentials.delete(nextRef).catch(() => undefined)
      throw error
    }
    await this.changed(document)
    if (previousRef) await this.options.credentials.delete(previousRef).catch(() => undefined)
    await this.retireLegacyCredentialSource(providerId)
    return this.project(await this.file.read(emptyDocument))
  }

  async clearCredential(
    providerId: string,
    expectedRevision: number
  ): Promise<ModelConnectionSnapshot> {
    let previousRef: string | undefined
    let legacyCredentialSourceToRetire: string | undefined
    const document = await this.file.update(emptyDocument, (current) => {
      assertRevision(current, expectedRevision, this.options.modelCapabilities)
      const profile = requireProfile(current, providerId)
      previousRef = profile.credentialRef
      legacyCredentialSourceToRetire = this.options.retireLegacyCredentialSource
        ? profile.legacyCredentialSourceToRetire ?? profile.credentialSourceId
        : undefined
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
    await this.changed(document)
    if (previousRef) await this.options.credentials.delete(previousRef).catch(() => undefined)
    await this.retireLegacyCredentialSource(providerId)
    return this.project(await this.file.read(emptyDocument))
  }

  async delete(providerId: string, expectedRevision: number): Promise<ModelConnectionSnapshot> {
    let credentialRef: string | undefined
    let legacyCredentialSourceToRetire: string | undefined
    const document = await this.file.update(emptyDocument, (current) => {
      assertRevision(current, expectedRevision, this.options.modelCapabilities)
      const profile = requireProfile(current, providerId)
      credentialRef = profile.credentialRef
      legacyCredentialSourceToRetire = this.options.retireLegacyCredentialSource
        ? profile.legacyCredentialSourceToRetire ?? profile.credentialSourceId
        : undefined
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
            ...(legacyCredentialSourceToRetire ? { legacyCredentialSourceToRetire } : {})
          }
        },
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
    await this.changed(document)
    if (credentialRef) await this.options.credentials.delete(credentialRef).catch(() => undefined)
    await this.retireDeletedLegacyCredentialSource(providerId)
    return this.project(await this.file.read(emptyDocument))
  }

  async select(raw: unknown): Promise<ModelConnectionSnapshot> {
    const input = ModelConnectionSelectRequestSchema.parse(raw)
    const document = await this.file.update(emptyDocument, (current) => {
      assertRevision(current, input.expectedRevision, this.options.modelCapabilities)
      const profile = requireProfile(current, input.providerId)
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
    return this.project(document)
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
    return this.project(document)
  }

  async updateGlobals(raw: unknown): Promise<ModelConnectionSnapshot> {
    const input = ModelConnectionGlobalsRequestSchema.parse(raw)
    const document = await this.file.update(emptyDocument, (current) => {
      assertRevision(current, input.expectedRevision, this.options.modelCapabilities)
      return {
        ...current,
        revision: current.revision + 1,
        proxy: input.proxy,
        routePools: input.routePools,
        localModelGateway: input.localModelGateway
      }
    })
    await this.changed(document)
    return this.project(document)
  }

  async probe(providerId: string): Promise<{ ok: true; models: string[] }> {
    const document = await this.file.read(emptyDocument)
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
    const document = await this.file.read(emptyDocument)
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
    const document = await this.file.read(emptyDocument)
    const profile = document.profiles[providerId]
    if (!profile || (!profile.credentialRef && profile.credentialSourceId)) {
      return { authoritative: false, apiKey: '' }
    }
    if (!profile.credentialRef) return { authoritative: true, apiKey: '' }
    const credential = await this.options.credentials.get(profile.credentialRef)
    return { authoritative: true, apiKey: credential?.apiKey?.trim() ?? '' }
  }

  /** Resolves a Registry-owned protected credential for request-time refresh. */
  async resolveApiKey(sourceId: string): Promise<{ apiKey: string } | null> {
    const providerId = providerIdFromCredentialSource(sourceId)
    if (!providerId) return null
    const profile = (await this.file.read(emptyDocument)).profiles[providerId]
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
    const profile = (await this.file.read(emptyDocument)).profiles[providerId]
    if (!profile?.credentialRef) return false
    return this.options.credentials.compareAndSetApiKey(
      profile.credentialRef,
      expectedApiKey,
      trimmed
    )
  }

  async materialize(): Promise<MaterializedModelConnections> {
    return this.materializeDocument(await this.file.read(emptyDocument))
  }

  private async materializeDocument(
    document: RegistryDocument
  ): Promise<MaterializedModelConnections> {
    const providers = new Map<string, ServeProviderConfig>()
    let selected: MaterializedModelConnections['selected']
    for (const profile of Object.values(document.profiles)) {
      const credential = profile.credentialRef
        ? await this.options.credentials.get(profile.credentialRef)
        : null
      const material = materializeLegacyProviderCredential(credential?.apiKey ?? '')
      const credentialSourceId = profile.credentialRef
        ? modelConnectionCredentialSourceId(profile.id)
        : profile.credentialSourceId
      // A managed source is authoritative and may already have rotated beyond
      // the Registry's pre-migration credential copy. Never expose that stale
      // copy as a fallback client key.
      const usesRequestTimeCredential = profile.kind === 'http' &&
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
      const snapshot = this.project(document)
      for (const listener of this.listeners) listener(snapshot)
    })
    this.changeOperation = operation.catch(() => undefined)
    await operation
  }

  private project(document: RegistryDocument): ModelConnectionSnapshot {
    return project(document, this.options.modelCapabilities)
  }
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

function emptyDocument(): RegistryDocument {
  return {
    schemaVersion: 1,
    revision: 0,
    profiles: {},
    tombstones: {},
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
  ) => ModelCapabilityMetadata
): ModelConnectionSnapshot {
  return ModelConnectionSnapshotSchema.parse({
    schemaVersion: 1,
    revision: document.revision,
    providers: Object.values(document.profiles)
      .map(({
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
  ) => ModelCapabilityMetadata
): void {
  if (document.revision !== expected) {
    throw new ModelConnectionConflictError(project(document, resolveModelCapabilities))
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
  if (!document.profiles[base]) return base
  for (let index = 2; index < 10_000; index += 1) {
    const candidate = `${base}-${index}`
    if (!document.profiles[candidate]) return candidate
  }
  throw new Error('unable to allocate provider id')
}

function normalizeProviderId(requested: string): string {
  return requested.trim().toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 100)
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
