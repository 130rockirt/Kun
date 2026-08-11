import { describe, expect, it } from 'vitest'
import { buildKnowledgeBaseMount, knowledgeBaseIdForRoot } from './KnowledgeBasePicker'

describe('KnowledgeBasePicker helpers', () => {
  it('creates deterministic read-only mounts for Write workspaces', () => {
    const first = buildKnowledgeBaseMount('/Users/demo/Documents/Notes/')
    const second = buildKnowledgeBaseMount('/Users/demo/Documents/Notes')

    expect(first).toEqual(second)
    expect(first).toMatchObject({
      name: 'Notes',
      source: 'write-workspace',
      access: 'read-only'
    })
    expect(first.id).toMatch(/^kb_[a-f0-9]{16}$/)
  })

  it('uses different ids for different roots without exposing a path in the id', () => {
    const docs = knowledgeBaseIdForRoot('/private/docs')
    const notes = knowledgeBaseIdForRoot('/private/notes')
    expect(docs).not.toBe(notes)
    expect(docs).not.toContain('private')
  })
})
