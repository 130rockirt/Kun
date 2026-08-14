import {
  PPT_GEOMETRY_QA_RELATIVE_PATH,
  type PptGeometryQaReportV1
} from '../../ppt/ppt-geometry-qa-report.js'
import {
  PptReviewManifestV1,
  type PptGeometryQaManifestProjection,
  type PptReviewBundleV1
} from '../../ppt/ppt-review-manifest.js'

export const MAX_PPT_GEOMETRY_QA_REPAIR_ATTEMPTS = 2

export type PptGeometryQaDisposition = {
  manifest: PptReviewManifestV1
  projection: PptGeometryQaManifestProjection
  blocked: boolean
  exhausted: boolean
  repairAttemptsRemaining: number
}

export function nextPptGeometryQaAttempt(manifest: PptReviewManifestV1 | undefined): number | undefined {
  const previous = manifest?.qa
  if (!previous || previous.counts.errors === 0) return 0
  if (previous.attempt >= MAX_PPT_GEOMETRY_QA_REPAIR_ATTEMPTS) return undefined
  return previous.attempt + 1
}

export function projectPptGeometryQaReport(
  manifest: PptReviewManifestV1,
  report: PptGeometryQaReportV1
): PptGeometryQaDisposition {
  if (report.slideCount !== manifest.slides.length) {
    throw new Error(`geometry QA slide count ${report.slideCount} does not match review manifest ${manifest.slides.length}`)
  }
  const blocked = report.counts.errors > 0
  const exhausted = blocked && report.attempt >= MAX_PPT_GEOMETRY_QA_REPAIR_ATTEMPTS
  const projection: PptGeometryQaManifestProjection = {
    reportPath: PPT_GEOMETRY_QA_RELATIVE_PATH,
    attempt: report.attempt,
    counts: report.counts
  }
  const nextManifest = PptReviewManifestV1.parse({
    ...manifest,
    phase: blocked ? (exhausted ? 'failed_recoverable' : 'validating_deck') : 'validating_deck',
    qa: projection,
    validatedExport: undefined,
    slides: manifest.slides.map((slide) => ({
      ...slide,
      qaIssues: report.issues.filter((issue) => issue.slideIndex === slide.index)
    }))
  })
  return {
    manifest: nextManifest,
    projection,
    blocked,
    exhausted,
    repairAttemptsRemaining: blocked
      ? Math.max(0, MAX_PPT_GEOMETRY_QA_REPAIR_ATTEMPTS - report.attempt)
      : 0
  }
}

export function pptGeometryQaFailureOutput(input: {
  report: PptGeometryQaReportV1
  disposition: PptGeometryQaDisposition
  reviewBundle?: PptReviewBundleV1
}): {
  error: string
  validated: false
  phase: 'validating_deck' | 'failed_recoverable'
  qa: PptGeometryQaManifestProjection
  issues: PptGeometryQaReportV1['issues']
  repairAttemptsRemaining: number
  reviewBundle?: PptReviewBundleV1
} {
  const { report, disposition } = input
  return {
    error: disposition.exhausted
      ? `PPT geometry QA still has ${report.counts.errors} error(s) after two repair attempts`
      : `PPT geometry QA found ${report.counts.errors} error(s); repair the reported shapes and call ppt_export again`,
    validated: false,
    phase: disposition.exhausted ? 'failed_recoverable' : 'validating_deck',
    qa: disposition.projection,
    issues: report.issues,
    repairAttemptsRemaining: disposition.repairAttemptsRemaining,
    ...(input.reviewBundle ? { reviewBundle: input.reviewBundle } : {})
  }
}
