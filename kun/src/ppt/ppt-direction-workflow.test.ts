import { describe, expect, it } from 'vitest'
import {
  PptDirectionBundleV1,
  PptDirectionState,
  classifyPptDirectionGate,
  pptDirectionCandidateFingerprint,
  pptDirectionContentFingerprint,
  pptDirectionPlanFingerprint,
  pptDirectionSlidesFingerprint,
  pptDirectionVisualFingerprint,
  samePptDirectionPlan
} from './ppt-direction-workflow.js'

const basePlan = {
  category: 'tech-engineering' as const,
  audience: 'Engineering leaders',
  purpose: 'Explain the architecture and support a decision',
  pageStrategy: { pageCount: 3, narrative: 'Context, mechanism, and evidence lead to a decision' },
  fontRoles: { display: 'Inter', body: 'Inter', monospace: 'JetBrains Mono' },
  colorRoles: {
    background: '#F7F8FA', foreground: '#18202A', accent: '#C54A2C', muted: '#66717D',
    positive: '#287A4B', caution: '#A56A16', critical: '#B33030'
  },
  backgroundTreatment: { kind: 'solid' as const },
  effects: [],
  typeScale: { title: 40, section: 30, body: 18, caption: 11 },
  spacingRhythm: { unit: 8, pageMargin: 48, columns: 12, gutter: 20 },
  layoutSystem: 'Stable title axis with direct evidence layouts and thin rules',
  imageryStrategy: 'Use architecture diagrams and source imagery only when informative',
  policyExceptions: []
}

function candidate(index: number, recommended = false) {
  const plan = {
    ...basePlan,
    fontRoles: index === 1
      ? basePlan.fontRoles
      : { ...basePlan.fontRoles, display: index === 2 ? 'Aptos Display' : 'IBM Plex Sans' },
    colorRoles: {
      ...basePlan.colorRoles,
      accent: index === 1 ? '#C54A2C' : index === 2 ? '#286C8E' : '#6B4AA5'
    },
    layoutSystem: `${basePlan.layoutSystem}; direction ${index}`
  }
  return {
    directionId: `ppt_workflow-direction-${index}`,
    name: `Direction ${index}`,
    rationale: `A materially distinct visual system for direction ${index}.`,
    revision: 1,
    recommended,
    plan,
    previews: [
      { role: 'cover' as const, imagePath: `.kun/images/direction-${index}-cover.png`, sha256: `${index}1`.repeat(32), width: 160, height: 90 },
      { role: 'representative' as const, imagePath: `.kun/images/direction-${index}-content.png`, sha256: `${index}2`.repeat(32), width: 160, height: 90 },
      { role: 'complex' as const, imagePath: `.kun/images/direction-${index}-complex.png`, sha256: `${index}3`.repeat(32), width: 160, height: 90 }
    ]
  }
}

const requiredGate = classifyPptDirectionGate({ prompt: 'Create a launch presentation for Kun.' })

