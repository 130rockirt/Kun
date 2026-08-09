import { describe, expect, it } from 'vitest'
import enCommon from '../locales/en/common'
import zhCommon from '../locales/zh/common'
import {
  PM_SKILL_FRAMEWORKS,
  SDD_ASSISTANT_FRAMEWORK_GROUPS,
  composeFrameworkGuidance,
  frameworkById,
  frameworksForStage,
  type SddWorkflowStage
} from './pm-skill-frameworks'

const en = enCommon as Record<string, unknown>
const zh = zhCommon as Record<string, unknown>

const VALID_STAGES: SddWorkflowStage[] = ['discover', 'structure', 'risk', 'plan', 'verify']
const BUTTON_STAGES = new Set<SddWorkflowStage>(['discover', 'structure', 'risk'])

describe('PM_SKILL_FRAMEWORKS registry', () => {
  it('has unique ids and valid stages', () => {
    const ids = PM_SKILL_FRAMEWORKS.map((framework) => framework.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const framework of PM_SKILL_FRAMEWORKS) {
      expect(VALID_STAGES).toContain(framework.stage)
      expect(framework.label.trim().length).toBeGreaterThan(0)
    }
  })

  it('gives every assistant-button framework an i18n title/subtitle/prompt key', () => {
    for (const framework of PM_SKILL_FRAMEWORKS.filter((f) => BUTTON_STAGES.has(f.stage))) {
      expect(framework.titleKey, `${framework.id} titleKey`).toBeTruthy()
      expect(framework.subtitleKey, `${framework.id} subtitleKey`).toBeTruthy()
      expect(framework.promptKey, `${framework.id} promptKey`).toBeTruthy()
    }
  })

  it('gives every plan/verify framework injectable guidance (no button keys)', () => {
    for (const framework of PM_SKILL_FRAMEWORKS.filter((f) => !BUTTON_STAGES.has(f.stage))) {
      expect(framework.guidance?.trim().length, `${framework.id} guidance`).toBeGreaterThan(0)
      expect(framework.titleKey).toBeUndefined()
      expect(framework.promptKey).toBeUndefined()
    }
  })

  it('resolves every referenced i18n key in BOTH locales', () => {
    const keys = new Set<string>()
    for (const group of SDD_ASSISTANT_FRAMEWORK_GROUPS) keys.add(group.titleKey)
    for (const framework of PM_SKILL_FRAMEWORKS) {
      for (const key of [framework.titleKey, framework.subtitleKey, framework.promptKey]) {
        if (key) keys.add(key)
      }
    }
    for (const key of keys) {
      expect(en[key], `en.${key}`).toBeTruthy()
      expect(zh[key], `zh.${key}`).toBeTruthy()
    }
  })

  it('exposes exactly the three button groups, each with frameworks', () => {
    expect(SDD_ASSISTANT_FRAMEWORK_GROUPS.map((group) => group.stage)).toEqual([
      'discover',
      'structure',
      'risk'
    ])
    for (const group of SDD_ASSISTANT_FRAMEWORK_GROUPS) {
      const buttons = frameworksForStage(group.stage).filter((f) => f.titleKey && f.promptKey)
      expect(buttons.length, `${group.stage} buttons`).toBeGreaterThan(0)
    }
  })

  it('keeps the frameworks the SDD prompt builders depend on', () => {
    for (const id of [
      'pre-mortem',
      'prioritization-frameworks',
      'intended-vs-implemented',
      'test-scenarios'
    ]) {
      expect(frameworkById(id)?.guidance?.trim().length, id).toBeGreaterThan(0)
    }
  })
})

describe('composeFrameworkGuidance', () => {
  it('builds a labelled, attributed block for known frameworks', () => {
    const guidance = composeFrameworkGuidance(['wwa'])
    expect(guidance).toContain('Apply the following product-management framework(s):')
    expect(guidance).toContain('## Why-What-Acceptance backlog items')
    expect(guidance).toContain('(adapted from the pm-execution/wwas PM skill)')
    expect(guidance).toContain('Why-What-Acceptance backlog format')
  })

  it('joins multiple frameworks', () => {
    const guidance = composeFrameworkGuidance(['intended-vs-implemented', 'test-scenarios'])
    expect(guidance).toContain('## Intended-vs-implemented gap audit')
    expect(guidance).toContain('## Test scenarios per criterion')
  })

  it('returns empty string for unknown or guidance-less ids', () => {
    expect(composeFrameworkGuidance([])).toBe('')
    expect(composeFrameworkGuidance(['does-not-exist'])).toBe('')
    // `clarify` is a generic action with no guidance.
    expect(composeFrameworkGuidance(['clarify'])).toBe('')
  })
})
