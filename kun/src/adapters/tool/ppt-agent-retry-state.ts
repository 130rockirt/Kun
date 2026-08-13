import type { DelegationRuntime } from '../../delegation/delegation-runtime.js'
import { PptDirectionBundleV1 } from '../../ppt/ppt-direction-workflow.js'
import { PptReviewBundleV1 } from '../../ppt/ppt-review-manifest.js'
import type { PptWorkflowScope } from '../../ports/tool-host.js'

export type PptRetryState = {
  stage: 'direction' | 'review'
  previewMode: 'image-first' | 'editable'
  directionGate?: NonNullable<PptWorkflowScope['directionGate']>
  hasDirectionBundle: boolean
  hasReviewBundle: boolean
}

export type PptRetryStateResolution =
  | { ok: true; value: PptRetryState }
  | { ok: false; error: string }

/** Resolve retry semantics from durable host state, never from model prose. */
export async function resolvePptRetryState(input: {
  runtime: DelegationRuntime
  parentThreadId: string
  childId: string
  workflowId: string
}): Promise<PptRetryStateResolution> {
  let child
  try {
    child = (await input.runtime.diagnostics(input.parentThreadId)).childRuns
      .find((record) => record.id === input.childId)
  } catch {
    return fail(`persisted workflow for child ${input.childId} is unavailable`)
  }
  if (!child) return fail(`child ${input.childId} was not found in parent thread ${input.parentThreadId}`)
  if (
    (child.parentThreadId && child.parentThreadId !== input.parentThreadId) ||
    (child.launcher && child.launcher !== 'ppt_agent') ||
    (child.profile && child.profile !== 'ppt')
  ) {
    return fail(`child ${input.childId} is not owned by this PPT workflow`)
  }

  const direction = PptDirectionBundleV1.safeParse(child.directionBundle)
  const review = PptReviewBundleV1.safeParse(child.reviewBundle)
  const hasDirectionBundle = direction.success &&
    direction.data.childId === input.childId && direction.data.workflowId === input.workflowId
  const hasReviewBundle = review.success &&
    review.data.childId === input.childId && review.data.workflowId === input.workflowId
  const persisted = child.pptWorkflow
  if (persisted) {
    if (persisted.workflowId !== input.workflowId) {
      return fail(`child ${input.childId} does not own workflow ${input.workflowId}`)
    }
    if (persisted.stage === 'build') {
      return fail('a failed build must be continued with approve_and_build, not retry_failed')
    }
    return {
      ok: true,
      value: {
        stage: persisted.stage,
        previewMode: persisted.previewMode,
        ...(persisted.directionGate ? { directionGate: persisted.directionGate } : {}),
        hasDirectionBundle,
        hasReviewBundle
      }
    }
  }

  // Legacy successful bundles remain retryable after upgrading. A legacy run
  // that failed before its first bundle has no durable workflow identity and
  // cannot be resumed safely.
  if (hasReviewBundle && review.success && review.data.previewMode) {
    return {
      ok: true,
      value: {
        stage: 'review',
        previewMode: review.data.previewMode,
        hasDirectionBundle,
        hasReviewBundle: true
      }
    }
  }
  if (hasDirectionBundle && direction.success) {
    return {
      ok: true,
      value: {
        stage: 'direction',
        previewMode: direction.data.previewMode,
        hasDirectionBundle: true,
        hasReviewBundle: false
      }
    }
  }
  return fail(`child ${input.childId} has no durable PPT phase to retry; start a new PPT workflow`)
}

function fail(error: string): PptRetryStateResolution {
  return { ok: false, error: `PPT source unavailable: ${error}` }
}