describe('PPT visual direction gate', () => {
  it.each([
    ['editing an existing deck', { prompt: 'Edit the attached deck', fileReferences: [{ name: 'deck.pptx', relativePath: 'deck.pptx' }] }, 'existing-presentation'],
    ['an explicit bypass', { prompt: 'Skip direction options and directly generate the presentation.' }, 'explicit-skip'],
    ['a design authority', { prompt: 'Use the attached brand guide.', fileReferences: [{ name: 'DESIGN_SYSTEM.md', relativePath: 'brand/DESIGN_SYSTEM.md' }] }, 'design-reference'],
    ['a complete visual system', { prompt: 'Use Inter font, a #112233 palette, a 12-column grid layout, and documentary photography imagery.' }, 'complete-visual-system']
  ])('bypasses directions for %s', (_label, input, reason) => {
    expect(classifyPptDirectionGate(input)).toMatchObject({ required: false, reason })
  })

  it('requires directions for a visually underspecified new deck and fingerprints the exact source', () => {
    const first = classifyPptDirectionGate({ prompt: 'Create a launch presentation for Kun.' })
    const second = classifyPptDirectionGate({ prompt: 'Create a launch presentation for Kun today.' })
    expect(first).toMatchObject({
      required: true,
      reason: 'underspecified-new-deck',
      basis: expect.stringContaining('without a complete visual authority')
    })
    expect(first.sourceHash).toMatch(/^[a-f0-9]{64}$/)
    expect(first.sourceHash).not.toBe(second.sourceHash)
  })

  it.each([
    '帮我给这个文档写个PPT',
    '把当前文档做成演示文稿',
    'Create a presentation from this document'
  ])('lets Work convert its active Markdown with an automatic visual system: %s', (prompt) => {
    const input = {
      prompt,
      agentSurface: 'write' as const,
      fileReferences: [{ name: 'brief.md', relativePath: 'brief.md' }]
    }
    expect(classifyPptDirectionGate(input)).toMatchObject({
      required: false,
      reason: 'work-document'
    })
    expect(classifyPptDirectionGate({ ...input, agentSurface: 'code' })).toMatchObject({
      required: true,
      reason: 'underspecified-new-deck'
    })
  })

  it.each([
    'Create a process optimization project update presentation.',
    'Create a software update presentation.',
    'Recommend fonts, palette, layout, and imagery for a launch deck.',
    'Create a deck with no template and no brand guide.',
    'I have no design direction yet.',
    "Don't skip direction options.",
    'Do not keep the existing style.',
    '不要跳过方向选择。'
    ,'新建一个PPT介绍如何修改PPT。'
    ,'做一个关于PPT优化的演示文稿。'
    ,'Use the attached data to create a presentation.'
    ,'根据附件数据制作演示文稿。'
    ,'根据附件报告做PPT。'
    ,'不要直接生成，先给我三个方向。'
  ])('does not mistake underspecification or negation for a bypass: %s', (prompt) => {
    expect(classifyPptDirectionGate({ prompt })).toMatchObject({ required: true, reason: 'underspecified-new-deck' })
  })

  it.each([
    '修改这个PPT。',
    '把这个PPT修改一下。',
    '继续这个PPT。',
    'Revise the presentation with the new results.',
    'Can you update this presentation?',
    'We need to update the presentation.'
  ])('recognizes a noun-qualified edit request: %s', (prompt) => {
    expect(classifyPptDirectionGate({ prompt })).toMatchObject({ required: false, reason: 'existing-presentation' })
  })

  it.each(['brand-sales.csv', 'template-engine.ts', 'reference-data.json']) (
    'does not treat a non-design filename as visual authority: %s', (name) => {
      expect(classifyPptDirectionGate({
        prompt: 'Create a launch presentation.',
        fileReferences: [{ name, relativePath: `inputs/${name}` }]
      })).toMatchObject({ required: true })
    }
  )

  it.each([
    ['Use the attached image as the visual style.', 'screenshot.png'],
    ['Follow the attached visual reference.', 'moodboard.png'],
    ['Match this reference image.', 'image.png'],
    ['参照这个设计图制作幻灯片。', 'foo.png']
  ])('uses an explicitly referenced ordinary image as design authority: %s', (prompt, name) => {
    expect(classifyPptDirectionGate({
      prompt,
      fileReferences: [{ name, relativePath: `inputs/${name}` }]
    })).toMatchObject({ required: false, reason: 'design-reference' })
  })

  it.each([
    'Use the attached product image on the cover.',
    'Use this image on slide 2.',
    'Apply the attached screenshot to the appendix.'
  ])('keeps content-image usage separate from visual authority: %s', (prompt) => {
    expect(classifyPptDirectionGate({
      prompt,
      fileReferences: [{ name: 'product.png', relativePath: 'inputs/product.png' }]
    })).toMatchObject({ required: true, reason: 'underspecified-new-deck' })
  })
})

