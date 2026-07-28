import { z } from 'zod'
import { ModelReasoningEffort, SubagentToolPolicy } from './capabilities.js'
import { ApprovalPolicySchema, SandboxModeSchema } from './policy.js'
import { GraphRelativePathSchema } from './graph-path.js'
import {
  GRAPH_CONTRACT_VERSION,
  GraphArtifactReferenceV1Schema,
  GraphRiskClassSchema,
  GraphRunIdSchema
} from './graph-core.js'

const Identifier = z.string().trim().min(1).max(128).regex(
  /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
  'identifier must be portable and path safe'
)
const Timestamp = z.string().datetime({ offset: true })
const BoundedText = z.string().max(32_768)
const BoundedSummary = z.string().max(4_096)
const Sha256 = z.string().regex(/^[a-f0-9]{64}$/)
const RelativePath = GraphRelativePathSchema

export const ProjectIdentityV1Schema = z.object({
  version: z.literal(GRAPH_CONTRACT_VERSION),
  projectId: Identifier,
  canonicalWorkspaceRoot: z.string().min(1).max(4_096),
  gitCommonDir: z.string().min(1).max(4_096).optional(),
  remoteIdentityHash: Sha256.optional(),
  source: z.enum(['git_remote', 'git_common_dir', 'workspace_root']),
  resolvedAt: Timestamp
}).strict()
export type ProjectIdentityV1 = z.infer<typeof ProjectIdentityV1Schema>

export const GraphAgentOriginSchema = z.enum(['builtin', 'user', 'ephemeral', 'learned'])
export type GraphAgentOrigin = z.infer<typeof GraphAgentOriginSchema>

export const GraphAgentLifecycleSchema = z.enum([
  'candidate',
  'probation',
  'trusted',
  'dormant',
  'archived',
  'deleted'
])
export type GraphAgentLifecycle = z.infer<typeof GraphAgentLifecycleSchema>

export const GraphAgentCapabilitiesV1Schema = z.object({
  taskTypes: z.array(Identifier).max(256).default([]),
  capabilityTags: z.array(Identifier).max(256).default([]),
  toolPolicy: SubagentToolPolicy.default('readOnly'),
  allowedTools: z.array(Identifier).max(256).default([]),
  blockedTools: z.array(Identifier).max(256).default([]),
  allowedSkills: z.array(Identifier).max(256).default([]),
  blockedSkills: z.array(Identifier).max(256).default([]),
  allowedMcpServers: z.array(Identifier).max(128).default([]),
  blockedMcpServers: z.array(Identifier).max(128).default([]),
  approvalPolicy: ApprovalPolicySchema,
  sandboxMode: SandboxModeSchema,
  readScopes: z.array(RelativePath).max(1_000).default([]),
  writeScopes: z.array(RelativePath).max(1_000).default([]),
  networkAllowed: z.boolean().default(false),
  maximumRiskClass: GraphRiskClassSchema.default('low')
}).strict()
export type GraphAgentCapabilitiesV1 = z.infer<typeof GraphAgentCapabilitiesV1Schema>

export const GraphAgentProfileVersionV1Schema = z.object({
  version: z.literal(GRAPH_CONTRACT_VERSION),
  profileId: Identifier,
  profileVersion: z.number().int().positive(),
  origin: GraphAgentOriginSchema,
  lifecycle: GraphAgentLifecycleSchema,
  name: z.string().trim().min(1).max(128),
  description: z.string().max(2_048),
  systemPrompt: BoundedText,
  model: z.string().trim().min(1).max(256),
  providerId: z.string().trim().min(1).max(128),
  reasoningEffort: ModelReasoningEffort,
  capabilities: GraphAgentCapabilitiesV1Schema,
  provenanceEpisodeIds: z.array(Identifier).max(1_000).default([]),
  aliasProfileIds: z.array(Identifier).max(1_000).optional(),
  supersedesVersion: z.number().int().positive().optional(),
  rollbackVersion: z.number().int().positive().optional(),
  createdAt: Timestamp,
  createdBy: z.enum(['system', 'user', 'learning'])
}).strict()
export type GraphAgentProfileVersionV1 = z.infer<typeof GraphAgentProfileVersionV1Schema>

