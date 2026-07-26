import { describe, expect, it } from 'vitest'
import {
  DEFAULT_KUN_CAPABILITIES_CONFIG,
  buildRuntimeCapabilityManifest,
  type ModelCapabilityMetadata
} from './capabilities.js'

const model: ModelCapabilityMetadata = {
  id: 'text-model',
  inputModalities: ['text'],
  outputModalities: ['text'],
  supportsToolCalling: true,
  messageParts: ['text']
}

describe('Browser Use capability manifest', () => {
  it('is disabled by default and contains no bridge authority', () => {
    const manifest = buildRuntimeCapabilityManifest({ model })
    expect(DEFAULT_KUN_CAPABILITIES_CONFIG.browserUse.enabled).toBe(false)
    expect(manifest.browserUse).toMatchObject({
      status: 'disabled',
      enabled: false,
      available: false,
      mode: 'public',
      approvalMode: 'auto-safe'
    })
    expect(JSON.stringify(manifest)).not.toContain('TOKEN')
    expect(JSON.stringify(manifest)).not.toContain('bridgeUrl')
  })

  it('distinguishes unavailable and interaction-required states', () => {
    const unavailable = buildRuntimeCapabilityManifest({
      model,
      config: {
        ...DEFAULT_KUN_CAPABILITIES_CONFIG,
        browserUse: {
          ...DEFAULT_KUN_CAPABILITIES_CONFIG.browserUse,
          enabled: true
        }
      },
      browserUse: { available: false, reason: 'host bridge is absent' }
    })
    expect(unavailable.browserUse.status).toBe('unavailable')

    const interactionRequired = buildRuntimeCapabilityManifest({
      model,
      config: {
        ...DEFAULT_KUN_CAPABILITIES_CONFIG,
        browserUse: {
          ...DEFAULT_KUN_CAPABILITIES_CONFIG.browserUse,
          enabled: true
        }
      },
      browserUse: {
        available: false,
        interactionRequired: true,
        reason: 'visible GUI required'
      }
    })
    expect(interactionRequired.browserUse.status).toBe('interaction-required')
  })
})
