import { describe, expect, it, vi } from 'vitest'
import { ModelsDevCatalogService } from './models-dev-catalog'

describe('ModelsDevCatalogService metadata bounds', () => {
  it('keeps ZenMux models while reporting and omitting out-of-range limits', async () => {
    const body = JSON.stringify({
      zenmux: {
        id: 'zenmux',
        name: 'ZenMux',
        api: 'https://zenmux.ai/api/v1',
        models: {
          'qwen/qwen3.5-flash': {
            id: 'qwen/qwen3.5-flash',
            tool_call: true,
            modalities: { input: ['text', 'image'], output: ['text'] },
            limit: { context: 1_020_000, output: 1_020_000 }
          },
          'boundary-model': {
            id: 'boundary-model',
            modalities: { input: ['text'], output: ['text'] },
            limit: { context: 10_000_000, output: 1_000_000 }
          },
          'over-boundary-model': {
            id: 'over-boundary-model',
            modalities: { input: ['text'], output: ['text'] },
            limit: { context: 10_000_001, output: 1_000_001 }
          }
        }
      }
    })
    const fetcher = vi.fn(async () => new Response(body, { status: 200 }))
    const result = await new ModelsDevCatalogService(fetcher).fetch({
      providerId: 'custom-provider-8',
      baseUrl: 'https://zenmux.ai/api/v1'
    })

    expect(result).toMatchObject({
      status: 'ok',
      models: [
        {
          id: 'qwen/qwen3.5-flash',
          contextWindowTokens: 1_020_000,
          metadataIssues: [{
            field: 'maxOutputTokens',
            code: 'out_of_range',
            rawValue: 1_020_000,
            maxAllowed: 1_000_000
          }]
        },
        { id: 'boundary-model', contextWindowTokens: 10_000_000, maxOutputTokens: 1_000_000 },
        {
          id: 'over-boundary-model',
          metadataIssues: [
            { field: 'contextWindowTokens', rawValue: 10_000_001, maxAllowed: 10_000_000 },
            { field: 'maxOutputTokens', rawValue: 1_000_001, maxAllowed: 1_000_000 }
          ]
        }
      ]
    })
    if (result.status !== 'ok') throw new Error('expected catalog result')
    expect(result.models[0]?.maxOutputTokens).toBeUndefined()
    expect(result.models[1]?.metadataIssues).toBeUndefined()
    expect(result.models[2]?.contextWindowTokens).toBeUndefined()
    expect(result.models[2]?.maxOutputTokens).toBeUndefined()
  })
})
