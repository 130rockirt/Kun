import { describe, expect, it } from 'vitest'
import { projectMcpSchemaForModel } from './mcp-schema-projection.js'

describe('projectMcpSchemaForModel', () => {
  it('preserves local definitions and composition without mutating the original', () => {
    const original = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {
        target: { oneOf: [{ $ref: '#/$defs/file' }, { type: 'string' }] }
      },
      $defs: {
        file: { type: 'object', properties: { path: { type: 'string' } } }
      }
    }

    const projected = projectMcpSchemaForModel(original)
    expect(projected).toMatchObject({
      type: 'object',
      properties: { target: { oneOf: [{ $ref: '#/$defs/file' }, { type: 'string' }] } },
      $defs: { file: { type: 'object' } }
    })
    expect(projected).not.toHaveProperty('$schema')
    expect(original).toHaveProperty('$schema')
  })

  it('omits external references and bounds recursive objects', () => {
    const recursive: Record<string, unknown> = { type: 'object' }
    recursive.properties = { self: recursive }
    const projected = projectMcpSchemaForModel({
      type: 'object',
      properties: {
        external: { $ref: 'https://example.test/schema.json' },
        recursive
      }
    })

    expect(projected).toMatchObject({
      properties: {
        external: { description: expect.stringContaining('External') },
        recursive: {
          properties: { self: { description: expect.stringContaining('Recursive') } }
        }
      }
    })
  })

  it('bounds excessive depth and node count', () => {
    const projected = projectMcpSchemaForModel({
      type: 'object',
      properties: { nested: { type: 'object', properties: { leaf: { type: 'string' } } } }
    }, { maxDepth: 3, maxNodes: 10 })
    expect(JSON.stringify(projected)).toContain('depth limit')
  })
})
