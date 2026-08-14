import type { ThreadAgentSurface, ThreadRecord } from '../contracts/threads.js'

type LockableThread = Pick<ThreadRecord, 'agentSurface' | 'designProfile' | 'turns'>

/**
 * Derive the legacy immutable conversation mode from durable admission
 * history. Code-owned workbench threads never have a session-level task
 * surface lock: each turn selects Code or Design independently, and only the
 * optional Design profile is durable. Work and legacy standalone Design
 * records keep their persisted surface.
 */
export function resolveThreadLockedTaskSurface(
  thread: LockableThread
): ThreadAgentSurface | undefined {
  const profileTurnId = thread.designProfile?.lockedAtTurnId
  const profileTurn = profileTurnId
    ? thread.turns.find((turn) => turn.id === profileTurnId)
    : undefined
  const provisionalProfile = Boolean(profileTurn && (
    profileTurn.admissionPending ||
    (!profileTurn.admissionCompletedAt && (
      profileTurn.status === 'aborted' || profileTurn.status === 'failed'
    ))
  ))
  const profile = provisionalProfile ? undefined : thread.designProfile
  const ownerSurface = provisionalProfile && thread.agentSurface === 'design'
    ? undefined
    : thread.agentSurface

  // Legacy standalone surfaces remain locked to their persisted ownership.
  if (ownerSurface === 'write' || ownerSurface === 'design') return ownerSurface
  // Code-owned conversations select Code or Design per turn; there is no
  // session-level task surface lock for them.
  if (ownerSurface === 'code') return undefined

  // No explicit ownership metadata: preserve the legacy derivation for
  // records that predate explicit Code/Design ownership.
  const firstAcceptedTurn = thread.turns.find((turn) => (
    !turn.admissionPending && !(provisionalProfile && turn.id === profileTurnId)
  ))
  if (firstAcceptedTurn) {
    if (firstAcceptedTurn.agentSurface) return firstAcceptedTurn.agentSurface
    return profile?.lockedAtTurnId === firstAcceptedTurn.id ? 'design' : 'code'
  }

  return profile ? 'design' : undefined
}
