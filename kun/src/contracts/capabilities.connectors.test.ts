import { describe, expect, it } from 'vitest'
import {
  buildRuntimeCapabilityManifest,
  ConnectorsCapabilityConfig,
  KunCapabilitiesConfig,
  type ModelCapabilityMetadata
} from './capabilities.js'

const model: ModelCapabilityMetadata = {
  id: 'test-model',
  inputModalities: ['text'],
  outputModalities: ['text'],
  supportsToolCalling: true,
  messageParts: ['text']
}

describe('connector capability contract', () => {
  it('defaults to a disabled loopback-only sidecar without credential fields', () => {
    const parsed = ConnectorsCapabilityConfig.parse({})
    expect(parsed).toMatchObject({
      enabled: false,
      baseUrl: 'http://127.0.0.1:18898',
      timeoutMs: 30_000,
      maxSearchResults: 10
    })
    expect(() => ConnectorsCapabilityConfig.parse({
      enabled: true,
      baseUrl: 'http://127.0.0.1:18898',
      runtimeToken: 'must-not-enter-config'
    })).toThrow()
  })

  it('reports sidecar protocol diagnostics without exposing authentication', () => {
    const config = KunCapabilitiesConfig.parse({
      connectors: { enabled: true, baseUrl: 'http://127.0.0.1:18898' }
    })
    const manifest = buildRuntimeCapabilityManifest({
      config,
      model,
      connectors: {
        available: true,
        protocolVersion: '1',
        runtimeVersion: '0.2.0',
        lastCheckedAt: '2026-07-31T00:00:00.000Z'
      }
    })
    expect(manifest.connectors).toEqual({
      status: 'available',
      enabled: true,
      available: true,
      baseUrl: 'http://127.0.0.1:18898',
      protocolVersion: '1',
      runtimeVersion: '0.2.0',
      lastCheckedAt: '2026-07-31T00:00:00.000Z'
    })
    expect(JSON.stringify(manifest)).not.toContain('token')
  })

  it('marks only connectors unavailable when the sidecar is down', () => {
    const config = KunCapabilitiesConfig.parse({ connectors: { enabled: true } })
    const manifest = buildRuntimeCapabilityManifest({
      config,
      model,
      connectors: { available: false, reason: 'connection refused' }
    })
    expect(manifest.connectors).toMatchObject({
      status: 'unavailable',
      enabled: true,
      available: false,
      reason: 'connection refused'
    })
    expect(manifest.cli.chat).toMatchObject({ status: 'available', available: true })
  })
})
