import {
  DEFAULT_MODEL_PROVIDER_ID,
  KUN_TOOL_PERMISSION_MODES,
  MODEL_PROVIDER_PRESETS,
  applyKunRuntimePatch,
  getKunRuntimeSettings,
  getModelProviderSettings,
  kunToolPermissionModeFromSettings,
  kunToolPermissionModeSettings,
  modelProviderPresetProfile,
  modelProviderTokenPlanProfile,
  normalizeAppSettings,
  tokenPlanProviderId,
  type AppSettingsPatch,
  type AppSettingsV1,
  type KunToolPermissionMode,
  type KunRuntimeSettingsPatchV1,
  type ModelProviderPreset,
  type ModelProviderProfileV1
} from '@shared/app-settings'
import { diffSettingsPatch } from './settings-utils'

export type InitialSetupAccessMode = 'api' | 'token-plan'

export type InitialSetupDraft = {
  apiKey: string
  baseUrl: string
}

/** Keyed by provider profile id (deepseek, xiaomi, xiaomi-token-plan, ...). */
export type InitialSetupDrafts = Record<string, InitialSetupDraft>

export type InitialSetupSelection = {
  presetId: string
  mode: InitialSetupAccessMode
  permissionMode: KunToolPermissionMode
  /** True only after the user deliberately chooses a permission card. */
  permissionTouched: boolean
}

const INITIAL_SETUP_PROVIDER_PRESET_IDS = new Set(['xiaomi', 'minimax'])

export const INITIAL_SETUP_PROVIDER_PRESETS = MODEL_PROVIDER_PRESETS.filter(
  (preset) => INITIAL_SETUP_PROVIDER_PRESET_IDS.has(preset.id)
)

export function initialSetupProfileId(selection: Pick<InitialSetupSelection, 'presetId' | 'mode'>): string {
  if (selection.presetId === DEFAULT_MODEL_PROVIDER_ID) return DEFAULT_MODEL_PROVIDER_ID
  return selection.mode === 'token-plan' ? tokenPlanProviderId(selection.presetId) : selection.presetId
}

/** Seed per-profile drafts from saved settings so existing keys show up. */
export function initialSetupDrafts(settings: AppSettingsV1): InitialSetupDrafts {
  const provider = getModelProviderSettings(settings)
  const byId = new Map(provider.providers.map((profile) => [profile.id, profile]))
  const drafts: InitialSetupDrafts = {
    [DEFAULT_MODEL_PROVIDER_ID]: { apiKey: provider.apiKey, baseUrl: provider.baseUrl }
  }
  for (const preset of INITIAL_SETUP_PROVIDER_PRESETS) {
    const existing = byId.get(preset.id)
    drafts[preset.id] = {
      apiKey: existing?.apiKey ?? '',
      baseUrl: existing?.baseUrl ?? preset.baseUrl
    }
    if (!preset.tokenPlan) continue
    const tokenPlanId = tokenPlanProviderId(preset.id)
    const existingTokenPlan = byId.get(tokenPlanId)
    drafts[tokenPlanId] = {
      apiKey: existingTokenPlan?.apiKey ?? '',
      baseUrl: existingTokenPlan?.baseUrl ?? preset.tokenPlan.baseUrl
    }
  }
  return drafts
}

/** Card and mode to preselect: the active provider when it is one of ours, DeepSeek otherwise. */
export function initialSetupSelection(settings: AppSettingsV1): InitialSetupSelection {
  const runtime = getKunRuntimeSettings(settings)
  const activeId = runtime.providerId.trim()
  const permissionMode = kunToolPermissionModeFromSettings(runtime)
  for (const preset of INITIAL_SETUP_PROVIDER_PRESETS) {
    if (activeId === preset.id) {
      return { presetId: preset.id, mode: 'api', permissionMode, permissionTouched: false }
    }
    if (preset.tokenPlan && activeId === tokenPlanProviderId(preset.id)) {
      return {
        presetId: preset.id,
        mode: 'token-plan',
        permissionMode,
        permissionTouched: false
      }
    }
  }
  return {
    presetId: DEFAULT_MODEL_PROVIDER_ID,
    mode: 'api',
    permissionMode,
    permissionTouched: false
  }
}

