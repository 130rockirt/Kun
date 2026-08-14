import { describe, expect, it } from 'vitest'
import type { DelegationRuntime } from '../../delegation/delegation-runtime.js'
import { pptDirectionSlidesFingerprint } from '../../ppt/ppt-direction-workflow.js'
import { validatePersistedPptDirectionIdentity } from './ppt-agent-direction-context.js'

const workflowId = 'ppt_workflow'
const childId = 'child_ppt'
const slides = [{ slideId: 'slide-1', index: 0, title: 'Opening', promptHash: 'f'.repeat(64) }]
const bundle = {
  schemaVersion: 1,
  workflowId,
  childId,
  manifestPath: '.kun/ppt/ppt_workflow/.kun-ppt-review/manifest.json',
  previewMode: 'image-first',
  deckTitle: 'Launch deck',
  phase: 'awaiting_direction',
  recommendedDirectionId: 'direction-2',
  slidesFingerprint: pptDirectionSlidesFingerprint(slides),
  slides,
  directions: [1, 2, 3].map((index) => ({
    directionId: `direction-${index}`,
    name: `Direction ${index}`,
    rationale: `Distinct visual direction ${index}`,
    revision: index,
    recommended: index === 2,
    planFingerprint: String(index).repeat(64),
    candidateFingerprint: String(index + 3).repeat(64),
    fonts: ['Inter', 'Source Sans 3'],
    colors: ['#112233', '#334455', '#556677', '#778899'],
    layout: `Layout system ${index}`,
    background: 'solid',
    imagery: `Documentary imagery ${index}`,
    previews: [
      { role: 'cover', imagePath: `.kun/images/${index}-cover.png`, sha256: `${index}1`.repeat(32), width: 160, height: 90 },
      { role: 'representative', imagePath: `.kun/images/${index}-content.png`, sha256: `${index}2`.repeat(32), width: 160, height: 90 },
      { role: 'complex', imagePath: `.kun/images/${index}-complex.png`, sha256: `${index}3`.repeat(32), width: 160, height: 90 }
    ]
  }))
}

function runtime(directionBundle: unknown = bundle): DelegationRuntime {
  return {
    diagnostics: async (parentThreadId: string) => ({
      enabled: true,
      active: 0,
      childRuns: parentThreadId === 'parent' ? [{
        id: childId,
        parentTurnId: 'turn-direction',
        directionBundleParentTurnId: 'turn-direction',
        directionBundle
      }] : [],
      aggregates: []
    })
  } as unknown as DelegationRuntime
}

const reviewBundle = {
  workflowId,
  childId,
  manifestPath: '.kun/ppt/ppt_workflow/.kun-ppt-review/manifest.json',
  previewMode: 'image-first',
  deckTitle: 'Launch deck',
  styleFingerprint: 'style',
  phase: 'awaiting_review',
  slides: [{
    slideId: 'slide-1', index: 0, title: 'Opening',
    previewPath: '.kun/images/slide-1.png', revision: 1, status: 'ready'
  }]
}

describe('persisted PPT direction identity', () => {
  it('accepts a fresh single selection and the recommendation fallback', async () => {
    await expect(validatePersistedPptDirectionIdentity(
      runtime(), 'parent', childId, workflowId,
      { childId, workflowId, directions: [{ directionId: 'direction-2', revision: 2 }] }
    )).resolves.toMatchObject({ ok: true, previewMode: 'image-first' })
    await expect(validatePersistedPptDirectionIdentity(
      runtime(), 'parent', childId, workflowId,
      { childId, workflowId, directions: [] }
    )).resolves.toMatchObject({ ok: true })
  })

  it.each([
    ['stale revision', { childId, workflowId, directions: [{ directionId: 'direction-2', revision: 1 }] }, 'stale direction revision'],
    ['forged id', { childId, workflowId, directions: [{ directionId: 'direction-forged', revision: 1 }] }, 'unknown directionId'],
    ['multiple cards', {
      childId,
      workflowId,
      directions: [{ directionId: 'direction-1', revision: 1 }, { directionId: 'direction-2', revision: 2 }]
    }, 'at most one'],
    ['cross child', {
      childId: 'child-other', workflowId, directions: [{ directionId: 'direction-2', revision: 2 }]
    }, 'does not match child'],
    ['cross workflow', {
      childId, workflowId: 'ppt-other', directions: [{ directionId: 'direction-2', revision: 2 }]
    }, 'does not match child']
  ])('rejects %s context', async (_label, context, error) => {
    await expect(validatePersistedPptDirectionIdentity(
      runtime(), 'parent', childId, workflowId, context
    )).resolves.toMatchObject({ ok: false, error: expect.stringContaining(error) })
  })

  it('rejects a bundle that is not owned by the requested parent/child workflow', async () => {
    await expect(validatePersistedPptDirectionIdentity(
      runtime({ ...bundle, childId: 'child-other' }), 'parent', childId, workflowId
    )).resolves.toMatchObject({ ok: false, error: expect.stringContaining('does not match') })
    await expect(validatePersistedPptDirectionIdentity(
      runtime(), 'parent-other', childId, workflowId
    )).resolves.toMatchObject({ ok: false, error: expect.stringContaining('was not found') })
  })

  it('requires a producer fence while preserving the last host bundle after a failed resume', async () => {
    const noFence = {
      diagnostics: async () => ({
        enabled: true, active: 0, aggregates: [],
        childRuns: [{ id: childId, parentTurnId: 'turn-direction', directionBundle: bundle }]
      })
    } as unknown as DelegationRuntime
    await expect(validatePersistedPptDirectionIdentity(
      noFence, 'parent', childId, workflowId
    )).resolves.toMatchObject({ ok: false, error: expect.stringContaining('fence') })
    const retained = {
      diagnostics: async () => ({
        enabled: true, active: 0, aggregates: [],
        childRuns: [{
          id: childId,
          parentTurnId: 'turn-failed-resume',
          directionBundleParentTurnId: 'turn-direction',
          directionBundle: bundle
        }]
      })
    } as unknown as DelegationRuntime
    await expect(validatePersistedPptDirectionIdentity(
      retained, 'parent', childId, workflowId
    )).resolves.toMatchObject({ ok: true })
  })

  it('expires direction cards after the workflow advances to slide review', async () => {
    const advanced = {
      diagnostics: async () => ({
        enabled: true, active: 0, aggregates: [],
        childRuns: [{
          id: childId,
          parentTurnId: 'turn-review',
          directionBundleParentTurnId: 'turn-direction',
          directionBundle: bundle,
          reviewBundleParentTurnId: 'turn-review',
          reviewBundle
        }]
      })
    } as unknown as DelegationRuntime
    await expect(validatePersistedPptDirectionIdentity(
      advanced, 'parent', childId, workflowId,
      { childId, workflowId, directions: [{ directionId: 'direction-2', revision: 2 }] }
    )).resolves.toMatchObject({ ok: false, error: expect.stringContaining('stale') })

    const missingReviewFence = {
      diagnostics: async () => ({
        enabled: true, active: 0, aggregates: [],
        childRuns: [{
          id: childId,
          parentTurnId: 'turn-review',
          directionBundleParentTurnId: 'turn-direction',
          directionBundle: bundle,
          reviewBundle
        }]
      })
    } as unknown as DelegationRuntime
    await expect(validatePersistedPptDirectionIdentity(
      missingReviewFence, 'parent', childId, workflowId
    )).resolves.toMatchObject({ ok: false, error: expect.stringContaining('stale') })
  })
})
