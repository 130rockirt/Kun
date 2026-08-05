import { describe, expect, it } from 'vitest'
import type { DesignArtifact } from './design-types'
import {
  shouldRouteDesignPromptToMultiPage,
  type DesignMultiPageGateInput
} from './design-pages-gate'

const now = '2026-07-02T00:00:00.000Z'

function artifact(id: string, kind: DesignArtifact['kind']): DesignArtifact {
  return {
    id,
    kind,
    title: id,
    relativePath: `.kun-design/doc/${id}/${kind === 'html' ? 'v1.html' : 'canvas.json'}`,
    createdAt: now,
    updatedAt: now,
    versions: [{ id: `${id}-v1`, relativePath: `.kun-design/doc/${id}/v1.html`, createdAt: now, summary: '' }]
  }
}

function gate(input: Partial<DesignMultiPageGateInput> = {}) {
  return shouldRouteDesignPromptToMultiPage({
    text: 'Design an operations app',
    artifacts: [artifact('board', 'canvas')],
    activeArtifactId: 'board',
    designIntentMode: 'generate',
    multiPageMode: false,
    selectedCount: 0,
    attachmentCount: 0,
    pagesRunActive: false,
    ...input
  })
}

describe('design pages gate', () => {
  it('routes from-scratch briefs to the multi-page lane by default', () => {
    expect(gate()).toEqual({ route: 'multi-page', reason: 'default-design-pages' })
  })

  it('lets the explicit multi-page toggle force the pipeline when pages already exist', () => {
    expect(gate({
      artifacts: [artifact('board', 'canvas'), artifact('home', 'html')],
      multiPageMode: true
    })).toEqual({ route: 'multi-page', reason: 'explicit-toggle' })
  })

  it('lets the explicit multi-page toggle force the pipeline from an active page', () => {
    expect(gate({
      artifacts: [artifact('board', 'canvas'), artifact('home', 'html')],
      activeArtifactId: 'home',
      multiPageMode: true
    })).toEqual({ route: 'multi-page', reason: 'explicit-toggle' })
  })

  it('keeps incremental existing-page work in the single-turn lane', () => {
    expect(gate({
      artifacts: [artifact('board', 'canvas'), artifact('home', 'html')]
    })).toEqual({ route: 'single-turn', reason: 'existing-html-artifacts' })
  })

  it('does not fan out selected, attached, active-page, or running prompts', () => {
    expect(gate({ selectedCount: 1 })).toEqual({ route: 'single-turn', reason: 'canvas-selection' })
    expect(gate({ attachmentCount: 1 })).toEqual({ route: 'single-turn', reason: 'has-attachments' })
    expect(gate({
      artifacts: [artifact('home', 'html')],
      activeArtifactId: 'home'
    })).toEqual({ route: 'single-turn', reason: 'active-html-artifact' })
    expect(gate({ pagesRunActive: true })).toEqual({ route: 'single-turn', reason: 'pages-run-active' })
  })

  it('keeps safety short-circuits ahead of the explicit multi-page toggle', () => {
    expect(gate({ selectedCount: 1, multiPageMode: true })).toEqual({
      route: 'single-turn',
      reason: 'canvas-selection'
    })
    expect(gate({ attachmentCount: 1, multiPageMode: true })).toEqual({
      route: 'single-turn',
      reason: 'has-attachments'
    })
    expect(gate({ pagesRunActive: true, multiPageMode: true })).toEqual({
      route: 'single-turn',
      reason: 'pages-run-active'
    })
  })

  it('keeps standalone image asset prompts out of the multi-page pipeline', () => {
    expect(gate({ text: 'Generate a logo for the app' })).toEqual({
      route: 'single-turn',
      reason: 'standalone-image-asset'
    })
  })

  it('requires generate mode and non-empty text', () => {
    expect(gate({ designIntentMode: 'modify' })).toEqual({ route: 'single-turn', reason: 'not-generate-mode' })
    expect(gate({ text: '   ' })).toEqual({ route: 'single-turn', reason: 'empty-brief' })
  })
})
