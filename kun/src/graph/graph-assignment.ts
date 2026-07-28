import { createHash } from 'node:crypto'
import {
  GRAPH_CONTRACT_VERSION,
  GraphAssignmentSnapshotV1Schema,
  type GraphAgentProfileVersionV1,
  type GraphAssignmentReferenceV1,
  type GraphAssignmentSnapshotV1,
  type GraphNodeV1
} from '../contracts/index.js'
import type { ApprovalPolicy, SandboxMode } from '../contracts/policy.js'
import type { ModelReasoningEffort } from '../contracts/capabilities.js'
import type { ProjectAgentRegistry } from './project-agent-registry.js'
import {
  GRAPH_INCOMPATIBLE_TOOL_NAMES,
  graphWorkerToolNamesWithin
} from './graph-tool-boundary.js'
import { graphHostRelativePathCovers } from './graph-platform-path.js'

export type GraphParentAuthority = {
  workspaceRoot: string
  model: string
  providerId: string
  reasoningEffort: ModelReasoningEffort
  approvalPolicy: ApprovalPolicy
  sandboxMode: SandboxMode
  allowedTools: readonly string[]
  blockedTools: readonly string[]
  allowedSkills: readonly string[]
  blockedSkills: readonly string[]
  allowedMcpServers: readonly string[]
  blockedMcpServers: readonly string[]
  readScopes: readonly string[]
  writeScopes: readonly string[]
  networkAllowed: boolean
}

export type GraphAssignmentResolverOptions = {
  registry: ProjectAgentRegistry
  nowIso?: () => string
}

export class GraphAssignmentResolver {
  private readonly nowIso: () => string

  constructor(private readonly options: GraphAssignmentResolverOptions) {
    this.nowIso = options.nowIso ?? (() => new Date().toISOString())
  }

  async resolve(input: {
    projectId: string
    node: GraphNodeV1
    reference: GraphAssignmentReferenceV1
    parent: GraphParentAuthority
    maxWallTimeMs: number
    maxTokens: number
  }): Promise<GraphAssignmentSnapshotV1> {
    const capturedAt = this.nowIso()
    const requested = input.reference.kind === 'existing' ? input.reference : undefined
    const existing = requested
      ? await this.resolveExisting(input.projectId, requested.profileId, requested.profileVersion)
      : undefined
    const missingRequestedProfile = requested && !existing
    const profile = existing ?? (missingRequestedProfile
      ? ephemeralProfile(
          missingProfileFallback(input.node, requested),
          input.parent,
          capturedAt
        )
      : ephemeralProfile(
          input.reference as Extract<GraphAssignmentReferenceV1, { kind: 'ephemeral' }>,
          input.parent,
          capturedAt
        ))
    const caps = profile.capabilities
    if (!['probation', 'trusted'].includes(profile.lifecycle) && profile.origin !== 'ephemeral') {
      throw new Error(`profile ${profile.profileId} lifecycle ${profile.lifecycle} is not executable`)
    }
    assertScopeSubset(input.node.readScopes, input.parent.readScopes, 'node read')
    assertScopeSubset(input.node.writeScopes, input.parent.writeScopes, 'node write')
    assertScopeSubset(input.node.readScopes, caps.readScopes.length ? caps.readScopes : input.parent.readScopes, 'profile read')
    assertScopeSubset(input.node.writeScopes, caps.writeScopes.length ? caps.writeScopes : input.parent.writeScopes, 'profile write')
    const sandboxMode = narrowerSandbox(input.parent.sandboxMode, caps.sandboxMode)
    if (input.node.writeScopes.length && sandboxMode === 'read-only') {
      throw new Error(`profile ${profile.profileId} cannot satisfy node write scope`)
    }
    const toolPolicy = caps.toolPolicy === 'readOnly' ? 'readOnly' : 'inherit'
    const allowedTools = union(
      intersect(input.parent.allowedTools, caps.allowedTools),
      graphWorkerToolNamesWithin(input.parent.allowedTools)
    )
    const allowedSkills = intersect(input.parent.allowedSkills, caps.allowedSkills)
    const allowedMcpServers = intersect(input.parent.allowedMcpServers, caps.allowedMcpServers)
    const blockedTools = union(input.parent.blockedTools, caps.blockedTools, [
      ...GRAPH_INCOMPATIBLE_TOOL_NAMES,
      'graph_create_run',
      'graph_patch_run',
      'graph_control_run',
      'graph_review_node',
      'graph_agent_governance'
    ])
    const blockedSkills = union(input.parent.blockedSkills, caps.blockedSkills)
    const blockedMcpServers = union(
      input.parent.blockedMcpServers,
      caps.blockedMcpServers,
      input.parent.allowedMcpServers.filter((serverId) => !allowedMcpServers.includes(serverId))
    )
    const approvalPolicy = narrowerApproval(input.parent.approvalPolicy, caps.approvalPolicy)
    return GraphAssignmentSnapshotV1Schema.parse({
      version: GRAPH_CONTRACT_VERSION,
      profileId: profile.profileId,
      profileVersion: profile.profileVersion,
      profileOrigin: profile.origin,
      ...(requested ? {
        requestedProfileId: requested.profileId,
        ...(requested.profileVersion
          ? { requestedProfileVersion: requested.profileVersion }
          : {})
      } : {}),
      ...(missingRequestedProfile ? {
        routingReason:
          `Requested project profile "${requested.profileId}" was unavailable; ` +
          'Kun created a graph-scoped least-authority fallback.'
      } : {}),
      name: profile.name,
      systemPrompt: profile.systemPrompt,
      model: profile.model || input.parent.model,
      providerId: profile.providerId || input.parent.providerId,
      reasoningEffort: profile.reasoningEffort ?? input.parent.reasoningEffort,
      toolPolicy,
      allowedTools,
      blockedTools,
      allowedSkills,
      blockedSkills,
      allowedMcpServers,
      blockedMcpServers,
      approvalPolicy,
      sandboxMode,
      workspaceRoot: input.parent.workspaceRoot,
      readScopes: input.node.readScopes,
      writeScopes: input.node.writeScopes,
      networkAllowed: input.parent.networkAllowed && caps.networkAllowed,
      maxWallTimeMs: input.maxWallTimeMs,
      maxTokens: input.maxTokens,
      capturedAt
    })
  }

