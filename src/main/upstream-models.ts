import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  getModelProviderSettings,
  getModelProviderProfile,
  isComposerChatModelId,
  isProviderComposerChatModelId,
  listModelProviderModelIds,
  listNonTextModelIds,
  modelProviderModelProfile,
  projectExecutableModelRoutePools,
  resolveKunRuntimeSettings,
  type AppSettingsV1,
  type ModelProviderModelProfileV1
} from '../shared/app-settings'
import { DEFAULT_COMPOSER_MODEL_IDS } from '../shared/default-composer-models'
import type {
  ModelProviderModelGroup,
  ModelProviderModelSelection
} from '../shared/kun-gui-api'
import { assertManagedKunDataDirIsCurrent } from './kun-data-dir-paths'

export type FetchUpstreamModelsResult =
  | {
      ok: true
      modelIds: string[]
      /** @deprecated Use defaultModel so the provider binding is not ambiguous. */
      defaultModelId?: string
      defaultModel?: ModelProviderModelSelection
      modelGroups?: ModelProviderModelGroup[]
    }
  | { ok: false; message: string }

export function fallbackModelIds(): string[] {
  return sortComposerModelIds(DEFAULT_COMPOSER_MODEL_IDS)
}

/**
 * Builds the model list the composer picker shows. Despite the historical name,
 * this intentionally mirrors only the models the user has explicitly added to
 * each provider (`provider.models`) — it does NOT query the provider's full
 * upstream `GET /v1/models` catalog.
 *
 * Pulling the whole catalog (issue #337) buried the few configured models under
 * hundreds of upstream ids (e.g. every OpenRouter / Aliyun model) and surfaced
 * ids that error when actually used. Custom-endpoint providers never triggered
 * it, which is why only preset providers were affected. Discover and add
 * upstream models deliberately via "从 API 拉取" (probeModelProvider) in
 * Settings instead.
 *
 * The second argument is kept for call-site compatibility; the upstream key is
 * no longer needed here.
 */
export async function fetchUpstreamModelIds(
  settings: AppSettingsV1,
  _apiKey?: string
): Promise<FetchUpstreamModelsResult> {
  const configuredModelIds = await readConfiguredKunModelIds(settings)
  const configuredGroups = await readConfiguredModelGroups(settings)
  const runtime = resolveKunRuntimeSettings(settings)
  const runtimeModel = runtime.model.trim()
  const runtimeProvider = getModelProviderProfile(settings, runtime.providerId)
  const defaultModel = isProviderComposerChatModelId(runtimeProvider, runtimeModel)
    ? { providerId: runtimeProvider.id, modelId: runtimeModel }
    : undefined
  return modelListOrError(
    configuredModelIds,
    configuredGroups,
    defaultModel,
    'Configured providers have no usable text models yet.'
  )
}

export async function readConfiguredKunModelIds(settings: AppSettingsV1): Promise<string[]> {
  const runtime = resolveKunRuntimeSettings(settings)
  const dataDir = expandHome(runtime.dataDir)
  assertManagedKunDataDirIsCurrent(dataDir)
  const configPath = join(dataDir, 'config.json')
  const nonTextModelIds = listNonTextModelIds(settings)
  const ids = [
    ...(isComposerChatModelId(runtime.model, nonTextModelIds) ? [runtime.model] : []),
    ...listModelProviderModelIds(settings)
  ]
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(configPath, 'utf8')) as unknown
  } catch {
    return mergeModelIds(ids)
  }
  const root = objectValue(parsed)
  const models = objectValue(root.models)
  const contextCompaction = objectValue(root.contextCompaction)
  return mergeModelIds([
    ...ids,
    ...modelIdsFromProfiles(objectValue(contextCompaction.modelProfiles), nonTextModelIds),
    ...modelIdsFromProfiles(objectValue(models.profiles), nonTextModelIds)
  ])
}

function modelListOrError(
  ids: readonly string[],
  groups: readonly ModelProviderModelGroup[],
  defaultModel: ModelProviderModelSelection | undefined,
  message: string
): FetchUpstreamModelsResult {
  return hasCustomModelId(ids)
    ? {
        ok: true,
        modelIds: mergeModelIds(ids),
        ...(defaultModel
          ? { defaultModelId: defaultModel.modelId, defaultModel }
          : {}),
        modelGroups: mergeModelGroups(groups)
      }
    : { ok: false, message }
}

