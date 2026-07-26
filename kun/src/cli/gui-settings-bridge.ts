import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve, win32 } from 'node:path'
import { z } from 'zod'
import {
  KUN_CONFIG_FILENAME,
  ModelConfigSchema,
  KunServeConfigSchema,
  type ModelConfig,
  type KunServeConfig,
  type ServeProviderConfig
} from '../config/kun-config.js'
import {
  ModelCapabilityMetadata,
  type ModelCapabilityMetadata as ModelCapability
} from '../contracts/capabilities.js'
import {
  DEFAULT_MODEL_ENDPOINT_FORMAT,
  MODEL_ENDPOINT_FORMATS,
  type ModelEndpointFormat
} from '../contracts/model-endpoint-format.js'
import {
  ModelConnectionSnapshotSchema,
  type ModelConnectionSnapshot
} from '../contracts/model-connections.js'
import {
  RuntimeConfigApplyRequest,
  type RuntimeConfigApplyRequest as RuntimeConfigApplyPayload
} from '../contracts/runtime-config.js'
import {
  RuntimeInfoResponse,
  type RuntimeInfoResponse as RuntimeInfo
} from '../contracts/runtime-info.js'
import { modelCapabilitiesForProviderModel } from '../loop/model-context-profile.js'
import { readRuntimeDiscovery } from '../server/runtime-discovery.js'
import { isLoopbackHost } from '../server/loopback-host.js'

const MAX_GUI_SETTINGS_BYTES = 32 * 1024 * 1024
const LEGACY_PROVIDER_SOURCE_PREFIX = 'settings:provider:'
const GUI_PROVIDER_KINDS = [
  'http',
  'agent-sdk',
  'antigravity-cli',
  'cursor-sdk',
  'gemini-cli-api',
  'gemini-code-assist'
] as const

const GuiModelProfileSchema = ModelCapabilityMetadata.omit({ id: true }).extend({
  aliases: z.array(z.string().min(1).max(512)).max(100).optional()
})

const GuiProviderSchema = z.object({
  id: z.string().min(1).max(128),
  name: z.string().min(1).max(120).optional(),
  baseUrl: z.string().max(2_048).default(''),
  endpointFormat: z.enum(MODEL_ENDPOINT_FORMATS).default(DEFAULT_MODEL_ENDPOINT_FORMAT),
  kind: z.enum(GUI_PROVIDER_KINDS).default('http'),
  models: z.array(z.string().min(1).max(512)).max(500).default([]),
  modelProfiles: z.record(z.string().min(1).max(512), z.unknown()).optional()
})

const GuiSharedSettingsSchema = z.object({
  provider: z.object({
    // Provider transports evolve independently of the CLI compatibility
    // reader. Parse entries below so one future/invalid provider cannot make
    // this current settings file lose to an older candidate.
    providers: z.array(z.unknown()).max(500).default([])
  }).default({ providers: [] }),
  agents: z.object({
    kun: z.object({
      dataDir: z.string().min(1).max(4_096),
      model: z.string().max(512).default(''),
      providerId: z.string().max(128).default(''),
      port: z.number().int().min(1).max(65_535).default(18899),
      runtimeToken: z.string().max(64 * 1024).default('')
    })
  })
})

export type GuiProviderCatalog = Omit<z.infer<typeof GuiProviderSchema>, 'modelProfiles'> & {
  modelProfiles?: Record<string, z.infer<typeof GuiModelProfileSchema>>
}

export type GuiSharedSettings = {
  settingsPath: string
  dataDir: string
  defaultModel: string
  defaultProviderId: string
  providers: GuiProviderCatalog[]
  /** Used only to detect an older GUI runtime that has no discovery record. */
  legacyRuntimePort: number
  /** Secret-bearing compatibility value: never persist, log, or expose in UI. */
  legacyRuntimeToken: string
}

export type GuiConfigSyncResult = {
  changed: boolean
  config: { serve: KunServeConfig; models: ModelConfig }
  applyRequest: RuntimeConfigApplyPayload
}

export type GuiConfigSyncOptions = {
  /** Replace the GUI-managed provider catalog instead of only importing it. */
  authoritative?: boolean
  /** A protected binding has already been committed for every configured provider. */
  stripCredentials?: boolean
}

export type LegacyGuiRuntimeConnection = {
  baseUrl: string
  runtimeToken: string
  runtimeInfo: RuntimeInfo
}

