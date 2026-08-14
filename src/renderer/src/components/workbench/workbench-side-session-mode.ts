import type { NormalizedThread } from '../../agent/types'

export function shouldShowSideSessionReturnBar(input: {
  thread: NormalizedThread | null | undefined
  relation: NormalizedThread['relation'] | null
  parentThreadId: string | null
}): boolean {
  return input.relation === 'side' && Boolean(input.parentThreadId)
}
