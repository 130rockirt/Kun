import type { ComposerContextAttachment, JsonObject } from '@kun/extension-api'
import { createDevPreviewComposerContextAttachment } from '../../lib/dev-preview-composer-context'
import type { SerializedPptReviewContext } from './ppt-review-board'

export const PPT_REVIEW_CONTEXT_KIND = 'ppt-review'

export type PptReviewComposerContextReference = {
  kind: typeof PPT_REVIEW_CONTEXT_KIND
  schemaVersion: 1
  workflowId: string
  childId: string
  slides: Array<{
    slideId: string
    revision: number
    annotations?: string[]
  }>
}

function contextReference(workflow: SerializedPptReviewContext): PptReviewComposerContextReference {
  return {
    kind: PPT_REVIEW_CONTEXT_KIND,
    schemaVersion: 1,
    workflowId: workflow.workflowId,
    childId: workflow.childId,
    slides: workflow.slides.map(({ slideId, revision, annotations }) => ({
      slideId,
      revision,
      ...(annotations?.length
        ? {
            annotations: annotations
              .map((annotation) => annotation.trim().slice(0, 256))
              .filter(Boolean)
              .slice(0, 4)
          }
        : {})
    }))
  }
}

/**
 * Converts first-party canvas review state into the existing bounded Composer
 * context contract. Preview filesystem paths are intentionally excluded: the
 * runtime already owns the review manifest and only needs stable workflow,
 * slide, revision, and annotation identities from the renderer.
 */
export async function createPptReviewComposerContextAttachments(input: {
  workspaceRoot: string
  threadId: string
  workflows: readonly SerializedPptReviewContext[]
}): Promise<ComposerContextAttachment[]> {
  if (!input.workspaceRoot.trim() || !input.threadId.trim()) return []
  return Promise.all(input.workflows.slice(0, 8).map((workflow) => {
    const reference = contextReference(workflow)
    return createDevPreviewComposerContextAttachment({
      workspaceRoot: input.workspaceRoot,
      threadId: input.threadId,
      kind: PPT_REVIEW_CONTEXT_KIND,
      title: `PPT visual review · ${workflow.workflowId}`,
      summary: `${workflow.slides.length} slide${workflow.slides.length === 1 ? '' : 's'} selected for revision`,
      reference: reference as unknown as JsonObject,
      now: Math.max(0, ...workflow.slides.map((slide) => slide.revision))
    })
  }))
}