export async function readGuiSharedSettings(input: {
  env?: Record<string, string | undefined>
  platform?: NodeJS.Platform
  homeDir?: string
} = {}): Promise<GuiSharedSettings | null> {
  const env = input.env ?? process.env
  const platform = input.platform ?? process.platform
  const homeDir = input.homeDir ?? homedir()
  const candidates = guiSettingsCandidates({ env, platform, homeDir })
  for (const settingsPath of candidates) {
    let raw: string
    try {
      const metadata = await stat(settingsPath)
      if (!metadata.isFile() || metadata.size > MAX_GUI_SETTINGS_BYTES) continue
      raw = await readFile(settingsPath, 'utf8')
    } catch {
      continue
    }
    let json: unknown
    try {
      json = JSON.parse(raw)
    } catch {
      continue
    }
    const parsed = GuiSharedSettingsSchema.safeParse(json)
    if (!parsed.success) continue
    const dataDir = expandConfiguredDataDir(parsed.data.agents.kun.dataDir, platform, homeDir)
    if (!dataDir) continue
    return {
      settingsPath,
      dataDir,
      defaultModel: parsed.data.agents.kun.model.trim(),
      defaultProviderId: parsed.data.agents.kun.providerId.trim(),
      legacyRuntimePort: parsed.data.agents.kun.port,
      legacyRuntimeToken: parsed.data.agents.kun.runtimeToken,
      providers: parsed.data.provider.providers.flatMap((value) => {
        const provider = GuiProviderSchema.safeParse(value)
        if (!provider.success) return []
        return [{
          ...provider.data,
          id: provider.data.id.trim(),
          name: provider.data.name?.trim() || provider.data.id.trim(),
          baseUrl: provider.data.baseUrl.trim(),
          models: uniqueModels(provider.data.models),
          modelProfiles: parseGuiModelProfiles(provider.data.modelProfiles)
        }]
      })
    }
  }
  return null
}

export async function hasUnpublishedGuiRuntime(
  settings: GuiSharedSettings,
  fetchImpl: typeof fetch = fetch
): Promise<boolean> {
  const discovery = await readRuntimeDiscovery(settings.dataDir).catch(() => null)
  if (discovery && await publishedRuntimeIsLive(discovery, fetchImpl)) return false
  return Boolean(await fetchLegacyGuiRuntimeInfo(settings, fetchImpl))
}

async function publishedRuntimeIsLive(
  discovery: Awaited<ReturnType<typeof readRuntimeDiscovery>>,
  fetchImpl: typeof fetch
): Promise<boolean> {
  if (!discovery) return false
  try {
    const url = new URL(discovery.baseUrl)
    if (
      url.protocol !== 'http:' ||
      !isLoopbackHost(url.hostname) ||
      !isLoopbackHost(discovery.host) ||
      Number(url.port || '80') !== discovery.port
    ) return false
    const response = await fetchImpl(`${discovery.baseUrl.replace(/\/$/u, '')}/v1/runtime/info`, {
      headers: discovery.runtimeToken
        ? { authorization: `Bearer ${discovery.runtimeToken}` }
        : {},
      signal: AbortSignal.timeout(2_000)
    })
    if (!response.ok) return false
    const info = RuntimeInfoResponse.parse(await response.json())
    return info.instanceId === discovery.instanceId &&
      info.pid === discovery.pid &&
      info.startedAt === discovery.startedAt &&
      info.serviceVersion === discovery.serviceVersion
  } catch {
    return false
  }
}

export async function resolveLegacyGuiRuntime(
  settings: GuiSharedSettings,
  fetchImpl: typeof fetch = fetch
): Promise<LegacyGuiRuntimeConnection | null> {
  if (await readRuntimeDiscovery(settings.dataDir).catch(() => null)) return null
  const body = await fetchLegacyGuiRuntimeInfo(settings, fetchImpl)
  if (!body) return null
  const parsed = RuntimeInfoResponse.safeParse({
    ...body,
    instanceId: typeof body.instanceId === 'string' && body.instanceId
      ? body.instanceId
      : `legacy-gui:${String(body.pid ?? body.startedAt ?? settings.legacyRuntimePort)}`,
    serviceVersion: typeof body.serviceVersion === 'string' && body.serviceVersion
      ? body.serviceVersion
      : 'legacy-gui',
    launchMode: body.launchMode ?? 'gui'
  })
  if (!parsed.success) return null
  return {
    baseUrl: `http://127.0.0.1:${settings.legacyRuntimePort}`,
    runtimeToken: settings.legacyRuntimeToken,
    runtimeInfo: parsed.data
  }
}

