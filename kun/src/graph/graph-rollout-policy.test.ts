import { describe, expect, it } from 'vitest'
import { testGraphConfig } from './graph-test-fixtures.test-support.js'
import {
  effectiveGraphLearningMode,
  graphAutomaticSupervisionEnabled,
  graphLeadLifecycleSupervisionEnabled
} from './graph-rollout-policy.js'

describe('Graph rollout policy', () => {
  it('enables automatic capabilities only at their readiness gates', () => {
    expect(graphAutomaticSupervisionEnabled(testGraphConfig({
      rolloutStage: 'experimental'
    }))).toBe(false)
    expect(graphAutomaticSupervisionEnabled(testGraphConfig({
      rolloutStage: 'alpha'
    }))).toBe(true)
    expect(graphAutomaticSupervisionEnabled(testGraphConfig({
      rolloutStage: 'alpha',
      supervision: { autoStart: false }
    }))).toBe(false)
    expect(graphLeadLifecycleSupervisionEnabled(testGraphConfig({
      rolloutStage: 'experimental',
      supervision: { enabled: false, autoStart: false }
    }))).toBe(true)
    expect(graphLeadLifecycleSupervisionEnabled(testGraphConfig({
      enabled: false,
      rolloutStage: 'stable'
    }))).toBe(false)
    expect(effectiveGraphLearningMode(testGraphConfig({
      rolloutStage: 'beta',
      learning: { mode: 'suggest' }
    }))).toBe('off')
    expect(effectiveGraphLearningMode(testGraphConfig({
      rolloutStage: 'learning-preview',
      learning: { mode: 'auto_candidate' }
    }))).toBe('suggest')
    expect(effectiveGraphLearningMode(testGraphConfig({
      rolloutStage: 'stable',
      learning: { mode: 'auto_candidate' }
    }))).toBe('auto_candidate')
  })
})