export type InitialSetupAutoWirePlan = {
  speechProviderId: string
  imageProviderId: string
}

/**
 * Capabilities to point at a just-configured profile. Only fires while the
 * capability is still unconfigured — never overrides a user choice. Speech and
 * image generation can come from a pay-as-you-go profile or a token plan when
 * the provider exposes that capability to subscription keys.
 */
export function initialSetupAutoWirePlan(
  settings: AppSettingsV1,
  drafts: InitialSetupDrafts
): InitialSetupAutoWirePlan {
  const runtime = getKunRuntimeSettings(settings)
  const speechUnconfigured = !runtime.speechToText.enabled && !runtime.speechToText.providerId.trim()
  const imageUnconfigured = !runtime.imageGeneration.enabled && !runtime.imageGeneration.providerId.trim()
  const plan: InitialSetupAutoWirePlan = { speechProviderId: '', imageProviderId: '' }
  for (const preset of INITIAL_SETUP_PROVIDER_PRESETS) {
    const apiKeyFilled = Boolean(drafts[preset.id]?.apiKey.trim())
    const tokenPlanKeyFilled = Boolean(
      preset.tokenPlan && drafts[tokenPlanProviderId(preset.id)]?.apiKey.trim()
    )
    if (speechUnconfigured && !plan.speechProviderId) {
      if (preset.speech && apiKeyFilled) {
        plan.speechProviderId = preset.id
      } else if (preset.tokenPlan?.speech && tokenPlanKeyFilled) {
        plan.speechProviderId = tokenPlanProviderId(preset.id)
      }
    }
    if (imageUnconfigured && !plan.imageProviderId) {
      if (preset.image && apiKeyFilled) {
        plan.imageProviderId = preset.id
      } else if (preset.tokenPlan?.image && tokenPlanKeyFilled) {
        plan.imageProviderId = tokenPlanProviderId(preset.id)
      }
    }
  }
  return plan
}

/**
 * Fold the onboarding drafts into settings: upsert one profile per filled
 * draft, activate the selected profile, and auto-wire speech/image to filled
 * pay-as-you-go profiles. The caller must ensure the selected draft has a key.
 */
