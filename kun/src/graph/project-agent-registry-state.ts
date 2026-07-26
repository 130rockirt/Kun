import { z } from 'zod'
import {
  GRAPH_CONTRACT_VERSION,
  GraphAgentEvidenceV1Schema,
  GraphAgentProfileVersionV1Schema,
  GraphAgentRoutingExplanationV1Schema,
  GraphAgentScoreV1Schema,
  GraphGovernanceAuditV1Schema,
  GraphLearningCandidateV1Schema,
  ProjectIdentityV1Schema
} from '../contracts/index.js'

export const ProjectAgentRegistryStateSchema = z.object({
  version: z.literal(GRAPH_CONTRACT_VERSION),
  identity: ProjectIdentityV1Schema,
  profiles: z.array(GraphAgentProfileVersionV1Schema).max(100_000),
  evidence: z.array(GraphAgentEvidenceV1Schema).max(1_000_000),
  explanations: z.array(GraphAgentRoutingExplanationV1Schema).max(100_000),
  candidates: z.array(GraphLearningCandidateV1Schema).max(100_000),
  scores: z.array(GraphAgentScoreV1Schema).max(100_000).default([]),
  audit: z.array(GraphGovernanceAuditV1Schema).max(1_000_000),
  updatedAt: z.string().datetime({ offset: true })
}).strict()

export type ProjectAgentRegistryState = z.infer<typeof ProjectAgentRegistryStateSchema>
