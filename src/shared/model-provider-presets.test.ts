import { describe, expect, it } from 'vitest'
import {
  providerCatalogEntries,
  PROVIDER_CATALOG,
  type ProviderCatalogPreset
} from '@kun/provider-catalog'
import {
  MODEL_PROVIDER_PRESETS,
  tokenPlanProviderId
} from './model-provider-presets'

describe('shared model provider preset catalog', () => {
  it('keeps GUI connection fields aligned with the framework-neutral catalog', () => {
    const catalog: readonly ProviderCatalogPreset[] = PROVIDER_CATALOG
    expect(MODEL_PROVIDER_PRESETS.map((preset) => preset.id))
      .toEqual(catalog.map((preset) => preset.id))

    for (const source of catalog) {
      const gui = MODEL_PROVIDER_PRESETS.find((preset) => preset.id === source.id)
      expect(gui).toMatchObject({
        name: source.name,
        baseUrl: source.baseUrl,
        endpointFormat: source.endpointFormat,
        models: [...source.models],
        docsUrl: source.docsUrl,
        apiKeyUrl: source.credentialUrl
      })
      expect(gui?.category ?? 'api').toBe(source.category)
      expect(gui?.kind ?? 'http').toBe(source.kind)
      if (source.tokenPlan) {
        expect(gui?.tokenPlan).toMatchObject({
          baseUrl: source.tokenPlan.baseUrl,
          endpointFormat: source.tokenPlan.endpointFormat,
          models: [...source.tokenPlan.models],
          apiKeyUrl: source.tokenPlan.credentialUrl
        })
      } else {
        expect(gui?.tokenPlan).toBeUndefined()
      }
    }
  })

  it('expands the same Token Plan profile identities used by GUI Settings', () => {
    const tokenPlans = providerCatalogEntries().filter((entry) => entry.mode === 'token-plan')
    expect(tokenPlans.map((entry) => entry.profileId)).toEqual(
      MODEL_PROVIDER_PRESETS
        .filter((preset) => preset.tokenPlan)
        .map((preset) => tokenPlanProviderId(preset.id))
    )
  })
})
