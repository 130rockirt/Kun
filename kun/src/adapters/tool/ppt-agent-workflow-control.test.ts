import { describe, expect, it } from 'vitest'
import {
  blocksPptExport,
  effectivePptProviderId,
  imageFirstFallbackNotice,
  managedPptProviderUnavailable,
  visualWorkflowInstruction
} from './ppt-agent-workflow-control.js'

describe('PPT agent workflow control', () => {
  it('handles the implicit default provider alias in the managed-tool preflight', () => {
    const config = { defaultProviderLacksManagedTools: true }
    expect(managedPptProviderUnavailable(config, undefined)).toBe(true)
    expect(managedPptProviderUnavailable(config, ' DEFAULT ')).toBe(true)
    expect(managedPptProviderUnavailable(config, 'deepseek')).toBe(false)
  })

  it('resolves a complete Lab model override before inherited provider routes', () => {
    const config = {
      model: 'claude-sonnet',
      providerId: ' cursor-lab ',
      toolIncompatibleProviderIds: ['cursor-lab']
    }
    const providerId = effectivePptProviderId(
      config,
      {
        actingModelRoute: { providerId: 'acting-provider', model: 'acting-model' },
        modelProviderId: 'session-provider'
      }
    )
    expect(providerId).toBe('cursor-lab')
    expect(managedPptProviderUnavailable(config, providerId)).toBe(true)
    expect(effectivePptProviderId(
      { providerId: 'incomplete-lab-override' },
      {
        actingModelRoute: { providerId: 'acting-provider', model: 'acting-model' },
        modelProviderId: 'session-provider'
      }
    )).toBe('acting-provider')
  })

  it('resolves the acting route before the inherited model provider and preserves default', () => {
    const config = { toolIncompatibleProviderIds: ['cursor-acting', 'cursor-session'] }
    const actingProvider = effectivePptProviderId(
      config,
      {
        actingModelRoute: { providerId: 'cursor-acting', model: 'cursor-model' },
        modelProviderId: 'cursor-session'
      }
    )
    const inheritedProvider = effectivePptProviderId(
      config,
      { modelProviderId: ' cursor-session ' }
    )
    expect(actingProvider).toBe('cursor-acting')
    expect(inheritedProvider).toBe('cursor-session')
    expect(managedPptProviderUnavailable(config, actingProvider)).toBe(true)
    expect(managedPptProviderUnavailable(config, inheritedProvider)).toBe(true)
    expect(effectivePptProviderId({}, { modelProviderId: ' default ' })).toBe('default')
    expect(effectivePptProviderId({}, {})).toBeUndefined()
  })

  it('fails closed for configured Cursor providers despite case or surrounding whitespace', () => {
    const config = { toolIncompatibleProviderIds: ['antigravity', ' Cursor-Lab '] }
    expect(managedPptProviderUnavailable(config, 'cursor-lab')).toBe(true)
    expect(managedPptProviderUnavailable(config, ' CURSOR-LAB ')).toBe(true)
    expect(managedPptProviderUnavailable(config, 'deepseek')).toBe(false)
  })

  it('blocks export throughout review and opens it only after approval', () => {
    expect(blocksPptExport('start')).toBe(true)
    expect(blocksPptExport('revise_previews')).toBe(true)
    expect(blocksPptExport('retry_failed')).toBe(true)
    expect(blocksPptExport('approve_and_build')).toBe(false)
  })

  it('uses editable PPTD previews when image generation is unavailable', () => {
    const config = { imageFirst: true, imageGenAvailable: false, imageGenReason: 'not configured' }
    const started = visualWorkflowInstruction(
      config, 'editable', 'start', 'ppt_workflow', 'thr_parent', '.kun/ppt/ppt_workflow', false
    )
    const revised = visualWorkflowInstruction(
      config, 'editable', 'revise_previews', 'ppt_workflow', 'thr_parent', '.kun/ppt/ppt_workflow', true
    )

    expect(started).toContain('ppt_generate_previews')
    expect(started).toContain('stop at awaiting_review')
    expect(revised).toContain('PPT EDITABLE REVIEW FOLLOW-UP')
    expect(revised).toContain('ppt_generate_previews')
    expect(imageFirstFallbackNotice(config, 'start')).toContain('keep the review phase')
  })

  it('imports approved generated assets before the editable build', () => {
    const instruction = visualWorkflowInstruction(
      {}, 'image-first', 'approve_and_build',
      'ppt_workflow', 'thr_parent', '.kun/ppt/ppt_workflow', true
    )
    expect(instruction).toContain('ppt_import_asset')
    expect(instruction).toContain('native editable PPTD')
  })
})
