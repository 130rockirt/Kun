import type {
  DesignDocumentTarget,
  DesignTaskProfile,
  DesignTaskProfileInput
} from '../contracts/design-task-profile.js'
import {
  DesignDocumentTargetSchema,
  DesignTaskProfileInputSchema,
  DesignTaskProfileSchema
} from '../contracts/design-task-profile.js'

export function lockDesignTaskProfile(
  input: DesignTaskProfileInput,
  lockedAtTurnId: string
): DesignTaskProfile {
  return DesignTaskProfileSchema.parse({
    ...DesignTaskProfileInputSchema.parse(input),
    lockedAtTurnId
  })
}

export function submittedDesignTaskProfile(profile: DesignTaskProfile): DesignTaskProfileInput {
  const { lockedAtTurnId: _lockedAtTurnId, ...submitted } = profile
  return DesignTaskProfileInputSchema.parse(submitted)
}

export function sameDesignTaskProfile(
  locked: DesignTaskProfile,
  submitted: DesignTaskProfileInput
): boolean {
  return JSON.stringify(submittedDesignTaskProfile(locked)) ===
    JSON.stringify(DesignTaskProfileInputSchema.parse(submitted))
}

export function sameDesignDocumentTarget(
  first: DesignDocumentTarget,
  second: DesignDocumentTarget
): boolean {
  const left = DesignDocumentTargetSchema.parse(first)
  const right = DesignDocumentTargetSchema.parse(second)
  return left.documentId === right.documentId && left.boardArtifactId === right.boardArtifactId
}

export function retargetDesignTaskProfile(
  profile: DesignTaskProfile,
  documentTarget: DesignDocumentTarget
): DesignTaskProfile {
  return DesignTaskProfileSchema.parse({ ...profile, documentTarget })
}
