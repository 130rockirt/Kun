import type { ModelProviderModelGroup } from '@shared/kun-gui-api'

export const CODEX_FAST_SERVICE_TIER = 'priority' as const

export function composerSupportsCodexFastMode(
  groups: readonly ModelProviderModelGroup[],
  modelId: string,
  providerId: string
): boolean {
  const provider = providerId.trim()
  const model = normalizeModelId(modelId)
  if (!provider || !model) return false
  const group = groups.find((candidate) => candidate.providerId === provider)
  if (!group) return false
  const presetSource = group.presetSource?.trim().toLowerCase()
  if (presetSource !== 'codex' && !(presetSource === undefined && provider === 'codex')) {
    return false
  }
  const profile = Object.entries(group.modelProfiles ?? {}).find(([candidate, value]) =>
    normalizeModelId(candidate) === model ||
    value.aliases?.some((alias) => normalizeModelId(alias) === model)
  )?.[1]
  return profile?.serviceTiers?.includes(CODEX_FAST_SERVICE_TIER) === true
}

export function serviceTierForComposerSelection(
  enabled: boolean,
  groups: readonly ModelProviderModelGroup[],
  modelId: string,
  providerId: string
): typeof CODEX_FAST_SERVICE_TIER | undefined {
  return enabled && composerSupportsCodexFastMode(groups, modelId, providerId)
    ? CODEX_FAST_SERVICE_TIER
    : undefined
}

function normalizeModelId(modelId: string): string {
  return modelId.trim().toLowerCase()
}
