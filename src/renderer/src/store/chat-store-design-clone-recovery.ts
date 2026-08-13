import type { AgentProvider, NormalizedThread } from '../agent/types'
import type { DesignDocumentTarget } from '../agent/design-task-profile'
import type { PreparedDesignDocumentFork } from '../design/design-document-fork'
import { getRuntimeErrorCode } from '../lib/format-runtime-error'

export type PreparedDesignCloneOutcome =
  | { kind: 'committed'; thread: NormalizedThread }
  | { kind: 'rejected' }
  | { kind: 'unknown' }

function sameTarget(
  left: DesignDocumentTarget | undefined,
  right: DesignDocumentTarget
): boolean {
  return left?.documentId === right.documentId &&
    left.boardArtifactId === right.boardArtifactId
}

export function designCloneOutcomeMayBeUnknown(error: unknown): boolean {
  const code = getRuntimeErrorCode(error)
  if (code) {
    return code !== 'validation_error' && code !== 'unauthorized' && code !== 'forbidden' &&
      code !== 'not_found' && code !== 'conflict' && code !== 'policy_blocked' &&
      code !== 'capability_unavailable' && code !== 'not_implemented'
  }
  const message = error instanceof Error ? error.message : String(error ?? '')
  return !/\bHTTP\s+4\d\d\b/i.test(message)
}

export async function resolvePreparedDesignCloneAfterError(
  provider: AgentProvider,
  prepared: PreparedDesignDocumentFork,
  error: unknown
): Promise<PreparedDesignCloneOutcome> {
  if (!designCloneOutcomeMayBeUnknown(error)) {
    await prepared.cleanup().catch(() => undefined)
    return { kind: 'rejected' }
  }
  let inventory: NormalizedThread[]
  try {
    inventory = await provider.listThreads({ includeArchived: true, includeSide: true })
  } catch {
    return { kind: 'unknown' }
  }
  const committed = inventory.find((thread) =>
    sameTarget(thread.designProfile?.documentTarget, prepared.designDocumentTarget)
  )
  if (committed) {
    return { kind: 'committed', thread: committed }
  }
  return { kind: 'unknown' }
}