export const GraphAgentEvidenceV1Schema = z.object({
  version: z.literal(GRAPH_CONTRACT_VERSION),
  evidenceId: Identifier,
  profileId: Identifier,
  profileVersion: z.number().int().positive(),
  runId: GraphRunIdSchema,
  nodeId: Identifier,
  taskFingerprint: Sha256,
  source: z.enum([
    'accepted_outcome',
    'independent_review',
    'retry',
    'regression',
    'human_override',
    'later_validation',
    'missed_opportunity'
  ]),
  outcome: z.enum(['positive', 'negative', 'neutral']),
  quality: z.number().min(0).max(1),
  costTokens: z.number().int().nonnegative(),
  latencyMs: z.number().int().nonnegative(),
  eligible: z.boolean(),
  recalled: z.boolean(),
  selected: z.boolean(),
  taskFit: z.number().min(0).max(1),
  summary: BoundedSummary,
  createdAt: Timestamp
}).strict()
export type GraphAgentEvidenceV1 = z.infer<typeof GraphAgentEvidenceV1Schema>

export const GraphAgentScoreV1Schema = z.object({
  version: z.literal(GRAPH_CONTRACT_VERSION),
  profileId: Identifier,
  profileVersion: z.number().int().positive(),
  taskFit: z.number().min(0).max(1),
  quality: z.number().min(0).max(1),
  trust: z.number().min(0).max(1),
  freshness: z.number().min(0).max(1),
  efficiency: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  availability: z.number().min(0).max(1),
  load: z.number().min(0).max(1),
  aggregate: z.number().min(0).max(1),
  evidenceCount: z.number().int().nonnegative(),
  missedOpportunities: z.number().int().nonnegative(),
  computedAt: Timestamp
}).strict()
export type GraphAgentScoreV1 = z.infer<typeof GraphAgentScoreV1Schema>

export const GraphAgentRoutingRequestV1Schema = z.object({
  version: z.literal(GRAPH_CONTRACT_VERSION),
  projectId: Identifier,
  taskType: Identifier.optional(),
  query: z.string().trim().min(1).max(32_768),
  riskClass: GraphRiskClassSchema,
  requiredTools: z.array(Identifier).max(256).default([]),
  requiredSkills: z.array(Identifier).max(256).default([]),
  requiredMcpServers: z.array(Identifier).max(128).default([]),
  readScopes: z.array(RelativePath).max(1_000).default([]),
  writeScopes: z.array(RelativePath).max(1_000).default([]),
  networkRequired: z.boolean().default(false),
  modelCapabilityTags: z.array(Identifier).max(128).default([]),
  probationEligible: z.boolean().optional()
}).strict()
export type GraphAgentRoutingRequestV1 = z.infer<typeof GraphAgentRoutingRequestV1Schema>

export const GraphAgentRoutingExplanationV1Schema = z.object({
  version: z.literal(GRAPH_CONTRACT_VERSION),
  request: GraphAgentRoutingRequestV1Schema,
  excluded: z.array(z.object({
    profileId: Identifier,
    reason: z.string().min(1).max(1_024)
  }).strict()).max(10_000),
  recalled: z.array(z.object({
    profileId: Identifier,
    profileVersion: z.number().int().positive(),
    score: GraphAgentScoreV1Schema
  }).strict()).max(100),
  selectedProfileId: Identifier.optional(),
  selectedProfileVersion: z.number().int().positive().optional(),
  selectionReason: BoundedSummary,
  createdAt: Timestamp
}).strict()
export type GraphAgentRoutingExplanationV1 = z.infer<typeof GraphAgentRoutingExplanationV1Schema>

export const GraphLearningCandidateV1Schema = z.object({
  version: z.literal(GRAPH_CONTRACT_VERSION),
  candidateId: Identifier,
  projectId: Identifier,
  kind: z.enum(['agent_profile', 'skill', 'graph_recipe']),
  status: z.enum(['draft', 'approved', 'rejected', 'probation', 'promoted', 'rolled_back', 'merged', 'deleted']),
  name: z.string().trim().min(1).max(128),
  summary: BoundedSummary,
  draft: z.record(z.string(), z.unknown()),
  requestedCapabilities: GraphAgentCapabilitiesV1Schema.optional(),
  provenanceEpisodeIds: z.array(Identifier).min(1).max(1_000),
  evaluationPlan: z.array(z.string().min(1).max(2_048)).min(1).max(128),
  rollback: z.object({
    targetProfileId: Identifier.optional(),
    targetVersion: z.number().int().positive().optional(),
    instructions: BoundedSummary
  }).strict(),
  createdAt: Timestamp,
  updatedAt: Timestamp
}).strict()
export type GraphLearningCandidateV1 = z.infer<typeof GraphLearningCandidateV1Schema>