describe('PPT direction contracts', () => {
  it('requires exactly three content-equivalent, visually distinct candidates and one recommendation', () => {
    const candidates = [candidate(1), candidate(2, true), candidate(3)]
    expect(PptDirectionState.safeParse({ gate: requiredGate, candidates }).success).toBe(true)
    expect(pptDirectionContentFingerprint(candidates[0].plan)).toBe(
      pptDirectionContentFingerprint(candidates[2].plan)
    )
    expect(pptDirectionVisualFingerprint(candidates[0].plan)).not.toBe(
      pptDirectionVisualFingerprint(candidates[2].plan)
    )
    expect(PptDirectionState.safeParse({
      gate: requiredGate,
      candidates: candidates.map((item) => ({ ...item, recommended: false }))
    }).success).toBe(false)
    expect(PptDirectionState.safeParse({
      gate: requiredGate,
      candidates: [candidates[0], candidates[0], candidates[2]]
    }).success).toBe(false)
    expect(PptDirectionState.safeParse({
      gate: requiredGate,
      candidates: [candidates[0], candidates[1], {
        ...candidates[2],
        plan: { ...candidates[2].plan, audience: 'A different audience' }
      }]
    }).success).toBe(false)
    expect(PptDirectionState.safeParse({
      gate: requiredGate,
      candidates: [candidates[0], candidates[1], {
        ...candidates[2],
        plan: {
          ...candidates[0].plan,
          colorRoles: { ...candidates[0].plan.colorRoles, accent: '#C54A2D' }
        }
      }]
    }).success).toBe(false)
    expect(PptDirectionState.safeParse({
      gate: requiredGate,
      candidates: [candidates[0], candidates[1], {
        ...candidates[2],
        previews: candidates[0].previews
      }]
    }).success).toBe(false)
  })

  it('keeps candidates as proposals and validates the board bundle identity', () => {
    const candidates = [candidate(1), candidate(2, true), candidate(3)]
    const slides = [
      { slideId: 'slide-1', index: 0, title: 'Opening', promptHash: '1'.repeat(64) },
      { slideId: 'slide-2', index: 1, title: 'Mechanism', promptHash: '2'.repeat(64) },
      { slideId: 'slide-3', index: 2, title: 'Decision', promptHash: '3'.repeat(64) }
    ]
    const bundle = {
      schemaVersion: 1 as const,
      workflowId: 'ppt_workflow',
      childId: 'child_ppt',
      manifestPath: '.kun/ppt/ppt_workflow/.kun-ppt-review/manifest.json',
      previewMode: 'image-first' as const,
      deckTitle: 'Launch deck',
      phase: 'awaiting_direction' as const,
      recommendedDirectionId: candidates[1].directionId,
      slides,
      slidesFingerprint: pptDirectionSlidesFingerprint(slides),
      directions: candidates.map((item) => ({
        directionId: item.directionId,
        name: item.name,
        rationale: item.rationale,
        revision: item.revision,
        recommended: item.recommended,
        planFingerprint: pptDirectionPlanFingerprint(item.plan),
        candidateFingerprint: pptDirectionCandidateFingerprint(item),
        fonts: [item.plan.fontRoles.display, item.plan.fontRoles.body],
        colors: Object.values(item.plan.colorRoles),
        layout: item.plan.layoutSystem,
        background: item.plan.backgroundTreatment.kind,
        imagery: item.plan.imageryStrategy,
        previews: item.previews
      }))
    }
    expect(PptDirectionBundleV1.safeParse(bundle).success).toBe(true)
    expect(PptDirectionBundleV1.safeParse({ ...bundle, recommendedDirectionId: candidates[0].directionId }).success).toBe(false)
    expect(PptDirectionBundleV1.safeParse({ ...bundle, slidesFingerprint: 'f'.repeat(64) }).success).toBe(false)
    expect(samePptDirectionPlan(candidates[1].plan, structuredClone(candidates[1].plan))).toBe(true)
    expect(samePptDirectionPlan(candidates[1].plan, candidates[2].plan)).toBe(false)
  })
})
