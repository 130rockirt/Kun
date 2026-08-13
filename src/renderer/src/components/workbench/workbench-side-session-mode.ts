import type { NormalizedThread } from '../../agent/types'

export function isManagedPlanBuildConversation(
  thread: NormalizedThread | null | undefined
): boolean {
  return Boolean(thread?.planBuildRunId?.trim())
}

export function shouldShowSideSessionReturnBar(input: {
  thread: NormalizedThread | null | undefined
  relation: NormalizedThread['relation'] | null
  parentThreadId: string | null
}): boolean {
  return input.relation === 'side' &&
    Boolean(input.parentThreadId) &&
    !isManagedPlanBuildConversation(input.thread)
}