export function buildInitialSetupSettings(
  settings: AppSettingsV1,
  drafts: InitialSetupDrafts,
  selection: Pick<InitialSetupSelection, 'presetId' | 'mode'> &
    Partial<Pick<InitialSetupSelection, 'permissionMode' | 'permissionTouched'>>
): AppSettingsV1 {
  const provider = getModelProviderSettings(settings)
  const profiles = new Map(provider.providers.map((profile) => [profile.id, profile]))

  const deepseekDraft = drafts[DEFAULT_MODEL_PROVIDER_ID]
  const nextApiKey = deepseekDraft ? deepseekDraft.apiKey.trim() : provider.apiKey
  const nextBaseUrl = deepseekDraft?.baseUrl.trim() ? deepseekDraft.baseUrl.trim() : provider.baseUrl
  const defaultProfile = profiles.get(DEFAULT_MODEL_PROVIDER_ID)
  if (defaultProfile) {
    profiles.set(DEFAULT_MODEL_PROVIDER_ID, {
      ...defaultProfile,
      apiKey: nextApiKey,
      baseUrl: nextBaseUrl
    })
  }

  for (const preset of INITIAL_SETUP_PROVIDER_PRESETS) {
    upsertPresetProfile(profiles, preset.id, drafts[preset.id], (apiKey, baseUrl) => ({
      ...modelProviderPresetProfile(preset, apiKey),
      ...(baseUrl ? { baseUrl } : {})
    }))
    if (!preset.tokenPlan) continue
    upsertPresetProfile(profiles, tokenPlanProviderId(preset.id), drafts[tokenPlanProviderId(preset.id)], (apiKey, baseUrl) =>
      modelProviderTokenPlanProfile(preset, apiKey, baseUrl)
    )
  }

  const next = normalizeAppSettings({
    ...settings,
    initialSetupCompleted: true,
    provider: {
      apiKey: nextApiKey,
      baseUrl: nextBaseUrl,
      providers: [...profiles.values()]
    }
  } as AppSettingsV1)

  const runtime = getKunRuntimeSettings(next)
  const selectedId = initialSetupProfileId(selection)
  const selectedProfile = getModelProviderSettings(next).providers.find(
    (profile) => profile.id === selectedId
  )
  const switchingProvider = (runtime.providerId.trim() || DEFAULT_MODEL_PROVIDER_ID) !== selectedId
  const wire = initialSetupAutoWirePlan(settings, drafts)
  // Only rewrite the complete authority snapshot when the user actually moved
  // the permission selector. The three-mode projection is intentionally lossy,
  // so emitting it while the selector is untouched would silently broaden or
  // otherwise rewrite a valid legacy approval/sandbox combination.
  const currentPermissionMode = kunToolPermissionModeFromSettings(runtime)
  const selectedPermissionMode = selection.permissionMode && KUN_TOOL_PERMISSION_MODES.includes(selection.permissionMode)
    ? selection.permissionMode
    : currentPermissionMode
  const permissionChanged =
    selection.permissionTouched === true ||
    selectedPermissionMode !== currentPermissionMode
  const kunPatch: KunRuntimeSettingsPatchV1 = {
    providerId: selectedId,
    apiKey: '',
    baseUrl: '',
    ...(permissionChanged ? kunToolPermissionModeSettings(selectedPermissionMode) : {}),
    ...(switchingProvider && selectedProfile?.models[0] ? { model: selectedProfile.models[0] } : {}),
    ...(wire.speechProviderId
      ? { speechToText: { enabled: true, providerId: wire.speechProviderId } }
      : {}),
    ...(wire.imageProviderId
      ? { imageGeneration: { enabled: true, providerId: wire.imageProviderId } }
      : {})
  }
  return applyKunRuntimePatch(next, kunPatch)
}

export function buildInitialSetupSettingsPatch(
  settings: AppSettingsV1,
  drafts: InitialSetupDrafts,
  selection: Pick<InitialSetupSelection, 'presetId' | 'mode'> &
    Partial<Pick<InitialSetupSelection, 'permissionMode' | 'permissionTouched'>>
): AppSettingsPatch {
  return diffSettingsPatch(settings, buildInitialSetupSettings(settings, drafts, selection))
}

function upsertPresetProfile(
  profiles: Map<string, ModelProviderProfileV1>,
  id: string,
  draft: InitialSetupDraft | undefined,
  build: (apiKey: string, baseUrl: string) => ModelProviderProfileV1 | null
): void {
  const apiKey = draft?.apiKey.trim() ?? ''
  if (!apiKey) return
  const built = build(apiKey, draft?.baseUrl.trim() ?? '')
  if (!built) return
  const existing = profiles.get(id)
  profiles.set(id, existing
    ? {
        ...built,
        name: existing.name.trim() || built.name,
        models: mergeModelIds(built.models, existing.models)
      }
    : built)
}

function mergeModelIds(primary: readonly string[], secondary: readonly string[]): string[] {
  const ids = new Set<string>()
  for (const model of [...primary, ...secondary]) {
    const trimmed = model.trim()
    if (trimmed) ids.add(trimmed)
  }
  return [...ids]
}

export function presetForInitialSetup(presetId: string): ModelProviderPreset | null {
  return INITIAL_SETUP_PROVIDER_PRESETS.find((preset) => preset.id === presetId) ?? null
}