export const GraphEpisodeV1Schema = z.object({
  version: z.literal(GRAPH_CONTRACT_VERSION),
  episodeId: Identifier,
  projectId: Identifier,
  runId: GraphRunIdSchema,
  threadIdHash: Sha256,
  taskFingerprint: Sha256,
  graphShapeFingerprint: Sha256,
  graphSummary: BoundedSummary,
  assignments: z.array(z.object({
    nodeKind: z.enum(['work', 'review', 'integration', 'loop_gate']),
    profileId: Identifier,
    profileVersion: z.number().int().positive(),
    profileOrigin: GraphAgentOriginSchema,
    profileName: z.string().trim().min(1).max(128),
    roleSummary: BoundedSummary,
    toolPolicy: SubagentToolPolicy,
    allowedTools: z.array(Identifier).max(256).default([]),
    allowedSkills: z.array(Identifier).max(256).default([]),
    allowedMcpServers: z.array(Identifier).max(128).default([]),
    readScopes: z.array(RelativePath).max(1_000).default([]),
    writeScopes: z.array(RelativePath).max(1_000).default([]),
    usedWriteScope: z.boolean(),
    outcome: z.enum(['accepted', 'failed', 'cancelled', 'skipped', 'superseded']),
    attempts: z.number().int().nonnegative(),
    tokens: z.number().int().nonnegative(),
    elapsedMs: z.number().int().nonnegative()
  }).strict()).max(10_000),
  outcome: z.enum(['completed', 'failed', 'cancelled', 'checkpoint']),
  reviewSummary: BoundedSummary,
  failureSummary: BoundedSummary,
  interventions: z.array(BoundedSummary).max(256).default([]),
  totalTokens: z.number().int().nonnegative(),
  totalElapsedMs: z.number().int().nonnegative(),
  artifactRefs: z.array(GraphArtifactReferenceV1Schema).max(256).default([]),
  sanitized: z.literal(true),
  createdAt: Timestamp
}).strict()
export type GraphEpisodeV1 = z.infer<typeof GraphEpisodeV1Schema>

export const GraphLearningJobV1Schema = z.object({
  version: z.literal(GRAPH_CONTRACT_VERSION),
  jobId: Identifier,
  projectId: Identifier,
  trigger: z.enum(['schedule', 'run_count', 'evidence_threshold', 'manual']),
  idempotencyKey: Identifier,
  status: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']),
  inputEpisodeIds: z.array(Identifier).max(100_000),
  outputCandidateIds: z.array(Identifier).max(10_000).default([]),
  error: z.string().max(2_048).optional(),
  createdAt: Timestamp,
  startedAt: Timestamp.optional(),
  finishedAt: Timestamp.optional()
}).strict()
export type GraphLearningJobV1 = z.infer<typeof GraphLearningJobV1Schema>

export const GraphGovernanceAuditV1Schema = z.object({
  version: z.literal(GRAPH_CONTRACT_VERSION),
  auditId: Identifier,
  projectId: Identifier,
  actor: z.enum(['user', 'system', 'learning']),
  action: z.enum([
    'create',
    'promote',
    'demote',
    'disable',
    'archive',
    'restore',
    'merge',
    'delete',
    'approve_candidate',
    'reject_candidate',
    'rollback_candidate',
    'export',
    'import'
  ]),
  targetKind: z.enum(['profile', 'candidate', 'episode', 'recipe', 'skill']),
  targetId: Identifier,
  beforeHash: Sha256.optional(),
  afterHash: Sha256.optional(),
  reason: BoundedSummary,
  createdAt: Timestamp
}).strict()
export type GraphGovernanceAuditV1 = z.infer<typeof GraphGovernanceAuditV1Schema>
