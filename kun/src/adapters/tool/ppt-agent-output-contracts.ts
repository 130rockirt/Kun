import {
  PptReviewBundleV1,
  type PptPreviewMode
} from '../../ppt/ppt-review-manifest.js'
import { PptDirectionBundleV1 } from '../../ppt/ppt-direction-workflow.js'

export function directionBundleContractError(
  value: unknown,
  childId: string,
  workflowId: string,
  projectDir: string,
  previewMode: PptPreviewMode
): string {
  if (value === undefined) return ''
  const parsed = PptDirectionBundleV1.safeParse(value)
  if (!parsed.success) return 'PPT child returned an invalid visual direction bundle'
  const bundle = parsed.data
  if (bundle.childId !== childId || bundle.workflowId !== workflowId) {
    return 'PPT visual direction bundle does not belong to the active child workflow'
  }
  if (bundle.manifestPath.replaceAll('\\', '/') !== `${projectDir}/.kun-ppt-review/manifest.json`) {
    return 'PPT visual direction bundle does not belong to the host-managed project'
  }
  if (bundle.previewMode !== previewMode) return 'PPT visual direction bundle changed the workflow preview mode'
  return ''
}

export function reviewBundleContractError(
  value: unknown,
  childId: string,
  workflowId: string,
  projectDir: string,
  previewMode: PptPreviewMode
): string {
  if (value === undefined) return ''
  const parsed = PptReviewBundleV1.safeParse(value)
  if (!parsed.success) return 'PPT child returned an invalid visual review bundle'
  const bundle = parsed.data
  if (bundle.childId !== childId) return 'PPT visual review bundle does not belong to the resumed child'
  if (bundle.workflowId !== workflowId) {
    return 'PPT visual review bundle does not match the requested workflow'
  }
  const expectedManifest = `${projectDir}/.kun-ppt-review/manifest.json`
  if (bundle.manifestPath.replaceAll('\\', '/') !== expectedManifest) {
    return 'PPT visual review bundle does not belong to the host-managed project'
  }
  if (bundle.previewMode !== previewMode) {
    return 'PPT visual review bundle changed the workflow preview mode'
  }
  const completedQaProjection = bundle.phase === 'completed' &&
    bundle.slides.every((slide) =>
      slide.qaIssues !== undefined && slide.qaIssues.every((issue) => issue.severity !== 'error'))
  if (bundle.phase !== 'awaiting_review' && bundle.phase !== 'failed_recoverable' && !completedQaProjection) {
    return 'PPT visual review bundle is neither awaiting review, recoverable after QA, nor a completed QA projection'
  }
  return ''
}

export function validatedDeckArtifact(
  value: unknown,
  workflowId: string,
  projectDir: string,
  planFingerprint: string | undefined
): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const artifact = value as Record<string, unknown>
  if (
    artifact.validated !== true ||
    typeof artifact.output !== 'string' ||
    !planFingerprint ||
    artifact.workflowId !== workflowId ||
    artifact.projectDir !== projectDir ||
    artifact.planFingerprint !== planFingerprint
  ) return false
  const output = artifact.output.replaceAll('\\', '/')
  const parts = output.split('/')
  if (
    parts.length < 2 ||
    parts[0] !== 'presentations' ||
    parts.some((part) => !part || part === '.' || part === '..') ||
    !parts.at(-1)?.toLowerCase().endsWith('.pptx')
  ) return false
  return (
    typeof artifact.slides === 'number' &&
    Number.isInteger(artifact.slides) &&
    artifact.slides > 0 &&
    artifact.editableSlides === artifact.slides
  )
}
