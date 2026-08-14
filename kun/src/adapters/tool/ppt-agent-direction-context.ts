import type { DelegationRuntime } from '../../delegation/delegation-runtime.js'
import { PptDirectionBundleV1, type PptDirectionBundleV1 as DirectionBundle } from '../../ppt/ppt-direction-workflow.js'
import { PptReviewBundleV1, type PptPreviewMode } from '../../ppt/ppt-review-manifest.js'

export type PptDirectionIdentityContext = {
  workflowId: string
  childId: string
  directions: ReadonlyArray<{ directionId: string; revision: number }>
}

export type PptDirectionIdentityResult =
  | {
      ok: true
      previewMode: PptPreviewMode
      manifestPath: string
      bundle: DirectionBundle
      authority: DirectionBundle['directions']
    }
  | { ok: false; error: string }

export async function validatePersistedPptDirectionIdentity(
  runtime: DelegationRuntime,
  parentThreadId: string,
  childId: string,
  workflowId: string,
  context?: PptDirectionIdentityContext
): Promise<PptDirectionIdentityResult> {
  let child
  try {
    child = (await runtime.diagnostics(parentThreadId)).childRuns.find((record) => record.id === childId)
  } catch {
    return fail(`persisted direction bundle for child ${childId} is unavailable`)
  }
  if (!child) return fail(`child ${childId} was not found in parent thread ${parentThreadId}`)
  if (!child.directionBundleParentTurnId) {
    return fail(`child ${childId} has no visual direction bundle fence`)
  }
  const laterReview = PptReviewBundleV1.safeParse(child.reviewBundle)
  if (
    laterReview.success &&
    laterReview.data.childId === childId &&
    laterReview.data.workflowId === workflowId
  ) {
    return fail(`visual direction bundle for workflow ${workflowId} is stale after slide review began`)
  }
  if (child.deckArtifact && child.deckArtifactParentTurnId &&
    child.deckArtifactParentTurnId !== child.directionBundleParentTurnId) {
    return fail(`visual direction bundle for workflow ${workflowId} is stale after export`)
  }
  const parsed = PptDirectionBundleV1.safeParse(child.directionBundle)
  if (!parsed.success) return fail(`child ${childId} has no valid persisted direction bundle`)
  const bundle = parsed.data
  if (bundle.childId !== childId || bundle.workflowId !== workflowId) {
    return fail(`persisted direction bundle does not match child ${childId} and workflow ${workflowId}`)
  }
  if (context && (context.childId !== childId || context.workflowId !== workflowId)) {
    return fail(`direction context does not match child ${childId} and workflow ${workflowId}`)
  }
  if ((context?.directions.length ?? 0) > 1) return fail('select at most one direction card')
  const requested = context?.directions[0]
  if (requested) {
    const candidate = bundle.directions.find((direction) => direction.directionId === requested.directionId)
    if (!candidate) return fail(`unknown directionId ${requested.directionId}`)
    if (candidate.revision !== requested.revision) {
      return fail(`stale direction revision for ${requested.directionId}: expected ${candidate.revision}, received ${requested.revision}`)
    }
  }
  return {
    ok: true,
    previewMode: bundle.previewMode,
    manifestPath: bundle.manifestPath,
    bundle,
    authority: bundle.directions
  }
}

function fail(message: string): PptDirectionIdentityResult {
  return { ok: false, error: `PPT source unavailable: ${message}` }
}
