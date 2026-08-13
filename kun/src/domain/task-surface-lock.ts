import type { ThreadAgentSurface, ThreadRecord } from '../contracts/threads.js'

type LockableThread = Pick<ThreadRecord, 'agentSurface' | 'designProfile' | 'turns'>

/**
 * Derive the immutable conversation mode from durable admission history.
 * Thread agentSurface is workbench ownership, so an empty Code-owned thread
 * remains selectable until its first accepted turn.
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

  if (ownerSurface === 'write' || ownerSurface === 'design') return ownerSurface

  const firstAcceptedTurn = thread.turns.find((turn) => (
    !turn.admissionPending && !(provisionalProfile && turn.id === profileTurnId)
  ))
  if (firstAcceptedTurn) {
    if (firstAcceptedTurn.agentSurface) return firstAcceptedTurn.agentSurface
    return profile?.lockedAtTurnId === firstAcceptedTurn.id ? 'design' : 'code'
  }

  return profile ? 'design' : undefined
}