export function modelConnectionSnapshotFromGuiSettings(
  settings: GuiSharedSettings
): ModelConnectionSnapshot {
  const catalogs = settings.providers.filter((provider) => provider.id && provider.models.length > 0)
  const defaultProvider = catalogs.find((provider) => provider.id === settings.defaultProviderId) ??
    catalogs.find((provider) => provider.models.includes(settings.defaultModel)) ??
    catalogs[0]
  const defaultModel = defaultProvider
    ? (defaultProvider.models.includes(settings.defaultModel) ? settings.defaultModel : defaultProvider.models[0])
    : undefined
  return ModelConnectionSnapshotSchema.parse({
    schemaVersion: 1,
    revision: 0,
    providers: catalogs.map((provider) => ({
      id: provider.id,
      accountId: `account:${provider.id}`,
      name: provider.name ?? provider.id,
      presetSource: provider.id,
      kind: provider.kind,
      authType: legacyAuthType(provider),
      ...(httpUrl(provider.baseUrl) ? { baseUrl: provider.baseUrl } : {}),
      endpointFormat: provider.endpointFormat,
      configured: true,
      models: provider.models,
      modelCapabilities: Object.fromEntries(
        provider.models.map((model) => [model, guiModelCapability(provider, model)])
      ),
      selectedModel: provider.id === defaultProvider?.id ? defaultModel : provider.models[0]
    })),
    ...(defaultProvider
      ? {
          defaultProviderId: defaultProvider.id,
          defaultAccountId: `account:${defaultProvider.id}`,
          ...(defaultModel ? { defaultModel } : {})
        }
      : {}),
    proxy: { enabled: false, url: '' },
    routePools: [],
    localModelGateway: { enabled: false }
  })
}

function guiModelCapability(
  provider: GuiProviderCatalog,
  model: string
): ModelCapability {
  const configured = guiModelProfile(provider, model)
  const configuredCapability: Partial<Omit<ModelCapability, 'id'>> = configured
    ? (() => {
        const { aliases: _aliases, ...profile } = configured
        return profile
      })()
    : {}
  const builtIn = modelCapabilitiesForProviderModel({
    providerId: provider.id,
    presetSource: provider.id,
    baseUrl: provider.baseUrl,
    kind: provider.kind,
    model
  })
  const reasoning = shouldUseBuiltInReasoning(
    provider,
    model,
    configuredCapability.reasoning,
    builtIn.reasoning
  )
    ? builtIn.reasoning
    : configuredCapability.reasoning ?? builtIn.reasoning
  return ModelCapabilityMetadata.parse({
    ...builtIn,
    ...configuredCapability,
    id: model,
    ...(reasoning ? { reasoning } : {})
  })
}

function parseGuiModelProfiles(
  input: Record<string, unknown> | undefined
): Record<string, z.infer<typeof GuiModelProfileSchema>> | undefined {
  if (!input) return undefined
  const profiles = Object.fromEntries(Object.entries(input).flatMap(([model, value]) => {
    const parsed = GuiModelProfileSchema.safeParse(value)
    return parsed.success ? [[model.trim().toLowerCase(), parsed.data]] : []
  }))
  return Object.keys(profiles).length > 0 ? profiles : undefined
}

function guiModelProfile(
  provider: GuiProviderCatalog,
  model: string
): z.infer<typeof GuiModelProfileSchema> | undefined {
  const profiles = provider.modelProfiles
  if (!profiles) return undefined
  return profiles[model] ?? profiles[model.trim().toLowerCase()]
}

