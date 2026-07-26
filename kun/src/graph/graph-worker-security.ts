import type {
  GraphArtifactReferenceV1,
  GraphAssignmentSnapshotV1
} from '../contracts/graph.js'
import type { ChildSecuritySnapshot } from '../delegation/delegation-runtime.js'
import {
  graphBlockedProviderIds,
  graphPathScopedToolNames
} from './graph-security-policy.js'

export function graphWorkerSecuritySnapshot(
  assignment: GraphAssignmentSnapshotV1,
  artifacts: readonly GraphArtifactReferenceV1[]
): ChildSecuritySnapshot {
  return {
    sandboxRoot: assignment.workspaceRoot,
    allowedToolNames: graphPathScopedToolNames(
      assignment.allowedTools,
      assignment.readScopes,
      assignment.writeScopes
    ),
    allowedSkillIds: assignment.allowedSkills,
    allowedReadPaths: [
      ...new Set([
        ...assignment.readScopes,
        ...assignment.writeScopes
      ])
    ],
    allowedWritePaths: assignment.writeScopes,
    allowedArtifactIds: artifacts.map((artifact) => artifact.artifactId),
    blockedToolNames: assignment.blockedTools,
    blockedProviderIds: graphBlockedProviderIds(assignment),
    blockedSkillIds: assignment.blockedSkills,
    memoryEnabled: false
  }
}
