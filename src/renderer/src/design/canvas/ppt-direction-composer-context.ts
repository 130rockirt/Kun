import type { ComposerContextAttachment, JsonObject } from '@kun/extension-api'
import { createDevPreviewComposerContextAttachment } from '../../lib/dev-preview-composer-context'
import type { SerializedPptDirectionContext } from './ppt-direction-board'

export const PPT_DIRECTION_CONTEXT_KIND = 'ppt-direction'

export type PptDirectionComposerContextReference = {
  kind: typeof PPT_DIRECTION_CONTEXT_KIND
  schemaVersion: 1
  workflowId: string
  childId: string
  directions: Array<{ directionId: string; revision: number }>
}

function contextReference(workflow: SerializedPptDirectionContext): PptDirectionComposerContextReference {
  if (workflow.directions.length > 1) throw new Error('Select at most one PPT visual direction')
  return {
    kind: PPT_DIRECTION_CONTEXT_KIND,
    schemaVersion: 1,
    workflowId: workflow.workflowId,
    childId: workflow.childId,
    directions: workflow.directions.map(({ directionId, revision }) => ({ directionId, revision }))
  }
}

/**
 * Emits only host-owned direction identities. Preview paths and visual-plan
 * details remain in the runtime's persisted bundle and never become trusted
 * composer instructions.
 */
export async function createPptDirectionComposerContextAttachments(input: {
  workspaceRoot: string
  threadId: string
  workflows: readonly SerializedPptDirectionContext[]
}): Promise<ComposerContextAttachment[]> {
  if (!input.workspaceRoot.trim() || !input.threadId.trim()) return []
  return Promise.all(input.workflows.slice(0, 8).map((workflow) => {
    const reference = contextReference(workflow)
    const selected = reference.directions[0]
    return createDevPreviewComposerContextAttachment({
      workspaceRoot: input.workspaceRoot,
      threadId: input.threadId,
      kind: PPT_DIRECTION_CONTEXT_KIND,
      title: `PPT visual direction · ${workflow.workflowId}`,
      summary: selected
        ? `Selected direction ${selected.directionId} at revision ${selected.revision}`
        : 'No direction card selected; use the persisted recommended direction',
      reference: reference as unknown as JsonObject,
      now: workflow.revision
    })
  }))
}
