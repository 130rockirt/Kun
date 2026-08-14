import {
  MAX_MODEL_CONTEXT_WINDOW_TOKENS,
  MAX_MODEL_OUTPUT_TOKENS,
  type ModelCapabilityMetadata
} from '../contracts/capabilities.js'
import type { RegistryDocument } from './model-connection-registry-core.js'

export function normalizeModelCapabilityMetadata(
  capability: ModelCapabilityMetadata | undefined
): ModelCapabilityMetadata | undefined {
  if (!capability) return undefined
  const invalidContextWindow = capability.contextWindowTokens !== undefined &&
    capability.contextWindowTokens > MAX_MODEL_CONTEXT_WINDOW_TOKENS
  const invalidMaxOutput = capability.maxOutputTokens !== undefined &&
    capability.maxOutputTokens > MAX_MODEL_OUTPUT_TOKENS
  if (!invalidContextWindow && !invalidMaxOutput) return capability
  const {
    contextWindowTokens: _contextWindowTokens,
    maxOutputTokens: _maxOutputTokens,
    ...remaining
  } = capability
  return {
    ...remaining,
    ...(!invalidContextWindow && capability.contextWindowTokens !== undefined
      ? { contextWindowTokens: capability.contextWindowTokens }
      : {}),
    ...(!invalidMaxOutput && capability.maxOutputTokens !== undefined
      ? { maxOutputTokens: capability.maxOutputTokens }
      : {})
  }
}

export function repairRegistryModelCapabilityLimits(
  document: RegistryDocument
): RegistryDocument | null {
  let changed = false
  const profiles = Object.fromEntries(Object.entries(document.profiles).map(([providerId, profile]) => {
    if (!profile.modelCapabilities) return [providerId, profile]
    let profileChanged = false
    const modelCapabilities = Object.fromEntries(
      Object.entries(profile.modelCapabilities).map(([modelId, capability]) => {
        const normalized = normalizeModelCapabilityMetadata(capability) ?? capability
        if (normalized !== capability) profileChanged = true
        return [modelId, normalized]
      })
    )
    if (!profileChanged) return [providerId, profile]
    changed = true
    return [providerId, { ...profile, modelCapabilities }]
  }))
  return changed ? { ...document, profiles } : null
}
