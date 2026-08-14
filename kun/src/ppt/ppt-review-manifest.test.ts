import { describe, expect, it } from 'vitest'
import { PptReviewBundleV1, PptReviewManifestV1 } from './ppt-review-manifest.js'
import { classifyPptDirectionGate } from './ppt-direction-workflow.js'

const bundle = {
  workflowId: 'ppt_workflow',
  childId: 'child_ppt',
  manifestPath: 'deck/.kun-ppt-review/manifest.json',
  deckTitle: 'Review deck',
  styleFingerprint: 'style-1',
  phase: 'awaiting_review',
  slides: [{
    slideId: 'slide-1',
    index: 0,
    title: 'Opening',
    previewPath: 'deck/.kun-ppt-review/previews/opening.png',
    revision: 1,
    status: 'ready'
  }]
}

describe('PptReviewBundleV1', () => {
  it('accepts only contiguous slide indexes and workspace-relative paths', () => {
    expect(PptReviewBundleV1.safeParse(bundle).success).toBe(true)
    expect(PptReviewBundleV1.safeParse({
      ...bundle,
      manifestPath: 'https://example.com/manifest.json'
    }).success).toBe(false)
    expect(PptReviewBundleV1.safeParse({
      ...bundle,
      slides: [{ ...bundle.slides[0], index: 1 }]
    }).success).toBe(false)
  })
})

const plan = {
  category: 'tech-engineering' as const,
  audience: 'Engineering leaders',
  purpose: 'Explain an architecture decision',
  pageStrategy: { pageCount: 1, narrative: 'Move from context through evidence to a decision' },
  fontRoles: { display: 'Inter', body: 'Inter' },
  colorRoles: {
    background: '#F7F8FA', foreground: '#18202A', accent: '#C54A2C', muted: '#66717D',
    positive: '#287A4B', caution: '#A56A16', critical: '#B33030'
  },
  backgroundTreatment: { kind: 'solid' as const },
  effects: [],
  typeScale: { title: 40, section: 30, body: 18, caption: 11 },
  spacingRhythm: { unit: 8, pageMargin: 48, columns: 12, gutter: 20 },
  layoutSystem: 'Stable title axis with direct evidence layouts and thin rules',
  imageryStrategy: 'Use architecture diagrams only when they clarify the mechanism',
  policyExceptions: []
}

const governance = {
  policy: {
    version: '1.0.0' as const,
    path: 'core-design-policy-v1.md' as const,
    rulesPath: 'core-design-policy-v1.rules.json' as const,
    sha256: 'a'.repeat(64),
    markdownSha256: 'b'.repeat(64),
    rulesSha256: 'c'.repeat(64)
  },
  category: plan.category,
  categoryGuide: 'slides_categories/tech-engineering.md',
  designPlan: { ...plan, fingerprint: 'd'.repeat(64), sourceRequestHash: 'e'.repeat(64) },
  planRevision: 1
}

const manifestBase = {
  workflowId: 'ppt_workflow',
  parentThreadId: 'parent',
  childId: 'child',
  projectDir: '.kun/ppt/ppt_workflow',
  phase: 'awaiting_review' as const,
  deck: { title: 'Deck', aspectRatio: '16:9' as const, slideCount: 1 },
  styleSpec: {
    fingerprint: 'style', fonts: ['Inter'], colorTokens: {}, typeScale: {}, spacingScale: [],
    backgroundLanguage: 'paper', imageTreatment: 'documentary', chartTreatment: 'native'
  },
  slides: [{
    slideId: 'slide-1', index: 0, title: 'Opening',
    layoutSpecPath: '.kun-ppt-review/layouts/slide-1.json', revision: 1,
    status: 'ready' as const, attempts: 1, promptHash: 'prompt'
  }]
}

function direction(index: number, recommended = false) {
  return {
    directionId: `direction-${index}`,
    name: `Direction ${index}`,
    rationale: `Distinct direction rationale ${index}`,
    revision: 1,
    recommended,
    plan: {
      ...plan,
      fontRoles: { ...plan.fontRoles, display: index === 1 ? 'Inter' : index === 2 ? 'Aptos Display' : 'IBM Plex Sans' },
      colorRoles: { ...plan.colorRoles, accent: index === 1 ? '#C54A2C' : index === 2 ? '#286C8E' : '#6B4AA5' },
      layoutSystem: `${plan.layoutSystem}; direction ${index}`
    },
    previews: [
      { role: 'cover' as const, imagePath: `.kun/images/${index}-cover.png`, sha256: `${index}1`.repeat(32), width: 160, height: 90 },
      { role: 'representative' as const, imagePath: `.kun/images/${index}-content.png`, sha256: `${index}2`.repeat(32), width: 160, height: 90 },
      { role: 'complex' as const, imagePath: `.kun/images/${index}-complex.png`, sha256: `${index}3`.repeat(32), width: 160, height: 90 }
    ]
  }
}

describe('PPT review manifest versions', () => {
  it('continues to read legacy v1 and governed v2 manifests', () => {
    expect(PptReviewManifestV1.safeParse({ ...manifestBase, version: 1 }).success).toBe(true)
    expect(PptReviewManifestV1.safeParse({
      ...manifestBase, version: 2, previewMode: 'editable', governance
    }).success).toBe(true)
    expect(PptReviewManifestV1.safeParse({
      ...manifestBase, version: 2, previewMode: 'editable'
    }).success).toBe(false)
  })

  it('keeps unselected v3 directions in the direction phase and rejects review/export authority', () => {
    const candidates = [direction(1), direction(2, true), direction(3)]
    const directions = {
      gate: classifyPptDirectionGate({ prompt: 'Create a new product deck.' }),
      candidates
    }
    expect(PptReviewManifestV1.safeParse({
      ...manifestBase,
      version: 3,
      previewMode: 'image-first',
      phase: 'awaiting_direction',
      directions
    }).success).toBe(true)
    expect(PptReviewManifestV1.safeParse({
      ...manifestBase,
      version: 3,
      previewMode: 'image-first',
      phase: 'awaiting_direction',
      directions,
      validatedExport: {
        output: 'presentations/forged.pptx',
        planFingerprint: 'd'.repeat(64),
        slides: 1
      }
    }).success).toBe(false)
    expect(PptReviewManifestV1.safeParse({
      ...manifestBase,
      version: 3,
      previewMode: 'image-first',
      phase: 'awaiting_review',
      directions,
      governance
    }).success).toBe(false)
    expect(PptReviewManifestV1.safeParse({
      ...manifestBase,
      version: 3,
      previewMode: 'image-first',
      directions: { ...directions, selectedDirectionId: candidates[1].directionId },
      governance: {
        ...governance,
        designPlan: { ...candidates[1].plan, fingerprint: 'd'.repeat(64), sourceRequestHash: 'e'.repeat(64) }
      }
    }).success).toBe(true)
  })
})
