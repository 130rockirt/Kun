import { resolve } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  createPptDesignGovernanceState,
  PptDesignPlanInput,
  pptDesignPlanPolicyErrors,
  recordPptGuideRead,
  sourceRequestSupportsPptPolicyException,
  submitPptDesignPlan,
  wcagContrastRatio,
  type PptDesignPlanInput as DesignPlan
} from './ppt-design-governance.js'
import { loadPptCoreDesignPolicy, type PptCoreDesignPolicy } from './ppt-design-policy.js'

const toolchain = resolve(process.cwd(), '..', 'resources', 'ppt-toolchain')
let policy: PptCoreDesignPolicy

const basePlan = {
  category: 'tech-engineering',
  audience: 'Engineering reviewers',
  purpose: 'Explain the architecture and support a decision',
  pageStrategy: { pageCount: 6, narrative: 'Context to mechanism to evidence and decision' },
  fontRoles: { display: 'Inter', body: 'Inter', monospace: 'JetBrains Mono' },
  colorRoles: {
    background: '#F7F8FA',
    foreground: '#18202A',
    accent: '#C54A2C',
    muted: '#66717D',
    positive: '#287A4B',
    caution: '#A56A16',
    critical: '#B33030'
  },
  backgroundTreatment: { kind: 'solid' },
  effects: [],
  typeScale: { title: 40, section: 30, body: 18, caption: 11 },
  spacingRhythm: { unit: 8, pageMargin: 48, columns: 12, gutter: 20 },
  layoutSystem: 'Stable title axis with direct evidence layouts and thin rules',
  imageryStrategy: 'Use architecture diagrams and source imagery only when informative',
  policyExceptions: []
}

function plan(overrides: Record<string, unknown> = {}): DesignPlan {
  return PptDesignPlanInput.parse({ ...basePlan, ...overrides })
}

beforeAll(async () => {
  policy = await loadPptCoreDesignPolicy(toolchain)
})