  private async resolveExisting(
    projectId: string,
    profileId: string,
    version?: number
  ): Promise<GraphAgentProfileVersionV1 | null> {
    return this.options.registry.getProfile(projectId, profileId, version)
  }
}

function missingProfileFallback(
  node: GraphNodeV1,
  requested: Extract<GraphAssignmentReferenceV1, { kind: 'existing' }>
): Extract<GraphAssignmentReferenceV1, { kind: 'ephemeral' }> {
  const criteria = node.completion.acceptanceCriteria
    .map((item) => `- ${item}`)
    .join('\n')
  return {
    kind: 'ephemeral',
    name: `${node.title} fallback`.slice(0, 128),
    description:
      `Graph-scoped replacement for unavailable project profile ${requested.profileId}.`
        .slice(0, 1_024),
    systemPrompt: [
      'You are a graph-scoped specialist created because the requested project profile is unavailable.',
      'Do not expand the parent authority, delegate recursively, or work outside the assigned node.',
      `Node objective:\n${node.objective}`,
      `Acceptance criteria:\n${criteria}`,
      'Return the required structured result with concrete evidence and explicit risks.'
    ].join('\n\n'),
    toolPolicy: node.writeScopes.length ? 'inherit' : 'readOnly',
    blockedTools: [],
    blockedSkills: [],
    blockedMcpServers: []
  }
}

function ephemeralProfile(
  reference: Extract<GraphAssignmentReferenceV1, { kind: 'ephemeral' }>,
  parent: GraphParentAuthority,
  createdAt: string
): GraphAgentProfileVersionV1 {
  const fingerprint = createHash('sha256')
    .update(JSON.stringify(reference))
    .digest('hex')
    .slice(0, 24)
  return {
    version: GRAPH_CONTRACT_VERSION,
    profileId: `ephemeral_${fingerprint}`,
    profileVersion: 1,
    origin: 'ephemeral',
    lifecycle: 'trusted',
    name: reference.name,
    description: reference.description ?? 'Graph-scoped ephemeral specialist',
    systemPrompt: reference.systemPrompt,
    model: reference.model ?? parent.model,
    providerId: reference.providerId ?? parent.providerId,
    reasoningEffort: reference.reasoningEffort ?? parent.reasoningEffort,
    capabilities: {
      taskTypes: [],
      capabilityTags: [],
      toolPolicy: reference.toolPolicy,
      allowedTools: reference.allowedTools ?? [...parent.allowedTools],
      blockedTools: reference.blockedTools,
      allowedSkills: reference.allowedSkills ?? [...parent.allowedSkills],
      blockedSkills: reference.blockedSkills,
      allowedMcpServers: reference.allowedMcpServers ?? [...parent.allowedMcpServers],
      blockedMcpServers: reference.blockedMcpServers,
      approvalPolicy: parent.approvalPolicy,
      sandboxMode: parent.sandboxMode,
      readScopes: [...parent.readScopes],
      writeScopes: [...parent.writeScopes],
      networkAllowed: parent.networkAllowed,
      maximumRiskClass: 'critical'
    },
    provenanceEpisodeIds: [],
    createdAt,
    createdBy: 'system'
  }
}

function assertScopeSubset(
  requested: readonly string[],
  allowed: readonly string[],
  label: string
): void {
  for (const scope of requested) {
    if (!allowed.some((parent) => graphHostRelativePathCovers(parent, scope))) {
      throw new Error(`${label} scope ${scope} expands parent authority`)
    }
  }
}

function intersect(parent: readonly string[], requested: readonly string[]): string[] {
  if (requested.length === 0) return []
  const parentSet = new Set(parent)
  return [...new Set(requested)].filter((item) => parentSet.has(item)).sort()
}

function union(...values: readonly (readonly string[])[]): string[] {
  return [...new Set(values.flatMap((value) => [...value]))].sort()
}

function narrowerSandbox(parent: SandboxMode, requested: SandboxMode): SandboxMode {
  const rank: Record<SandboxMode, number> = {
    'read-only': 0,
    'external-sandbox': 1,
    'workspace-write': 2,
    'danger-full-access': 3
  }
  return rank[requested] <= rank[parent] ? requested : parent
}

function narrowerApproval(
  parent: ApprovalPolicy,
  requested: ApprovalPolicy
): ApprovalPolicy {
  const rank: Record<ApprovalPolicy, number> = {
    never: 0,
    always: 1,
    untrusted: 2,
    'on-request': 3,
    suggest: 3,
    auto: 4
  }
  return rank[requested] <= rank[parent] ? requested : parent
}
