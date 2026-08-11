import type { TurnItem } from '../contracts/items.js'

const PPT_REVIEW_TOOLS = new Set(['ppt_generate_previews', 'ppt_create_review_bundle'])

/**
 * Return only a review created after the latest successful design-plan write
 * in this turn. A plan mutation after review makes that earlier bundle stale.
 */
export function childReviewBundle(items: readonly TurnItem[], turnId: string): unknown | undefined {
  const boundary = latestSuccessfulPlanResultIndex(items, turnId)
  const reviewCallIds = toolCallIds(items, turnId, (name) => PPT_REVIEW_TOOLS.has(name))
  const result = [...items.entries()]
    .reverse()
    .find(([index, item]) =>
      index > boundary &&
      item.turnId === turnId &&
      item.kind === 'tool_result' &&
      reviewCallIds.has(item.callId) &&
      !item.isError &&
      isRecord(item.output) &&
      'reviewBundle' in item.output)
  const item = result?.[1]
  return item?.kind === 'tool_result' && isRecord(item.output)
    ? item.output.reviewBundle
    : undefined
}

export function childDeckArtifact(items: readonly TurnItem[], turnId: string): unknown | undefined {
  const boundary = latestSuccessfulPlanResultIndex(items, turnId)
  const exportCallIds = toolCallIds(items, turnId, (name) => name === 'ppt_export')
  const result = [...items.entries()]
    .reverse()
    .find(([index, item]) =>
      index > boundary &&
      item.turnId === turnId &&
      item.kind === 'tool_result' &&
      exportCallIds.has(item.callId) &&
      !item.isError &&
      isRecord(item.output) &&
      item.output.validated === true)
  return result?.[1]?.kind === 'tool_result' ? result[1].output : undefined
}

function latestSuccessfulPlanResultIndex(items: readonly TurnItem[], turnId: string): number {
  const planCallIds = toolCallIds(items, turnId, (name) => name === 'ppt_submit_design_plan')
  let boundary = -1
  for (const [index, item] of items.entries()) {
    if (
      item.turnId === turnId &&
      item.kind === 'tool_result' &&
      planCallIds.has(item.callId) &&
      !item.isError
    ) boundary = index
  }
  return boundary
}

function toolCallIds(
  items: readonly TurnItem[],
  turnId: string,
  matches: (toolName: string) => boolean
): Set<string> {
  return new Set(items
    .filter((item): item is Extract<TurnItem, { kind: 'tool_call' }> =>
      item.turnId === turnId && item.kind === 'tool_call' && matches(item.toolName))
    .map((item) => item.callId))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
