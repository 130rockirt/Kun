import { describe, expect, it } from 'vitest'
import type { DesignArtifact, DesignDocument } from '../../design/design-types'
import {
  getDesignSidebarArtifactVersionBadge,
  getDesignSidebarDocumentArtifactCount,
  getDesignSidebarDocumentLabel,
  getDesignSidebarDocumentScreenCount,
  getDesignSidebarVisibleArtifacts
} from './DesignSidebar'

function artifact(id: string, kind: DesignArtifact['kind'], patch: Partial<DesignArtifact> = {}): DesignArtifact {
  const createdAt = '2026-06-20T00:00:00.000Z'
  const relativePath = kind === 'canvas'
    ? `.kun-design/${id}/canvas.json`
    : `.kun-design/${id}/v1.${kind === 'svg' ? 'svg' : 'html'}`
  return {
    id,
    kind,
    title: id,
    relativePath,
    createdAt,
    updatedAt: createdAt,
    versions: [{ id: `${id}-v1`, relativePath, createdAt, summary: '' }],
    ...patch
  }
}

describe('DesignSidebar helpers', () => {
  it('hides board-hidden screens from sidebar lists', () => {
    const visibleScreen = artifact('visible-screen', 'html')
    const hiddenScreen = artifact('hidden-screen', 'html', {
      node: { x: 40, y: 60, width: 390, height: 844, sizeMode: 'auto', boardHidden: true }
    })
    const canvas = artifact('board', 'canvas')

    expect(getDesignSidebarVisibleArtifacts([visibleScreen, hiddenScreen, canvas]).map((item) => item.id)).toEqual([
      'visible-screen',
      'board'
    ])
  })

  it('counts visible screens instead of implementation canvas artifacts', () => {
    const doc: Pick<DesignDocument, 'artifacts'> = {
      artifacts: [
        artifact('board', 'canvas'),
        artifact('hidden-screen', 'html', {
          node: { x: 40, y: 60, width: 390, height: 844, sizeMode: 'auto', boardHidden: true }
        }),
        artifact('visible-screen', 'html'),
        artifact('motion-logo', 'svg')
      ]
    }

    expect(getDesignSidebarDocumentScreenCount(doc)).toBe(1)
    expect(getDesignSidebarDocumentArtifactCount(doc)).toBe(2)
  })

  it('keeps visible SVG artifacts in the sidebar artifact list', () => {
    const svg = artifact('motion-logo', 'svg')
    expect(getDesignSidebarVisibleArtifacts([svg])).toEqual([svg])
  })

  it('shows the current sparse SVG version number instead of the history length', () => {
    const svg = artifact('motion-logo', 'svg', {
      relativePath: '.kun-design/motion-logo/v3.svg',
      versions: [
        {
          id: 'motion-logo-v3',
          relativePath: '.kun-design/motion-logo/v3.svg',
          createdAt: '2026-06-20T03:00:00.000Z',
          summary: 'Latest'
        },
        {
          id: 'motion-logo-v1',
          relativePath: '.kun-design/motion-logo/v1.svg',
          createdAt: '2026-06-20T00:00:00.000Z',
          summary: 'Initial'
        }
      ]
    })

    expect(getDesignSidebarArtifactVersionBadge(svg)).toBe('v3')
  })

  it('uses the drawing title as the sidebar label and never exposes an id fallback', () => {
    expect(getDesignSidebarDocumentLabel({
      id: 'a1b2c3d4',
      title: 'Travel dashboard'
    })).toBe('Travel dashboard')
    expect(getDesignSidebarDocumentLabel({
      id: 'a1b2c3d4',
      title: 'a1b2c3d4'
    })).toBe('Untitled drawing')
  })
})