describe('machine-readable PPT design policy enforcement', () => {
  it('keeps page count immutable after the workflow design plan is established', () => {
    const created = createPptDesignGovernanceState({
      workflowId: 'ppt_workflow',
      childId: 'child_ppt',
      binding: {
        workspaceCanonicalPath: '/workspace',
        projectCanonicalPath: '/workspace/.kun/ppt/ppt_workflow',
        childId: 'child_ppt'
      },
      policy
    })
    const withIndex = recordPptGuideRead({
      state: created, path: 'slides_categories.md', startLine: 1, endLine: 10, totalLines: 10
    })
    const ready = recordPptGuideRead({
      state: withIndex,
      path: 'slides_categories/tech-engineering.md',
      startLine: 1,
      endLine: 10,
      totalLines: 10
    })
    const submitted = submitPptDesignPlan({
      state: ready, plan: plan(), sourceRequest: 'Build the deck.', policy
    })
    expect(() => submitPptDesignPlan({
      state: submitted,
      plan: plan({ pageStrategy: { pageCount: 7, narrative: basePlan.pageStrategy.narrative } }),
      sourceRequest: 'Build the deck.',
      policy
    })).toThrow('pageCount is immutable')
  })

  it('accepts high-contrast solid purple without treating purple alone as a tech gradient', () => {
    const parsed = plan({
      colorRoles: { ...basePlan.colorRoles, background: '#2E1065', foreground: '#FFFFFF' },
      backgroundTreatment: { kind: 'solid' }
    })
    expect(wcagContrastRatio('#2E1065', '#FFFFFF')).toBeGreaterThan(4.5)
    expect(pptDesignPlanPolicyErrors(parsed, policy)).toEqual([])
  })

  it('rejects a 4.49:1 foreground/background pair using the threshold from policy rules', () => {
    const parsed = plan({
      colorRoles: { ...basePlan.colorRoles, background: '#FFFFFF', foreground: '#006EFF' }
    })
    expect(wcagContrastRatio('#FFFFFF', '#006EFF')).toBeCloseTo(4.49, 2)
    expect(pptDesignPlanPolicyErrors(parsed, policy).join(' ')).toContain('at least 4.5:1')
  })

  it.each([
    ['blue-purple gradient', { backgroundTreatment: { kind: 'gradient', stops: ['#0066FF', '#8B5CF6'] } }, 'generic-tech-gradient'],
    ['cyan-purple gradient', { backgroundTreatment: { kind: 'gradient', stops: ['#06B6D4', '#9333EA'] } }, 'generic-tech-gradient'],
    ['glow', { effects: ['glow'] }, 'glow-or-glass'],
    ['glass', { effects: ['glass'] }, 'glow-or-glass'],
    ['particles', { effects: ['particles'] }, 'decorative-particles'],
    ['ornamental grid', { effects: ['ornamental-grid'] }, 'ornamental-grid']
  ])('requires an exact policy exception for structured %s', (_label, overrides, rule) => {
    const errors = pptDesignPlanPolicyErrors(plan(overrides), policy)
    expect(errors.join(' ')).toContain(`"${rule}"`)
  })

  it('requires claimed exceptions to exactly cover a restricted plan treatment', () => {
    const parsed = plan({
      policyExceptions: [{ rule: 'glow-or-glass', evidence: 'use glow' }]
    })
    expect(pptDesignPlanPolicyErrors(parsed, policy).join(' ')).toContain('does not cover')
  })

  it('accepts a positive exact quote for natural-language and hex gradient evidence', () => {
    const natural = 'Please use a gradient from blue to purple for the launch deck.'
    const governed = plan({
      colorRoles: { ...basePlan.colorRoles, background: '#18202A', foreground: '#FFFFFF' },
      backgroundTreatment: { kind: 'gradient', stops: ['#0052CC', '#6D28D9'] },
      policyExceptions: [{
        rule: 'generic-tech-gradient',
        evidence: 'gradient from blue to purple'
      }]
    })
    expect(pptDesignPlanPolicyErrors(governed, policy)).toEqual([])
    expect(sourceRequestSupportsPptPolicyException(
      natural,
      { rule: 'generic-tech-gradient', evidence: 'gradient from blue to purple' },
      policy.rules
    )).toBe(true)
    const hex = 'Use #0066FF to #8B5CF6 gradient for the launch deck.'
    expect(sourceRequestSupportsPptPolicyException(
      hex,
      { rule: 'generic-tech-gradient', evidence: '#0066FF to #8B5CF6 gradient' },
      policy.rules
    )).toBe(true)
  })

  it('rejects term-prefix evidence and low-contrast gradient stops', () => {
    expect(sourceRequestSupportsPptPolicyException(
      'Please use glassware photography for the product story.',
      { rule: 'glow-or-glass', evidence: 'glassware photography' },
      policy.rules
    )).toBe(false)
    expect(sourceRequestSupportsPptPolicyException(
      'Please explain particle physics for students.',
      { rule: 'decorative-particles', evidence: 'particle physics' },
      policy.rules
    )).toBe(false)
    const lowContrast = plan({
      colorRoles: { ...basePlan.colorRoles, background: '#000000', foreground: '#FFFFFF' },
      backgroundTreatment: { kind: 'gradient', stops: ['#FFFFFF', '#EEEEEE'] }
    })
    expect(pptDesignPlanPolicyErrors(lowContrast, policy).join(' ')).toContain('foreground/gradient-stop contrast')
  })

  it.each([
    ['cards-for-hierarchy', 'Please use rounded cards to build hierarchy.', 'rounded cards to build hierarchy'],
    ['equal-panel-grid', 'Please use a 2x2 grid of equal panels.', '2x2 grid of equal panels'],
    ['mixed-icon-system', 'Please use mixed icons for the navigation.', 'mixed icons'],
    ['tiny-type', 'Please use tiny text in the appendix.', 'tiny text']
  ] as const)('accepts positive exact evidence for static exception %s', (rule, source, evidence) => {
    expect(sourceRequestSupportsPptPolicyException(source, { rule, evidence }, policy.rules)).toBe(true)
  })

  it('rejects negated, descriptive-critical, non-exact, and one-character evidence', () => {
    expect(sourceRequestSupportsPptPolicyException(
      'Do not use a blue-purple gradient.',
      { rule: 'generic-tech-gradient', evidence: 'blue-purple gradient' },
      policy.rules
    )).toBe(false)
    expect(sourceRequestSupportsPptPolicyException(
      'Explain why blue-purple gradients are bad.',
      { rule: 'generic-tech-gradient', evidence: 'blue-purple gradients' },
      policy.rules
    )).toBe(false)
    expect(sourceRequestSupportsPptPolicyException(
      'Use a blue-purple gradient.',
      { rule: 'generic-tech-gradient', evidence: 'purple-to-blue gradient' },
      policy.rules
    )).toBe(false)
    expect(PptDesignPlanInput.safeParse({
      ...basePlan,
      policyExceptions: [{ rule: 'generic-tech-gradient', evidence: 'P' }]
    }).success).toBe(false)
  })
})

describe('free-text anti-pattern lint', () => {
  it.each([
    ['cards-for-hierarchy', 'Use rounded cards to build hierarchy'],
    ['equal-panel-grid', 'Use a 2x2 grid of equal panels'],
    ['generic-tech-gradient', 'Use a blue-purple gradient as generic technology styling'],
    ['glow-or-glass', 'Add glassmorphism and neon glow around the title'],
    ['decorative-particles', 'Fill the background with decorative particles'],
    ['ornamental-grid', 'Fill the background with an ornamental grid'],
    ['mixed-icon-system', 'Use mixed icons and emoji decoration'],
    ['tiny-type', 'Fit the appendix with tiny text']
  ])('requires the matching %s exception when plan prose uses the anti-pattern', (rule, layoutSystem) => {
    const parsed = PptDesignPlanInput.safeParse({ ...basePlan, layoutSystem })
    expect(parsed.success).toBe(false)
    if (!parsed.success) expect(parsed.error.issues.map((issue) => issue.message).join(' ')).toContain(`"${rule}"`)
  })

  it('does not flag explicit rejection of anti-patterns', () => {
    expect(PptDesignPlanInput.safeParse({
      ...basePlan,
      layoutSystem: 'Avoid cards, equal-panel grids, blue-purple gradients, neon glow, glass effects, particles, ornamental grids, mixed icons, emoji decoration, and tiny type.'
    }).success).toBe(true)
  })
})
