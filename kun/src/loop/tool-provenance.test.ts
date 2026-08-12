import { describe, expect, it } from 'vitest'
import { buildToolCatalogFingerprint } from '../cache/tool-catalog-fingerprint.js'
import type { ModelToolSpec } from '../ports/model-client.js'
import { resolvePlanModeToolSpecs } from './plan-mode.js'
import { compactToolSpec } from './token-economy.js'

const readTool: ModelToolSpec = {
  name: 'read',
  description: 'Please read the requested file.',
  inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
  providerKind: 'built-in',
  providerId: 'builtin'
}

const generateImageTool: ModelToolSpec = {
  name: 'generate_image',
  description: 'Generate an image.',
  inputSchema: { type: 'object', properties: { prompt: { type: 'string' } } },
  toolKind: 'file_change',
  providerKind: 'image',
  providerId: 'imageGen'
}

describe('model tool provenance', () => {
  it('survives token economy compaction and plan-mode filtering', () => {
    expect(compactToolSpec(readTool)).toMatchObject({
      name: 'read',
      providerKind: 'built-in',
      providerId: 'builtin'
    })
    expect(resolvePlanModeToolSpecs([readTool], {
      planTurnActive: true,
      createPlanSatisfied: false,
      stepIndex: 0
    })).toEqual([readTool])
  })

  it('does not affect the model-visible tool catalog fingerprint', () => {
    const withoutProvenance: ModelToolSpec = {
      name: readTool.name,
      description: readTool.description,
      inputSchema: readTool.inputSchema
    }

    expect(buildToolCatalogFingerprint([readTool]).fingerprint).toBe(
      buildToolCatalogFingerprint([withoutProvenance]).fingerprint
    )
  })

  it('keeps image generation available throughout a plan-mode turn', () => {
    const mutationTool: ModelToolSpec = {
      ...generateImageTool,
      name: 'write',
      providerKind: 'built-in',
      providerId: 'builtin'
    }

    for (const createPlanSatisfied of [false, true]) {
      expect(resolvePlanModeToolSpecs([generateImageTool, mutationTool], {
        planTurnActive: true,
        createPlanSatisfied,
        stepIndex: createPlanSatisfied ? 1 : 0
      })).toEqual([generateImageTool])
    }
  })
})
