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

const StoredProfileSchema = ModelConnectionSnapshotSchema.shape.providers.element.extend({
  credentialRef: z.string().min(1).max(256).optional(),
  headers: z.record(z.string(), z.string()).optional()
})
const RegistryDocumentSchema = z.object({
  schemaVersion: z.literal(1),
  revision: z.number().int().nonnegative(),
  profiles: z.record(z.string(), StoredProfileSchema),
  defaultProviderId: z.string().min(1).optional(),
  defaultAccountId: z.string().min(1).optional(),
  defaultModel: z.string().min(1).optional(),
  proxy: ModelConnectionSnapshotSchema.shape.proxy,
  routePools: ModelConnectionSnapshotSchema.shape.routePools,
  localModelGateway: ModelConnectionSnapshotSchema.shape.localModelGateway
}).strict()
type RegistryDocument = z.infer<typeof RegistryDocumentSchema>
type StoredProfile = z.infer<typeof StoredProfileSchema>

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

  constructor(private readonly options: {
    dataDir: string
    credentials: ExtensionCredentialStore
    modelCapabilities?: (
      model: string,
      profile?: Pick<ModelConnectionProfile, 'id' | 'presetSource' | 'baseUrl' | 'kind'>
    ) => ModelCapabilityMetadata
    onChanged?: (connections: MaterializedModelConnections) => Promise<void> | void
  }) {
    this.file = new AtomicJsonFile(
      join(options.dataDir, 'model-connections.v1.json'),
      (value) => RegistryDocumentSchema.parse(value)
    )
  }

  async initialize(
    seed: readonly ModelConnectionConnectRequest[] = [],
    globals?: {
      proxy?: RegistryDocument['proxy']
      routePools?: RegistryDocument['routePools']
      localModelGateway?: RegistryDocument['localModelGateway']
    }
  ): Promise<ModelConnectionSnapshot> {
    let current = await this.file.read(emptyDocument)
    const newRegistry = Object.keys(current.profiles).length === 0
    if (seed.length > 0) {
      for (const input of seed) {
        const request = ModelConnectionConnectRequestSchema.parse({
          ...input,
          expectedRevision: current.revision,
          probe: false
        })
        const existing = request.id ? current.profiles[request.id] : undefined
        if (!existing) {
          // A non-empty registry is authoritative for the current default, but
          // GUI-managed providers that were never imported must still become
          // visible to standalone TUI clients.
          await this.connect({ ...request, select: newRegistry ? request.select : false })
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
    await this.apply(current)
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
    const input = ModelConnectionConnectRequestSchema.parse(raw)
    if (input.kind === 'http' && !input.baseUrl) throw new Error('baseUrl is required for HTTP providers')
    const models = input.probe && input.kind === 'http'
      ? await this.probeInput(input)
      : uniqueModels(input.models)
    const credential = input.credential?.trim() ?? ''
    const credentialRef = credential
      ? await this.options.credentials.create({ apiKey: credential })
      : undefined
    try {
      const document = await this.file.update(emptyDocument, (current) => {
        assertRevision(current, input.expectedRevision, this.options.modelCapabilities)
        const id = allocateId(current, input.id ?? input.name)
        const accountId = `account:${id}`
        const selectedModel = input.selectedModel ?? models[0]
        const profile = StoredProfileSchema.parse({
          id,
          accountId,
          name: input.name,
          presetSource: input.presetSource,
          kind: input.kind,
          authType: input.authType,
          baseUrl: input.baseUrl,
          endpointFormat: input.endpointFormat,
          configured: Boolean(credentialRef) ||
            input.kind === 'agent-sdk' ||
            input.kind === 'antigravity-cli',
          models,
          ...(input.modelCapabilities
            ? { modelCapabilities: capabilitiesForModels(input.modelCapabilities, models) }
            : {}),
          selectedModel,
          credentialRef
        })
        return {
          ...current,
          revision: current.revision + 1,
          profiles: { ...current.profiles, [id]: profile },
          ...(input.select && selectedModel ? {
            defaultProviderId: id,
            defaultAccountId: accountId,
            defaultModel: selectedModel
          } : {})
        }
      })
      await this.changed(document)
      return this.project(document)
    } catch (error) {
      if (credentialRef) await this.options.credentials.delete(credentialRef).catch(() => undefined)
      throw error
    }
  }

  async patch(providerId: string, raw: unknown): Promise<ModelConnectionSnapshot> {
    const input = ModelConnectionPatchRequestSchema.parse(raw)
    const { expectedRevision: _expectedRevision, ...changes } = input
    const document = await this.file.update(emptyDocument, (current) => {
      assertRevision(current, input.expectedRevision, this.options.modelCapabilities)
      const profile = requireProfile(current, providerId)
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
    try {
      const document = await this.file.update(emptyDocument, (current) => {
        assertRevision(current, input.expectedRevision, this.options.modelCapabilities)
        const profile = requireProfile(current, providerId)
        previousRef = profile.credentialRef
        return {
          ...current,
          revision: current.revision + 1,
          profiles: {
            ...current.profiles,
            [providerId]: { ...profile, credentialRef: nextRef, configured: true }
          }
        }
      })
      await this.changed(document)
      if (previousRef) await this.options.credentials.delete(previousRef).catch(() => undefined)
      return this.project(document)
    } catch (error) {
      await this.options.credentials.delete(nextRef).catch(() => undefined)
      throw error
    }
  }

  async delete(providerId: string, expectedRevision: number): Promise<ModelConnectionSnapshot> {
    let credentialRef: string | undefined
    const document = await this.file.update(emptyDocument, (current) => {
      assertRevision(current, expectedRevision, this.options.modelCapabilities)
      const profile = requireProfile(current, providerId)
      credentialRef = profile.credentialRef
      const profiles = { ...current.profiles }
      delete profiles[providerId]
      const remaining = Object.values(profiles)
      const fallback = remaining.find((candidate) => candidate.configured && candidate.selectedModel) ??
        remaining.find((candidate) => candidate.configured && candidate.models.length > 0)
      return {
        schemaVersion: 1,
        revision: current.revision + 1,
        profiles,
        proxy: current.proxy,
        routePools: current.routePools,
        localModelGateway: current.localModelGateway,
        ...(current.defaultProviderId === providerId
          ? fallback?.selectedModel ? {
              defaultProviderId: fallback.id,
              defaultAccountId: fallback.accountId,
              defaultModel: fallback.selectedModel
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
    return this.project(document)
  }

  async select(raw: unknown): Promise<ModelConnectionSnapshot> {
    const input = ModelConnectionSelectRequestSchema.parse(raw)
    const document = await this.file.update(emptyDocument, (current) => {
      assertRevision(current, input.expectedRevision, this.options.modelCapabilities)
      const profile = requireProfile(current, input.providerId)
      if (!profile.configured) throw new Error('provider is not connected')
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
    const models = await probeModels({
      baseUrl: profile.baseUrl,
      apiKey: credential?.apiKey ?? '',
      fallbackModels: profile.models
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

  async materialize(): Promise<MaterializedModelConnections> {
    const document = await this.file.read(emptyDocument)
    const providers = new Map<string, ServeProviderConfig>()
    let selected: MaterializedModelConnections['selected']
    for (const profile of Object.values(document.profiles)) {
      const credential = profile.credentialRef
        ? await this.options.credentials.get(profile.credentialRef)
        : null
      const material = materializeLegacyProviderCredential(credential?.apiKey ?? '')
      const config: ServeProviderConfig =
        profile.kind === 'agent-sdk' ||
        profile.kind === 'antigravity-cli' ||
        profile.kind === 'cursor-sdk'
        ? {
            kind: profile.kind,
            apiKey: material.apiKey,
            models: [...profile.models],
            ...(profile.modelCapabilities ? { modelCapabilities: profile.modelCapabilities } : {}),
            ...(profile.selectedModel ? { selectedModel: profile.selectedModel } : {})
          }
        : profile.kind === 'gemini-code-assist'
          ? {
              kind: 'gemini-code-assist',
              apiKey: material.apiKey,
              baseUrl: profile.baseUrl!,
              endpointFormat: profile.endpointFormat,
              models: [...profile.models],
              ...(profile.modelCapabilities ? { modelCapabilities: profile.modelCapabilities } : {}),
              ...(profile.selectedModel ? { selectedModel: profile.selectedModel } : {}),
              ...(material.geminiAuth ? { geminiAuth: material.geminiAuth } : {})
            }
          : {
              kind: 'http',
              apiKey: material.apiKey,
              baseUrl: profile.baseUrl!,
              endpointFormat: profile.endpointFormat,
              models: [...profile.models],
              ...(profile.modelCapabilities ? { modelCapabilities: profile.modelCapabilities } : {}),
              ...(profile.selectedModel ? { selectedModel: profile.selectedModel } : {}),
              ...(material.headers || profile.headers
                ? { headers: { ...(profile.headers ?? {}), ...(material.headers ?? {}) } }
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
      baseUrl: input.baseUrl,
      apiKey: input.credential?.trim() ?? '',
      fallbackModels: input.models
    })
  }

  private async apply(_document: RegistryDocument): Promise<void> {
    await this.options.onChanged?.(await this.materialize())
  }

  private async changed(document: RegistryDocument): Promise<void> {
    await this.apply(document)
    const snapshot = this.project(document)
    for (const listener of this.listeners) listener(snapshot)
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
    proxy: { enabled: false, url: '' },
    routePools: [],
    localModelGateway: { enabled: false }
  }
}

function reconcileSeedProfile(
  existing: StoredProfile,
  request: ModelConnectionConnectRequest
): StoredProfile {
  const incomingModels = uniqueModels([
    ...request.models,
    ...(request.selectedModel ? [request.selectedModel] : [])
  ])
  // Early registry builds seeded every secondary provider with the active
  // DeepSeek model. Recognize that one-value signature and replace it with the
  // provider's real GUI catalog; otherwise only add missing models so
  // registry-owned edits are not discarded.
  const repairLegacySeed = incomingModels.length > 0 &&
    existing.models.length === 1 &&
    !incomingModels.includes(existing.models[0]!) &&
    existing.selectedModel === existing.models[0]
  const models = incomingModels.length === 0
    ? existing.models
    : repairLegacySeed
      ? incomingModels
      : uniqueModels([...existing.models, ...incomingModels])
  const selectedModel = repairLegacySeed
    ? request.selectedModel ?? models[0]
    : request.select && request.selectedModel
      ? request.selectedModel
      : existing.selectedModel ?? request.selectedModel ?? models[0]
  const modelCapabilities = request.modelCapabilities
    ? capabilitiesForModels(request.modelCapabilities, models)
    : existing.modelCapabilities
  const migrateGeminiSubscription =
    existing.id === 'gemini-subscription' &&
    existing.kind === 'gemini-code-assist' &&
    request.kind === 'antigravity-cli'

  return StoredProfileSchema.parse({
    ...existing,
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
      .map(({ credentialRef: _credentialRef, headers: _headers, ...profile }) => {
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
  if (!derived?.reasoning || stored.reasoning === derived.reasoning) return stored
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
    return { ...stored, reasoning: derived.reasoning }
  }
  return stored
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
  const base = requested.trim().toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 100) || 'provider'
  if (!document.profiles[base]) return base
  for (let index = 2; index < 10_000; index += 1) {
    const candidate = `${base}-${index}`
    if (!document.profiles[candidate]) return candidate
  }
  throw new Error('unable to allocate provider id')
}

function uniqueModels(models: readonly string[]): string[] {
  return [...new Set(models.map((model) => model.trim()).filter(Boolean))]
}

function sameModels(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((model, index) => model === right[index])
}

async function probeModels(input: {
  baseUrl?: string
  apiKey: string
  fallbackModels: readonly string[]
}): Promise<string[]> {
  if (!input.baseUrl) return uniqueModels(input.fallbackModels)
  const url = modelsUrl(input.baseUrl)
  const response = await fetch(url, {
    headers: input.apiKey ? { authorization: `Bearer ${input.apiKey}` } : {},
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

function modelsUrl(baseUrl: string): string {
  const url = new URL(baseUrl)
  url.search = ''
  url.hash = ''
  url.pathname = url.pathname
    .replace(/\/(chat\/completions|responses|messages)\/?$/u, '')
    .replace(/\/$/u, '') + '/models'
  return url.toString()
}