function shouldUseBuiltInReasoning(
  provider: Pick<GuiProviderCatalog, 'id' | 'endpointFormat'>,
  model: string,
  configured: ModelCapability['reasoning'],
  builtIn: ModelCapability['reasoning']
): boolean {
  const providerId = provider.id.toLowerCase()
  const normalizedModel = model.trim().toLowerCase()
  const knownChatResponsesMismatch =
    provider.endpointFormat === 'chat_completions' &&
    configured?.requestProtocol === 'openai-responses' &&
    builtIn?.requestProtocol === 'openai-chat-completions' &&
    (
      (providerId.includes('kimi-code') && normalizedModel === 'k3') ||
      (providerId.includes('opencode-go') && normalizedModel.endsWith('grok-4.5'))
    )
  return Boolean(
    knownChatResponsesMismatch ||
    (
      configured &&
      builtIn &&
      builtIn.requestProtocol !== 'none' &&
      configured.requestProtocol === 'none' &&
      configured.defaultEffort === 'auto' &&
      configured.supportedEfforts.every((effort) => effort === 'auto' || effort === 'off')
    )
  )
}

function projectGuiModelProfiles(
  existing: unknown,
  capabilities: Record<string, ModelCapability> | undefined
): Record<string, z.infer<typeof GuiModelProfileSchema>> {
  const current = isRecordValue(existing) ? existing : {}
  const projected: Record<string, z.infer<typeof GuiModelProfileSchema>> = {}
  for (const [model, profile] of Object.entries(current)) {
    const parsed = GuiModelProfileSchema.safeParse(profile)
    if (parsed.success) projected[model] = parsed.data
  }
  if (!capabilities) return projected
  for (const [model, capability] of Object.entries(capabilities)) {
    const { id: _id, ...profile } = capability
    projected[model] = GuiModelProfileSchema.parse({
      ...(projected[model] ?? {}),
      ...profile
    })
  }
  return projected
}

function guiModelProfilesForConfig(
  settings: GuiSharedSettings
): Record<string, z.infer<typeof GuiModelProfileSchema>> {
  const profiles: Record<string, z.infer<typeof GuiModelProfileSchema>> = {}
  for (const provider of settings.providers) {
    for (const model of provider.models) {
      const capability = guiModelCapability(provider, model)
      const configured = guiModelProfile(provider, model)
      const { id: _id, ...profile } = capability
      profiles[model.trim().toLowerCase()] = {
        ...profile,
        ...(configured?.aliases ? { aliases: [...configured.aliases] } : {})
      }
    }
  }
  return profiles
}

/**
 * Persist the registry's secret-free compatibility projection for GUI builds
 * that still read provider metadata from kun-settings.json. Existing rich
 * capability fields are retained by provider id, but every ordinary apiKey
 * field touched by this projection is cleared.
 */
export async function projectModelConnectionsToGuiSettings(
  settings: GuiSharedSettings,
  snapshot: ModelConnectionSnapshot,
  options: { protectedProviderIds?: ReadonlySet<string> } = {}
): Promise<GuiSharedSettings> {
  const metadata = await stat(settings.settingsPath)
  if (!metadata.isFile() || metadata.size > MAX_GUI_SETTINGS_BYTES) {
    throw new Error(`GUI settings file is unavailable: ${settings.settingsPath}`)
  }
  const parsed = JSON.parse(await readFile(settings.settingsPath, 'utf8')) as unknown
  if (!isRecordValue(parsed)) throw new Error('GUI settings must be a JSON object')
  const providerSettings = isRecordValue(parsed.provider) ? { ...parsed.provider } : {}
  const existingProviders = Array.isArray(providerSettings.providers)
    ? providerSettings.providers.filter(isRecordValue)
    : []
  const existingById = new Map(existingProviders
    .map((provider) => [typeof provider.id === 'string' ? provider.id.trim() : '', provider] as const)
    .filter(([id]) => Boolean(id)))
  const providers = snapshot.providers.map((profile) => {
    const existing = existingById.get(profile.id) ?? {}
    return {
      ...existing,
      id: profile.id,
      name: profile.name,
      apiKey: (options.protectedProviderIds ? options.protectedProviderIds.has(profile.id) : true)
        ? ''
        : typeof existing.apiKey === 'string' ? existing.apiKey : '',
      baseUrl: profile.baseUrl ?? '',
      endpointFormat: profile.endpointFormat,
      kind: profile.kind,
      models: [...profile.models],
      modelProfiles: projectGuiModelProfiles(existing.modelProfiles, profile.modelCapabilities)
    }
  })
  const agents = isRecordValue(parsed.agents) ? { ...parsed.agents } : {}
  const kun = isRecordValue(agents.kun) ? { ...agents.kun } : {}
  const next = {
    ...parsed,
    provider: {
      ...providerSettings,
      apiKey: snapshot.defaultProviderId && (options.protectedProviderIds
        ? options.protectedProviderIds.has(snapshot.defaultProviderId)
        : true)
        ? ''
        : typeof providerSettings.apiKey === 'string' ? providerSettings.apiKey : '',
      providers
    },
    agents: {
      ...agents,
      kun: {
        ...kun,
        providerId: snapshot.defaultProviderId ?? '',
        model: snapshot.defaultModel ?? ''
      }
    }
  }
  await writeAtomicOwnerOnly(settings.settingsPath, `${JSON.stringify(next, null, 2)}\n`)
  return {
    ...settings,
    defaultProviderId: snapshot.defaultProviderId ?? '',
    defaultModel: snapshot.defaultModel ?? '',
    providers: snapshot.providers.map((profile) => ({
      id: profile.id,
      name: profile.name,
      baseUrl: profile.baseUrl ?? '',
      endpointFormat: profile.endpointFormat,
      kind: profile.kind,
      models: [...profile.models],
      modelProfiles: projectGuiModelProfiles(undefined, profile.modelCapabilities)
    }))
  }
}