async function readConfiguredModelGroups(settings: AppSettingsV1): Promise<ModelProviderModelGroup[]> {
  const groups: ModelProviderModelGroup[] = []
  for (const provider of getModelProviderSettings(settings).providers) {
    const modelIds = provider.models.filter((id) => isProviderComposerChatModelId(provider, id))
    if (modelIds.length === 0) continue
    groups.push({
      providerId: provider.id,
      label: provider.name,
      modelIds,
      modelProfiles: provider.modelProfiles
    })
  }
  const providerSettings = getModelProviderSettings(settings)
  const routeModelIds: string[] = []
  const routeModelProfiles: Record<string, ModelProviderModelProfileV1> = {}
  for (const pool of projectExecutableModelRoutePools(providerSettings)) {
    if (!pool.enabled || pool.targets.length === 0) continue
    const profiles = pool.targets.flatMap((target) => {
      const provider = providerSettings.providers.find((candidate) => candidate.id === target.providerId)
      return provider ? [modelProviderModelProfile(provider, target.modelId) ?? {
        inputModalities: ['text'],
        outputModalities: ['text'],
        supportsToolCalling: true,
        messageParts: ['text']
      } satisfies ModelProviderModelProfileV1] : []
    })
    if (profiles.length === 0) continue
    const inputModalities = [...new Set(profiles.flatMap((profile) => profile.inputModalities))]
    const outputModalities = [...new Set(profiles.flatMap((profile) => profile.outputModalities))]
    const messageParts = [...new Set(profiles.flatMap((profile) => profile.messageParts))]
    routeModelIds.push(pool.modelId)
    routeModelProfiles[pool.modelId] = {
      inputModalities,
      outputModalities,
      messageParts,
      supportsToolCalling: profiles.some((profile) => profile.supportsToolCalling),
      contextWindowTokens: Math.max(...profiles.map((profile) => profile.contextWindowTokens ?? 0)) || undefined,
      maxOutputTokens: Math.max(...profiles.map((profile) => profile.maxOutputTokens ?? 0)) || undefined
    }
  }
  if (routeModelIds.length > 0) {
    groups.push({
      providerId: 'route-gateway:local',
      label: providerSettings.localGateway.name,
      modelIds: routeModelIds,
      modelProfiles: routeModelProfiles
    })
  }
  return mergeModelGroups(groups)
}

function mergeModelGroups(groups: readonly ModelProviderModelGroup[]): ModelProviderModelGroup[] {
  const byProvider = new Map<string, ModelProviderModelGroup>()
  for (const group of groups) {
    const providerId = group.providerId.trim()
    if (!providerId) continue
    const existing = byProvider.get(providerId)
    const modelIds = sortComposerModelIds([
      ...(existing?.modelIds ?? []),
      ...group.modelIds
    ])
    byProvider.set(providerId, {
      providerId,
      label: group.label.trim() || providerId,
      modelIds,
      modelProfiles: {
        ...(existing?.modelProfiles ?? {}),
        ...(group.modelProfiles ?? {})
      }
    })
  }
  return [...byProvider.values()].filter((group) => group.modelIds.length > 0)
}

function modelIdsFromProfiles(
  profiles: Record<string, unknown>,
  nonTextModelIds: readonly string[] = []
): string[] {
  const ids: string[] = []
  for (const [modelId, rawProfile] of Object.entries(profiles)) {
    const trimmed = modelId.trim()
    if (trimmed && isComposerChatModelId(trimmed, nonTextModelIds)) ids.push(trimmed)
    const aliases = objectValue(rawProfile).aliases
    if (Array.isArray(aliases)) {
      for (const alias of aliases) {
        if (typeof alias !== 'string') continue
        const trimmedAlias = alias.trim()
        if (trimmedAlias && isComposerChatModelId(trimmedAlias, nonTextModelIds)) ids.push(trimmedAlias)
      }
    }
  }
  return ids
}

function mergeModelIds(ids: readonly string[]): string[] {
  return sortComposerModelIds([...DEFAULT_COMPOSER_MODEL_IDS, ...ids])
}

function hasCustomModelId(ids: readonly string[]): boolean {
  const defaults = new Set<string>(DEFAULT_COMPOSER_MODEL_IDS)
  return ids.some((id) => {
    const trimmed = id.trim()
    return trimmed !== '' && !defaults.has(trimmed as typeof DEFAULT_COMPOSER_MODEL_IDS[number])
  })
}

function sortComposerModelIds(ids: readonly string[]): string[] {
  const ordered = new Set<string>()
  for (const id of ids) {
    const trimmed = id.trim()
    if (trimmed && trimmed !== 'auto') ordered.add(trimmed)
  }
  return [...ordered].sort((a, b) => a.localeCompare(b))
}

function expandHome(path: string): string {
  return path.startsWith('~') ? path.replace(/^~(?=$|[\\/])/, homedir()) : path
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
