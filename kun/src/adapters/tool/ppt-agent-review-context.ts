import type { DelegationRuntime } from '../../delegation/delegation-runtime.js'
import { PptReviewBundleV1, type PptPreviewMode } from '../../ppt/ppt-review-manifest.js'

export type PptReviewIdentityContext = {
  workflowId: string
  childId: string
  slides: ReadonlyArray<{
    slideId: string
    revision: number
  }>
}

export type PptReviewIdentityResult =
  | {
      ok: true
      previewMode?: PptPreviewMode
      manifestPath: string
      planFingerprint?: string
    }
  | { ok: false; error: string }

/**
 * Bind a structured follow-up context to the exact persisted review snapshot.
 * The canvas payload is metadata, not authority: it cannot name a new slide or
 * silently apply feedback to a newer/older revision than the child produced.
 */
export async function validatePersistedPptReviewIdentity(
  runtime: DelegationRuntime,
  parentThreadId: string,
  context: PptReviewIdentityContext
): Promise<PptReviewIdentityResult> {
  const seen = new Set<string>()
  for (const slide of context.slides) {
    if (seen.has(slide.slideId)) {
      return fail(`duplicate slideId ${slide.slideId} in structured review context`)
    }
    seen.add(slide.slideId)
  }

  let child
  try {
    const diagnostics = await runtime.diagnostics(parentThreadId)
    child = diagnostics.childRuns.find((record) => record.id === context.childId)
  } catch {
    return fail(`persisted review bundle for child ${context.childId} is unavailable`)
  }
  if (!child) return fail(`child ${context.childId} was not found in parent thread ${parentThreadId}`)

  const parsed = PptReviewBundleV1.safeParse(child.reviewBundle)
  if (!parsed.success) return fail(`child ${context.childId} has no valid persisted review bundle`)
  const bundle = parsed.data
  if (bundle.childId !== context.childId || bundle.workflowId !== context.workflowId) {
    return fail(`persisted review bundle does not match child ${context.childId} and workflow ${context.workflowId}`)
  }

  const persistedSlides = new Map(bundle.slides.map((slide) => [slide.slideId, slide]))
  for (const slide of context.slides) {
    const persisted = persistedSlides.get(slide.slideId)
    if (!persisted) {
      return fail(`unknown slideId ${slide.slideId} for workflow ${context.workflowId}`)
    }
    if (persisted.revision !== slide.revision) {
      return fail(
        `stale slide revision for ${slide.slideId}: expected ${persisted.revision}, received ${slide.revision}`
      )
    }
  }
  return {
    ok: true,
    ...(bundle.previewMode ? { previewMode: bundle.previewMode } : {}),
    manifestPath: bundle.manifestPath,
    ...(bundle.designGovernance?.planFingerprint
      ? { planFingerprint: bundle.designGovernance.planFingerprint }
      : {})
  }
}

function fail(message: string): PptReviewIdentityResult {
  return { ok: false, error: `PPT source unavailable: ${message}` }
}