/**
 * Keep GUI-compatible defaults aligned with the registry without projecting
 * catalogs or touching provider credential fields.
 */
export async function projectModelSelectionToGuiSettings(
  settings: GuiSharedSettings,
  snapshot: Pick<ModelConnectionSnapshot, 'defaultProviderId' | 'defaultModel'>
): Promise<GuiSharedSettings> {
  const providerId = snapshot.defaultProviderId ?? ''
  const model = snapshot.defaultModel ?? ''
  if (settings.defaultProviderId === providerId && settings.defaultModel === model) {
    return settings
  }
  const metadata = await stat(settings.settingsPath)
  if (!metadata.isFile() || metadata.size > MAX_GUI_SETTINGS_BYTES) {
    throw new Error(`GUI settings file is unavailable: ${settings.settingsPath}`)
  }
  const parsed = JSON.parse(await readFile(settings.settingsPath, 'utf8')) as unknown
  if (!isRecordValue(parsed)) throw new Error('GUI settings must be a JSON object')
  const agents = isRecordValue(parsed.agents) ? { ...parsed.agents } : {}
  const kun = isRecordValue(agents.kun) ? { ...agents.kun } : {}
  const currentProviderId = typeof kun.providerId === 'string' ? kun.providerId : ''
  const currentModel = typeof kun.model === 'string' ? kun.model : ''
  if (currentProviderId !== providerId || currentModel !== model) {
    await writeAtomicOwnerOnly(settings.settingsPath, `${JSON.stringify({
      ...parsed,
      agents: {
        ...agents,
        kun: {
          ...kun,
          providerId,
          model
        }
      }
    }, null, 2)}\n`)
  }
  return {
    ...settings,
    defaultProviderId: providerId,
    defaultModel: model
  }
}

async function fetchLegacyGuiRuntimeInfo(
  settings: GuiSharedSettings,
  fetchImpl: typeof fetch
): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetchImpl(
      `http://127.0.0.1:${settings.legacyRuntimePort}/v1/runtime/info`,
      {
        headers: settings.legacyRuntimeToken
          ? { authorization: `Bearer ${settings.legacyRuntimeToken}` }
          : {},
        signal: AbortSignal.timeout(2_000)
      }
    )
    if (!response.ok) return null
    const body = await response.json().catch(() => null)
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null
    const record = body as Record<string, unknown>
    return typeof record.dataDir === 'string' && samePath(record.dataDir, settings.dataDir)
      ? record
      : null
  } catch {
    return null
  }
}

