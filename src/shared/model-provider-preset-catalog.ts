import type { ModelProviderPreset } from './model-provider-preset-types'
import { MODEL_PROVIDER_PRESETS_CORE } from './model-provider-preset-catalog-core'
import { MODEL_PROVIDER_PRESETS_EXTENDED } from './model-provider-preset-catalog-extended'

export const MODEL_PROVIDER_PRESETS: ModelProviderPreset[] = [
  ...MODEL_PROVIDER_PRESETS_CORE,
  ...MODEL_PROVIDER_PRESETS_EXTENDED
]
