import { describe, expect, it } from 'vitest'
import type { DelegationRuntime } from '../../delegation/delegation-runtime.js'
import { TurnSchema, type Turn } from '../../contracts/turns.js'
import type { ToolHostContext } from '../../ports/tool-host.js'
import { pptDirectionSlidesFingerprint } from '../../ppt/ppt-direction-workflow.js'
import {
  buildPptAgentToolProvider,
  type PptAgentTurnReader
} from './ppt-agent-tool-provider.js'

const childId = 'child_direction'

const baseContext: ToolHostContext = {
  threadId: 'parent',
  turnId: 'turn_start',
  workspace: '/workspace',
  agentSurface: 'design',
  clientSurface: 'gui',
  approvalPolicy: 'auto',
  approvalReviewer: 'user',
  allowedArtifactIds: ['artifact-allowed'],
  blockedSkillIds: ['skill-blocked'],
  awaitApproval: async () => 'allow',
  model: {
    id: 'main-model',
    inputModalities: ['text'], outputModalities: ['text'], supportsToolCalling: true,
    messageParts: ['text'], contextWindowTokens: 128_000
  },
  abortSignal: new AbortController().signal
}

function directionBundle(workflowId: string, revision = 1) {
  const slides = [{ slideId: 'slide-1', index: 0, title: 'Opening', promptHash: 'f'.repeat(64) }]
  return {
    schemaVersion: 1,
    workflowId,
    childId,
    manifestPath: `.kun/ppt/${workflowId}/.kun-ppt-review/manifest.json`,
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
      revision,
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
}

function reviewBundle(workflowId: string) {
  return {
    workflowId,
    childId,
    manifestPath: `.kun/ppt/${workflowId}/.kun-ppt-review/manifest.json`,
    previewMode: 'image-first',
    deckTitle: 'Launch deck',
    styleFingerprint: 'style-1',
    designGovernance: {
      policyVersion: '1.0.0', policyHash: 'b'.repeat(64), category: 'tech-engineering',
      categoryGuide: 'slides_categories/tech-engineering.md', planFingerprint: 'a'.repeat(64), planRevision: 1
    },
    phase: 'awaiting_review',
    slides: [{
      slideId: 'slide-1', index: 0, title: 'Opening', previewPath: '.kun/images/opening.png',
      revision: 1, status: 'ready'
    }]
  }
}

type FakeRuntime = {
  runtime: DelegationRuntime
  calls: Array<Record<string, unknown>>
  omitFreshRevision: () => void
  failWithFreshRevision: () => void
}

function fakeRuntime(): FakeRuntime {
  const calls: Array<Record<string, unknown>> = []
  let record: Record<string, unknown> | undefined
  let omitRevision = false
  let failRevision = false
  const runtime = {
    enabled: () => true,
    diagnostics: async (parentThreadId: string) => ({
      enabled: true, active: 0,
      childRuns: parentThreadId === 'parent' && record ? [record] : [], aggregates: []
    }),
    runChild: async (input: Record<string, unknown>) => {
      calls.push(input)
      const scope = input.pptWorkflowScope as { workflowId: string }
      const bundle = directionBundle(scope.workflowId)
      record = {
        id: childId, parentTurnId: input.parentTurnId, status: 'completed', summary: 'directions ready', directionBundle: bundle,
        directionBundleParentTurnId: input.parentTurnId,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
      }
      return record
    },
    resumeChild: async (input: Record<string, unknown>) => {
      calls.push(input)
      const scope = input.pptWorkflowScope as { action: string; workflowId: string }
      if (scope.action === 'select_direction') {
        record = {
          ...record,
          id: childId, parentTurnId: input.parentTurnId, status: 'completed', summary: 'review ready',
          reviewBundle: reviewBundle(scope.workflowId),
          reviewBundleParentTurnId: input.parentTurnId
        }
      } else if (!omitRevision) {
        record = {
          ...record,
          id: childId, parentTurnId: input.parentTurnId, status: failRevision ? 'failed' : 'completed', summary: 'directions revised',
          directionBundle: directionBundle(scope.workflowId, 2),
          directionBundleParentTurnId: input.parentTurnId
        }
      } else {
        record = { ...record, id: childId, parentTurnId: input.parentTurnId, status: 'completed', summary: 'forgot bundle' }
      }
      return record
    }
  } as unknown as DelegationRuntime
  return {
    runtime,
    calls,
    omitFreshRevision: () => { omitRevision = true },
    failWithFreshRevision: () => { failRevision = true }
  }
}

function sourceReader(input: {
  workflowId: () => string
  directions?: (turnId: string) => Array<{ workflowId: string; childId: string; directions: Array<{ directionId: string; revision: number }> }>
  prompt?: (turnId: string) => string
}): PptAgentTurnReader {
  return {
    getTurn: async (threadId, turnId): Promise<Turn> => {
      const prompt = input.prompt?.(turnId) ??
        (turnId === 'turn_start' ? 'Create a new Kun launch presentation.' : 'Adopt this selected direction.')
      const composerContexts = (input.directions?.(turnId) ?? []).map((selection, index) => ({
        schemaVersion: 1 as const,
        id: `preview-ppt-direction-${String(index + 1).padStart(24, '0')}`,
        title: 'PPT direction',
        summary: 'Selected visual direction',
        reference: {
          kind: 'ppt-direction', schemaVersion: 1,
          workflowId: selection.workflowId, childId: selection.childId, directions: selection.directions
        },
        revision: 1,
        generation: 1,
        attachmentId: `dev-preview-context:${String(index + 1).repeat(64).slice(0, 64)}`,
        provenance: { source: 'dev-preview' as const, workspaceId: 'a'.repeat(64) }
      }))
      return TurnSchema.parse({
        id: turnId, threadId, status: 'running', prompt, agentSurface: 'design', composerContexts,
        items: [{
          id: `item_${turnId}`, turnId, threadId, kind: 'user_message', role: 'user', status: 'completed',
          text: prompt, composerContexts, createdAt: '2026-08-12T00:00:00.000Z'
        }],
        createdAt: '2026-08-12T00:00:00.000Z'
      })
    }
  }
}

function tool(fake: FakeRuntime, reader: PptAgentTurnReader) {
  return buildPptAgentToolProvider(fake.runtime, () => ({
    enabled: true, imageFirst: true, imageGenAvailable: true
  }), reader)[0].tools[0]
}

describe('ppt_agent visual direction lifecycle', () => {
  it('gates an underspecified new deck into exactly one fresh direction bundle', async () => {
    const fake = fakeRuntime()
    let workflowId = ''
    const result = await tool(fake, sourceReader({ workflowId: () => workflowId }))
      .execute({}, baseContext)
    workflowId = (result.output as { workflowId: string }).workflowId
    expect(result).toMatchObject({
      isError: false,
      output: {
        childId,
        workflowId: expect.stringMatching(/^ppt_/),
        phase: 'awaiting_direction',
        directionBundle: { directions: expect.any(Array) }
      }
    })
    expect((result.output as { directionBundle: { directions: unknown[] } }).directionBundle.directions).toHaveLength(3)
    expect(fake.calls[0]?.pptWorkflowScope).toMatchObject({
      action: 'start',
      directionGate: {
        required: true,
        reason: 'underspecified-new-deck',
        sourceHash: expect.stringMatching(/^[a-f0-9]{64}$/)
      }
    })
    expect(String(fake.calls[0]?.controlPrompt)).toContain('create exactly three materially distinct')
    expect(String(fake.calls[0]?.controlPrompt)).toContain('Do not call ppt_submit_design_plan')
    expect(fake.calls[0]?.security).toMatchObject({
      allowedArtifactIds: ['artifact-allowed'],
      blockedSkillIds: ['skill-blocked']
    })
  })

  it('keeps the child failure detail alongside a missing visual direction bundle', async () => {
    const failedRuntime = {
      enabled: () => true,
      runChild: async (input: Record<string, unknown>) => ({
        id: childId,
        parentTurnId: input.parentTurnId,
        status: 'failed',
        summary: '',
        error: 'image provider request timed out',
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
      })
    } as unknown as DelegationRuntime
    const ppt = buildPptAgentToolProvider(failedRuntime, () => ({
      enabled: true, imageFirst: true, imageGenAvailable: true
    }), sourceReader({ workflowId: () => '' }))[0].tools[0]

    const result = await ppt.execute({ title: 'Review deck' }, {
      ...baseContext,
      agentSurface: 'code'
    })

    expect(result).toMatchObject({
      isError: true,
      output: { error: expect.stringContaining('PPT child completed without the required visual direction bundle') }
    })
    expect((result.output as { error: string }).error).toContain('image provider request timed out')
  })

  it('validates one selected card, strips it from child source, and resumes into slide review', async () => {
    const fake = fakeRuntime()
    let activeWorkflow = ''
    const reader = sourceReader({
      workflowId: () => activeWorkflow,
      directions: (turnId) => turnId === 'turn_select'
        ? [{
            workflowId: activeWorkflow,
            childId,
            directions: [{ directionId: 'direction-3', revision: 1 }]
          }]
        : []
    })
    const ppt = tool(fake, reader)
    const started = await ppt.execute({}, baseContext)
    activeWorkflow = (started.output as { workflowId: string }).workflowId
    const selected = await ppt.execute({
      action: 'select_direction', childId, workflowId: activeWorkflow
    }, { ...baseContext, turnId: 'turn_select' })
    expect(selected).toMatchObject({
      isError: false,
      output: { phase: 'awaiting_review', reviewBundle: { workflowId: activeWorkflow } }
    })
    expect(fake.calls[1]?.pptWorkflowScope).toMatchObject({
      action: 'select_direction',
      directionContext: { childId, directions: [{ directionId: 'direction-3', revision: 1 }] }
    })
    expect(fake.calls[1]?.source).toMatchObject({ composerContexts: [] })

    await expect(ppt.execute({
      action: 'select_direction', childId, workflowId: activeWorkflow
    }, { ...baseContext, turnId: 'turn_select' })).resolves.toMatchObject({
      isError: true, output: { error: expect.stringContaining('stale') }
    })
    expect(fake.calls).toHaveLength(2)
  })

  it('rejects stale direction context before resume and does not reuse an old revision bundle', async () => {
    const fake = fakeRuntime()
    let activeWorkflow = ''
    const reader = sourceReader({
      workflowId: () => activeWorkflow,
      directions: (turnId) => turnId === 'turn_stale'
        ? [{ workflowId: activeWorkflow, childId, directions: [{ directionId: 'direction-1', revision: 9 }] }]
        : []
    })
    const ppt = tool(fake, reader)
    const started = await ppt.execute({}, baseContext)
    activeWorkflow = (started.output as { workflowId: string }).workflowId
    await expect(ppt.execute({
      action: 'revise_directions', childId, workflowId: activeWorkflow
    }, { ...baseContext, turnId: 'turn_stale' })).resolves.toMatchObject({
      isError: true,
      output: { error: expect.stringContaining('stale direction revision') }
    })
    expect(fake.calls).toHaveLength(1)

    fake.omitFreshRevision()
    const forgotten = await ppt.execute({
      action: 'revise_directions', childId, workflowId: activeWorkflow
    }, { ...baseContext, turnId: 'turn_no_selection' })
    expect(forgotten).toMatchObject({
      isError: true,
      output: { error: 'PPT child completed without the required visual direction bundle' }
    })
    expect(forgotten.output).not.toHaveProperty('directionBundle')
  })

  it('surfaces a fresh validated direction bundle even when the child fails after creating it', async () => {
    const fake = fakeRuntime()
    let activeWorkflow = ''
    const ppt = tool(fake, sourceReader({ workflowId: () => activeWorkflow }))
    const started = await ppt.execute({}, baseContext)
    activeWorkflow = (started.output as { workflowId: string }).workflowId
    fake.failWithFreshRevision()

    await expect(ppt.execute({
      action: 'revise_directions', childId, workflowId: activeWorkflow
    }, { ...baseContext, turnId: 'turn_failed_after_bundle' })).resolves.toMatchObject({
      isError: false,
      output: {
        status: 'failed',
        phase: 'awaiting_direction',
        directionBundle: { directions: [{ revision: 2 }, { revision: 2 }, { revision: 2 }] }
      }
    })
  })

  it('allows only explicit, non-negated acceptance to select the host recommendation', async () => {
    for (const prompt of ['Adopt the recommended direction.', '采用推荐方案。']) {
      const fake = fakeRuntime()
      let activeWorkflow = ''
      const ppt = tool(fake, sourceReader({
        workflowId: () => activeWorkflow,
        prompt: (turnId) => turnId === 'turn_start' ? 'Create a new Kun launch presentation.' : prompt
      }))
      const started = await ppt.execute({}, baseContext)
      activeWorkflow = (started.output as { workflowId: string }).workflowId
      await expect(ppt.execute({
        action: 'select_direction', childId, workflowId: activeWorkflow
      }, { ...baseContext, turnId: 'turn_accept' })).resolves.toMatchObject({
        isError: false, output: { phase: 'awaiting_review' }
      })
    }

    for (const prompt of [
      'Use any suitable direction.',
      'Do not use the recommended direction.',
      '不要采用推荐方案。',
      'Should I use the recommended direction?',
      'I refuse to use the recommended direction.',
      'I might use the recommended direction later.',
      'Accept no recommended direction.',
      'Why would we choose the recommended direction?'
    ]) {
      const fake = fakeRuntime()
      let activeWorkflow = ''
      const ppt = tool(fake, sourceReader({
        workflowId: () => activeWorkflow,
        prompt: (turnId) => turnId === 'turn_start' ? 'Create a new Kun launch presentation.' : prompt
      }))
      const started = await ppt.execute({}, baseContext)
      activeWorkflow = (started.output as { workflowId: string }).workflowId
      await expect(ppt.execute({
        action: 'select_direction', childId, workflowId: activeWorkflow
      }, { ...baseContext, turnId: 'turn_reject' })).resolves.toMatchObject({
        isError: true, output: { error: expect.stringContaining('explicitly accept') }
      })
      expect(fake.calls).toHaveLength(1)
    }
  })

  it('rejects mixed valid and foreign direction contexts before resuming the child', async () => {
    const fake = fakeRuntime()
    let activeWorkflow = ''
    const ppt = tool(fake, sourceReader({
      workflowId: () => activeWorkflow,
      directions: (turnId) => turnId === 'turn_mixed'
        ? [
            { workflowId: activeWorkflow, childId, directions: [{ directionId: 'direction-1', revision: 1 }] },
            { workflowId: 'foreign-workflow', childId: 'foreign-child', directions: [{ directionId: 'direction-2', revision: 1 }] }
          ]
        : []
    }))
    const started = await ppt.execute({}, baseContext)
    activeWorkflow = (started.output as { workflowId: string }).workflowId
    await expect(ppt.execute({
      action: 'revise_directions', childId, workflowId: activeWorkflow
    }, { ...baseContext, turnId: 'turn_mixed' })).resolves.toMatchObject({
      isError: true, output: { error: expect.stringContaining('does not match') }
    })
    expect(fake.calls).toHaveLength(1)
  })

  it('requires explicit adoption intent even when one valid direction card is selected', async () => {
    for (const prompt of ['Inspect this selected direction.', 'Do not adopt this direction.']) {
      const fake = fakeRuntime()
      let activeWorkflow = ''
      const ppt = tool(fake, sourceReader({
        workflowId: () => activeWorkflow,
        prompt: (turnId) => turnId === 'turn_start' ? 'Create a new Kun launch presentation.' : prompt,
        directions: (turnId) => turnId === 'turn_intent'
          ? [{
              workflowId: activeWorkflow,
              childId,
              directions: [{ directionId: 'direction-1', revision: 1 }]
            }]
          : []
      }))
      const started = await ppt.execute({}, baseContext)
      activeWorkflow = (started.output as { workflowId: string }).workflowId
      await expect(ppt.execute({
        action: 'select_direction', childId, workflowId: activeWorkflow
      }, { ...baseContext, turnId: 'turn_intent' })).resolves.toMatchObject({
        isError: true, output: { error: expect.stringContaining('explicitly adopt') }
      })
      expect(fake.calls).toHaveLength(1)
    }
  })
})
