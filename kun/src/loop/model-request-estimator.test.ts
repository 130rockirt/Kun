import { describe, expect, it } from 'vitest'
import {
  estimateModelRequestInputTokenBreakdown,
  estimateModelRequestInputTokens
} from './model-request-estimator.js'
import { makeUserItem } from '../domain/item.js'
import type { ModelRequest } from '../ports/model-client.js'

describe('estimateModelRequestInputTokens', () => {
  it('includes document and image attachment payloads', () => {
    const request: ModelRequest = {
      threadId: 'thr_estimate',
      turnId: 'turn_estimate',
      model: 'model',
      systemPrompt: 'system',
      prefix: [],
      history: [],
      tools: [],
      attachments: [{ id: 'image', name: 'image.png', mimeType: 'image/png', dataBase64: 'a'.repeat(400) }],
      attachmentDocuments: [{ id: 'doc', name: 'doc.txt', mimeType: 'text/plain', text: 'b'.repeat(400), byteSize: 400 }],
      abortSignal: new AbortController().signal
    }

    expect(estimateModelRequestInputTokens(request)).toBeGreaterThanOrEqual(2_100)
  })

  it('includes a separate thread profile in request overhead', () => {
    const base: ModelRequest = {
      threadId: 'thr_profile_estimate',
      turnId: 'turn_profile_estimate',
      model: 'model',
      systemPrompt: 'stable',
      prefix: [],
      history: [],
      tools: [],
      abortSignal: new AbortController().signal
    }

    expect(estimateModelRequestInputTokens({
      ...base,
      threadProfileInstruction: 'p'.repeat(400)
    })).toBeGreaterThanOrEqual(estimateModelRequestInputTokens(base) + 100)
  })

  it('partitions the final request into exact categories without redistributing the total', () => {
    const skillInstruction = [
      '<kun_context_block kind="skill-instruction" authority="skill">',
      's'.repeat(400),
      '</kun_context_block>'
    ].join('\n')
    const request: ModelRequest = {
      threadId: 'thr_breakdown',
      turnId: 'turn_breakdown',
      model: 'model',
      systemPrompt: 'system '.repeat(40),
      threadProfileInstruction: 'profile '.repeat(20),
      modeInstruction: 'plan '.repeat(20),
      contextInstructions: [
        'runtime context '.repeat(30),
        skillInstruction
      ],
      prefix: [makeUserItem({
        id: 'prefix_1',
        turnId: 'turn_prefix',
        threadId: 'thr_breakdown',
        text: 'few shot '.repeat(30)
      })],
      history: [makeUserItem({
        id: 'history_1',
        turnId: 'turn_breakdown',
        threadId: 'thr_breakdown',
        text: 'conversation '.repeat(50)
      })],
      tools: [{
        name: 'schema_heavy_tool',
        description: 'tool description '.repeat(30),
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'schema field '.repeat(30)
            }
          }
        }
      }],
      requiredToolName: 'schema_heavy_tool',
      reasoningEffort: 'max',
      abortSignal: new AbortController().signal
    }

    const breakdown = estimateModelRequestInputTokenBreakdown(request, {
      skillContextInstructions: [skillInstruction]
    })
    const withoutSkillClassification = estimateModelRequestInputTokenBreakdown(request)
    const withoutTools = estimateModelRequestInputTokenBreakdown({
      ...request,
      tools: []
    }, {
      skillContextInstructions: [skillInstruction]
    })

    expect(breakdown.tools).toBeGreaterThan(0)
    expect(withoutTools.tools).toBe(0)
    expect(breakdown.skills).toBeGreaterThan(0)
    expect(breakdown.messages).toBeGreaterThan(0)
    expect(breakdown.system).toBeGreaterThan(0)
    expect(breakdown.other).toBeGreaterThan(0)
    expect(withoutSkillClassification.skills).toBe(0)
    expect(withoutSkillClassification.system).toBeGreaterThan(breakdown.system)
    expect(withoutSkillClassification.total).toBe(breakdown.total)
    expect(breakdown.total).toBe(
      breakdown.tools +
      breakdown.system +
      breakdown.skills +
      breakdown.messages +
      breakdown.other
    )
    expect(estimateModelRequestInputTokens(request)).toBe(breakdown.total)
  })
})
