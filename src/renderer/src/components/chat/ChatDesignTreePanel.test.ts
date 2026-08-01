import { describe, expect, it } from 'vitest'
import type { DesignArtifact, DesignDocument } from '../../design/design-types'
import { designArtifactDirectoryReference, designDocumentScreenCount } from './ChatDesignTreePanel'
import { designDocumentComposerFileReference } from '../../design/design-document-file-reference'

const createdAt = '2026-06-20T00:00:00.000Z'

function artifact(id: string, kind: DesignArtifact['kind']): DesignArtifact {
  const relativePath = kind === 'canvas'
    ? `.kun-design/doc_1/${id}/canvas.json`
    : `.kun-design/doc_1/${id}/v1.html`
  return {
    id,
    kind,
    title: id,
    relativePath,
    createdAt,
    updatedAt: createdAt,
    versions: [{ id: `${id}-v1`, relativePath, createdAt, summary: '' }]
  }
}

describe('ChatDesignTreePanel helpers', () => {
  it('counts screen artifacts separately from canvas artifacts', () => {
    const doc: Pick<DesignDocument, 'artifacts'> = {
      artifacts: [artifact('board', 'canvas'), artifact('home', 'html')]
    }

    expect(designDocumentScreenCount(doc)).toBe(1)
  })

  it('creates directory references for individual design artifacts', () => {
    expect(designArtifactDirectoryReference(artifact('home', 'html'), '/workspace')).toMatchObject({
      path: '/workspace/.kun-design/doc_1/home',
      relativePath: '.kun-design/doc_1/home',
      type: 'directory',
      workspaceRoot: '/workspace'
    })
  })

  it('uses the drawing title for a document reference while retaining the stable id path', () => {
    const doc = {
      id: 'doc_1',
      title: 'Warm travel dashboard'
    }

    expect(designDocumentComposerFileReference(doc, '/workspace')).toMatchObject({
      name: 'Warm travel dashboard',
      path: '/workspace/.kun-design/doc_1',
      relativePath: '.kun-design/doc_1'
    })
  })
})
