import {
  type GraphAssignmentSnapshotV1,
  type GraphNodeProjectionV1,
  type GraphRunV1
} from '../contracts/graph.js'
import type { GraphParentAuthority } from './graph-assignment.js'
import type { GraphSchedulerOptions } from './graph-scheduler-types.js'

export async function resolveGraphAttemptAssignment(
  options: GraphSchedulerOptions,
  run: GraphRunV1,
  projection: GraphNodeProjectionV1
): Promise<GraphAssignmentSnapshotV1> {
  const parent = await options.authorityForRun(run)
  const reference = projection.node.assignment ??
    await routeOrCreateEphemeral(options, run, projection, parent)
  return options.assignments.resolve({
    projectId: run.projectId,
    node: projection.node,
    reference,
    parent,
    maxWallTimeMs: Math.min(
      projection.node.timeoutMs ?? run.budget.limits.maxNodeWallTimeMs,
      options.config().scheduler.maxNodeWallTimeMs
    ),
    maxTokens: Math.min(
      projection.node.tokenBudget ?? run.budget.limits.maxTotalTokens,
      Math.max(1, run.budget.limits.maxTotalTokens - run.budget.totalTokens)
    )
  })
}

async function routeOrCreateEphemeral(
  options: GraphSchedulerOptions,
  run: GraphRunV1,
  projection: GraphNodeProjectionV1,
  parent: GraphParentAuthority
) {
  try {
    const identity = await options.registry.identify(run.plans.at(-1)!.workspaceRoot)
    if (identity.projectId === run.projectId) {
      const route = await options.registry.route(identity, {
        version: 1,
        projectId: run.projectId,
        taskType: projection.node.kind,
        query: `${projection.node.title}\n${projection.node.objective}`,
        riskClass: projection.node.riskClass,
        requiredTools: [],
        requiredSkills: [],
        requiredMcpServers: [],
        readScopes: projection.node.readScopes,
        writeScopes: projection.node.writeScopes,
        networkRequired: false,
        modelCapabilityTags: [],
        probationEligible:
          projection.node.riskClass === 'low' &&
          projection.node.writeScopes.length === 0 &&
          projection.node.completion.review.kinds.length > 0
      })
      if (route.profile) {
        return {
          kind: 'existing' as const,
          profileId: route.profile.profileId,
          profileVersion: route.profile.profileVersion
        }
      }
    }
  } catch {
    // A routing miss is expected to fall back to a frozen ephemeral profile.
  }
  return {
    kind: 'ephemeral' as const,
    name: `${projection.node.kind}-${projection.node.id}`,
    description: projection.node.title,
    systemPrompt: [
      `You are a Graph worker specialized for: ${projection.node.title}.`,
      projection.node.objective,
      'Work only on this node. Communicate bounded evidence and never delegate.'
    ].join('\n\n'),
    model: parent.model,
    providerId: parent.providerId,
    reasoningEffort: parent.reasoningEffort,
    toolPolicy: projection.node.writeScopes.length ? 'inherit' as const : 'readOnly' as const,
    allowedTools: [...parent.allowedTools],
    blockedTools: [...parent.blockedTools],
    allowedSkills: [...parent.allowedSkills],
    blockedSkills: [...parent.blockedSkills],
    allowedMcpServers: [...parent.allowedMcpServers],
    blockedMcpServers: [...parent.blockedMcpServers]
  }
}