export async function syncGuiProviderCatalogToConfig(
  dataDir: string,
  settings: GuiSharedSettings,
  options: GuiConfigSyncOptions = {}
): Promise<GuiConfigSyncResult | null> {
  if (!samePath(dataDir, settings.dataDir)) return null
  const configPath = join(dataDir, KUN_CONFIG_FILENAME)
  const existing = await readConfigDocument(configPath)
  const parsedServe = KunServeConfigSchema.safeParse(existing.serve ?? {})
  if (!parsedServe.success) {
    throw new Error(
      `invalid serve config at ${configPath}: ${parsedServe.error.issues.map((issue) => issue.message).join('; ')}`
    )
  }
  const existingServe = parsedServe.data
  const providers: Record<string, ServeProviderConfig> = options.authoritative
    ? {}
    : { ...(existingServe.providers ?? {}) }

  for (const provider of settings.providers) {
    if (!provider.id || provider.models.length === 0) continue
    const current = providers[provider.id]
    const kind = provider.kind ?? current?.kind ?? 'http'
    const baseUrl = provider.baseUrl || current?.baseUrl
    if (kind !== 'agent-sdk' && !baseUrl) continue
    const selectedModel = preferredModel({
      providerId: provider.id,
      models: provider.models,
      current: current?.selectedModel,
      defaultProviderId: settings.defaultProviderId,
      defaultModel: settings.defaultModel
    })
    providers[provider.id] = {
      ...current,
      kind,
      apiKey: options.stripCredentials ? '' : current?.apiKey ?? '',
      credentialSourceId: current?.credentialSourceId ?? credentialSourceId(provider.id),
      ...(baseUrl ? { baseUrl } : {}),
      endpointFormat: provider.endpointFormat ?? current?.endpointFormat ?? DEFAULT_MODEL_ENDPOINT_FORMAT,
      models: provider.models,
      modelCapabilities: Object.fromEntries(
        provider.models.map((model) => [model, guiModelCapability(provider, model)])
      ),
      ...(selectedModel ? { selectedModel } : {})
    }
  }

  const inferredDefaultProviderId = inferDefaultProviderId(settings, existingServe, providers)
  const defaultProvider = inferredDefaultProviderId ? providers[inferredDefaultProviderId] : undefined
  const defaultModel = preferredModel({
    providerId: inferredDefaultProviderId,
    models: defaultProvider?.models ?? [],
    current: existingServe.model,
    defaultProviderId: settings.defaultProviderId || inferredDefaultProviderId,
    defaultModel: settings.defaultModel
  })
  const nextServe = KunServeConfigSchema.parse({
    ...existingServe,
    ...(options.authoritative ? { providers: {}, credentialSourceId: undefined } : {}),
    ...(options.stripCredentials ? { apiKey: '' } : {}),
    providers,
    ...(defaultProvider && inferredDefaultProviderId
      ? {
          credentialSourceId: credentialSourceId(inferredDefaultProviderId),
          ...(defaultProvider.baseUrl ? { baseUrl: defaultProvider.baseUrl } : {}),
          endpointFormat: defaultProvider.endpointFormat ?? existingServe.endpointFormat,
          ...(defaultModel ? { model: defaultModel } : {})
        }
      : {})
  })
  const existingModels = isRecordValue(existing.models) ? existing.models : {}
  const existingProfiles = isRecordValue(existingModels.profiles)
    ? existingModels.profiles
    : {}
  const nextModels = ModelConfigSchema.parse({
    ...existingModels,
    profiles: {
      ...existingProfiles,
      ...guiModelProfilesForConfig(settings)
    }
  })
  // Preserve capability sections written by a newer GUI. This bridge owns
  // only serve/provider metadata and must not erase forward-compatible fields.
  const nextDocument = { ...existing, serve: nextServe, models: nextModels }
  const nextText = `${JSON.stringify(nextDocument, null, 2)}\n`
  let currentText = ''
  try {
    currentText = await readFile(configPath, 'utf8')
  } catch {
    // The first standalone TUI launch creates the shared config.
  }
  const changed = currentText !== nextText
  if (changed) await writeAtomicOwnerOnly(configPath, nextText)
  return {
    changed,
    config: { serve: nextServe, models: nextModels },
    applyRequest: runtimeApplyRequest(
      nextServe,
      nextModels,
      inferredDefaultProviderId && defaultModel
        ? { providerId: inferredDefaultProviderId, model: defaultModel }
        : undefined
    )
  }
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function guiSettingsCandidates(input: {
  env: Record<string, string | undefined>
  platform: NodeJS.Platform
  homeDir: string
}): string[] {
  const explicit = input.env.KUN_GUI_SETTINGS_PATH?.trim()
  if (explicit) return [expandTilde(explicit, input.homeDir)]
  if (input.platform === 'darwin') {
    return guiSettingsUnder(join(input.homeDir, 'Library', 'Application Support'))
  }
  if (input.platform === 'win32') {
    const appData = input.env.APPDATA?.trim()
    return appData ? guiSettingsUnder(appData) : []
  }
  const configRoot = input.env.XDG_CONFIG_HOME?.trim() || join(input.homeDir, '.config')
  return guiSettingsUnder(configRoot)
}

function guiSettingsUnder(root: string): string[] {
  return ['Kun', 'DeepSeek GUI', 'deepseek-gui'].flatMap((name) => [
    join(root, name, 'kun-settings.json'),
    join(root, name, 'deepseek-gui-settings.json')
  ])
}

function expandConfiguredDataDir(
  value: string,
  platform: NodeJS.Platform,
  homeDir: string
): string | null {
  const expanded = expandTilde(value.trim(), homeDir)
  const absolute = platform === 'win32' ? win32.isAbsolute(expanded) : isAbsolute(expanded)
  return absolute ? expanded : null
}

function expandTilde(value: string, homeDir: string): string {
  if (value === '~') return homeDir
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return join(homeDir, value.slice(2).replace(/\\/g, '/'))
  }
  return value
}

