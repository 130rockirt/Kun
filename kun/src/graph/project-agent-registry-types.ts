import type { GraphRuntimeConfig } from '../config/kun-config.js'
import type {
  GraphAgentEvidenceV1,
  GraphAgentLifecycle,
  GraphAgentProfileVersionV1,
  GraphAgentRoutingExplanationV1,
  GraphAgentRoutingRequestV1,
  GraphAgentScoreV1,
  GraphGovernanceAuditV1,
  GraphLearningCandidateV1,
  ProjectIdentityV1
} from '../contracts/index.js'

export type GraphAgentRouteResult = {
  profile?: GraphAgentProfileVersionV1
  explanation: GraphAgentRoutingExplanationV1
}

export type ProjectAgentRegistry = {
  identify(workspaceRoot: string): Promise<ProjectIdentityV1>
  listProjectIdentities(): Promise<ProjectIdentityV1[]>
  listProfiles(projectId: string, includeArchived?: boolean): Promise<GraphAgentProfileVersionV1[]>
  getProfile(projectId: string, profileId: string, version?: number): Promise<GraphAgentProfileVersionV1 | null>
  saveProfile(identity: ProjectIdentityV1, profile: GraphAgentProfileVersionV1, reason: string, actor?: GraphGovernanceAuditV1['actor']): Promise<GraphAgentProfileVersionV1>
  importProfile(identity: ProjectIdentityV1, profile: GraphAgentProfileVersionV1, reason: string): Promise<GraphAgentProfileVersionV1>
  mergeProfiles(identity: ProjectIdentityV1, sourceProfileIds: string[], targetProfileId: string, name: string, reason: string): Promise<GraphAgentProfileVersionV1>
  recordProfileExport(projectId: string, profile: GraphAgentProfileVersionV1): Promise<void>
  recordEvidence(identity: ProjectIdentityV1, evidence: GraphAgentEvidenceV1): Promise<void>
  route(identity: ProjectIdentityV1, request: GraphAgentRoutingRequestV1, loadByProfile?: ReadonlyMap<string, number>): Promise<GraphAgentRouteResult>
  transitionProfile(identity: ProjectIdentityV1, profileId: string, lifecycle: GraphAgentLifecycle, reason: string, actor?: GraphGovernanceAuditV1['actor']): Promise<GraphAgentProfileVersionV1>
  listEvidence(projectId: string, profileId?: string): Promise<GraphAgentEvidenceV1[]>
  listScores(projectId: string): Promise<GraphAgentScoreV1[]>
  listExplanations(projectId: string): Promise<GraphAgentRoutingExplanationV1[]>
  listCandidates(projectId: string): Promise<GraphLearningCandidateV1[]>
  saveCandidate(identity: ProjectIdentityV1, candidate: GraphLearningCandidateV1, reason: string, actor?: GraphGovernanceAuditV1['actor']): Promise<void>
  listAudit(projectId: string): Promise<GraphGovernanceAuditV1[]>
  compactRetention(projectId: string): Promise<{ auditRemoved: number }>
}

export type FileProjectAgentRegistryOptions = {
  rootDir: string
  config: () => GraphRuntimeConfig
  nowIso?: () => string
  nextId?: (prefix: string) => string
}