function inferDefaultProviderId(
  settings: GuiSharedSettings,
  serve: KunServeConfig,
  providers: Record<string, ServeProviderConfig>
): string {
  if (settings.defaultProviderId && providers[settings.defaultProviderId]) {
    return settings.defaultProviderId
  }
  const source = serve.credentialSourceId?.trim() ?? ''
  if (source.startsWith(LEGACY_PROVIDER_SOURCE_PREFIX)) {
    const providerId = source.slice(LEGACY_PROVIDER_SOURCE_PREFIX.length).trim()
    if (providers[providerId]) return providerId
  }
  const matchingModel = settings.defaultModel
    ? Object.entries(providers).find(([, provider]) => provider.models?.includes(settings.defaultModel))?.[0]
    : undefined
  return matchingModel ?? Object.keys(providers)[0] ?? ''
}

function preferredModel(input: {
  providerId: string
  models: readonly string[]
  current?: string
  defaultProviderId: string
  defaultModel: string
}): string | undefined {
  if (
    input.providerId === input.defaultProviderId &&
    input.defaultModel &&
    input.models.includes(input.defaultModel)
  ) return input.defaultModel
  if (input.current && input.models.includes(input.current)) return input.current
  return input.models[0]
}

function credentialSourceId(providerId: string): string {
  return `${LEGACY_PROVIDER_SOURCE_PREFIX}${providerId}`
}

function uniqueModels(models: readonly string[]): string[] {
  return [...new Set(models.map((model) => model.trim()).filter(Boolean))]
}

function legacyAuthType(provider: GuiProviderCatalog): 'api-key' | 'subscription' {
  const id = provider.id.toLowerCase()
  return provider.kind === 'agent-sdk' ||
    provider.kind === 'antigravity-cli' ||
    provider.kind === 'cursor-sdk' ||
    id.includes('subscription') ||
    id.includes('token-plan') ||
    id === 'kimi-code' ||
    id === 'opencode-go'
    ? 'subscription'
    : 'api-key'
}

function httpUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

function samePath(left: string, right: string): boolean {
  const resolvedLeft = resolve(left)
  const resolvedRight = resolve(right)
  return process.platform === 'win32'
    ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
    : resolvedLeft === resolvedRight
}

function runtimeApplyRequest(
  serve: KunServeConfig,
  models: ModelConfig,
  modelSelection?: {
    providerId: string
    model: string
  }
): RuntimeConfigApplyPayload {
  const {
    host: _host,
    port: _port,
    dataDir: _dataDir,
    runtimeToken: _runtimeToken,
    insecure: _insecure,
    storage: _storage,
    ...hotServe
  } = serve
  void _host
  void _port
  void _dataDir
  void _runtimeToken
  void _insecure
  void _storage
  return RuntimeConfigApplyRequest.parse({
    serve: hotServe,
    models,
    ...(modelSelection ? { modelSelection } : {})
  })
}

async function readConfigDocument(path: string): Promise<Record<string, unknown>> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (String((error as { code?: unknown })?.code ?? '') === 'ENOENT') return {}
    throw error
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new Error(`failed to parse ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`invalid Kun config object at ${path}`)
  }
  return value as Record<string, unknown>
}

async function writeAtomicOwnerOnly(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await chmod(dirname(path), 0o700).catch(() => undefined)
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temporary, text, { encoding: 'utf8', mode: 0o600 })
  try {
    await rename(temporary, path)
    await chmod(path, 0o600).catch(() => undefined)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}
