import {
  type ChildRoutingMetadata,
  type DelegationRuntime
} from '../../delegation/delegation-runtime.js'
import {
  CustomSubagentDefinitionSchema,
  customSubagentProfile,
  customSubagentProfileId,
  subagentTaskRequiresReadOnly,
  type CustomSubagentDefinition,
  type SubagentRouteResult,
  type SubagentRouter,
  type SubagentRoutingDocument
} from '../../delegation/subagent-router.js'
import type { ToolExecutionUpdate, ToolHostContext } from '../../ports/tool-host.js'
import type { CapabilityToolProvider } from './capability-registry.js'
import { LocalToolHost } from './local-tool-host.js'

type InlineProfile = {
  id: string
  profile: ReturnType<typeof customSubagentProfile>
  source?: 'builtin' | 'configured' | 'workspace' | 'custom' | 'generated'
}

const DEFAULT_PROFILE_PAGE_LIMIT = 50
const MAX_PROFILE_PAGE_LIMIT = 50
const MAX_PROFILE_NAME_LENGTH = 256
const MAX_PROFILE_DESCRIPTION_LENGTH = 1_000

export function buildDelegationToolProviders(
  runtime: DelegationRuntime | undefined,
  router?: SubagentRouter
): CapabilityToolProvider[] {
  if (!runtime?.enabled()) return []
  const useExistingAgents = runtime.useExistingAgents !== false
  const modeProperties = useExistingAgents
    ? {
        profile: {
          type: 'string',
          description: 'Optional exact reusable profile id returned by list_subagent_profiles. Omit it to route over the effective catalog.'
        }
      }
    : { custom_agent: customAgentSchema() }

  return [{
    id: 'delegation',
    kind: 'delegation',
    enabled: true,
    available: true,
    tools: [
      LocalToolHost.defineTool({
        name: 'delegate_task',
        description: buildDelegateTaskDescription(runtime),
        inputSchema: {
          type: 'object',
          properties: {
            label: { type: 'string', description: 'A distinct 2-4 word UI title for this child.' },
            prompt: { type: 'string', description: 'The task for the child agent.' },
            ...modeProperties,
            detach: { type: 'boolean', description: 'Run in the background and return after the child is queued.' },
            returnFormat: { type: 'string', enum: ['summary', 'evidence'] }
          },
          required: useExistingAgents ? ['prompt'] : ['prompt', 'custom_agent'],
          additionalProperties: false
        },
        policy: 'auto',
        execute: async (args, context, onUpdate) => {
          const common = parseCommonArgs(args, context)
          if (common instanceof Error) return toolError(common.message)
          const requestedProfile = stringValue(args.profile)
          const customAgentSupplied = args.custom_agent !== undefined && args.custom_agent !== null
          let inlineProfile: InlineProfile | undefined
          let routing: ChildRoutingMetadata | undefined
          const agentSurface = context.agentSurface ?? 'code'

          if (useExistingAgents && customAgentSupplied) {
            return toolError('custom_agent is unavailable while "Use existing agents" is turned on; select a reusable profile or omit profile for automatic routing')
          }
          if (!useExistingAgents) {
            if (requestedProfile) {
              return toolError('profile is unavailable while "Use existing agents" is turned off; define custom_agent instead')
            }
            if (!customAgentSupplied) {
              return toolError('custom_agent is required while "Use existing agents" is turned off')
            }
          }
          if (!useExistingAgents && customAgentSupplied) {
            const customDefinition = parseCustomAgent(args.custom_agent)
            if (customDefinition instanceof Error) return toolError(customDefinition.message)
            if (!customDefinition) return toolError('custom_agent is required')
            inlineProfile = {
              id: customSubagentProfileId(customDefinition.name),
              profile: customSubagentProfile(customDefinition),
              source: 'custom'
            }
            routing = explicitCustomMetadata(inlineProfile, agentSurface)
          }

          if (useExistingAgents && requestedProfile) {
            const snapshot = await runtime.resolveProfileSnapshot(requestedProfile, common.workspace, agentSurface)
            if (!snapshot) {
              return toolError(`unknown or unavailable ${agentSurface} subagent profile: ${requestedProfile}`)
            }
            inlineProfile = { id: snapshot.id, profile: snapshot.profile, source: snapshot.source }
            routing = {
              method: 'explicit-profile',
              selectedKind: 'profile',
              selectedId: requestedProfile,
              reason: 'The parent agent explicitly selected this standalone profile.',
              agentSurface,
              candidates: []
            }
          } else if (useExistingAgents && !inlineProfile) {
            const documents = await runtime.listRoutingProfiles(common.workspace, agentSurface)
            const route = router
              ? await router.route({
                threadId: context.threadId,
                turnId: context.turnId,
                task: common.prompt,
                agentSurface,
                documents,
                mainModel: common.inheritedModel,
                mainProviderId: common.inheritedProviderId,
                abortSignal: context.abortSignal
              })
              : undefined
            const routedSnapshot = route?.profileId
              ? documents.find((document) => document.id === route.profileId)
              : undefined
            if (route && routedSnapshot && !route.generate) {
              inlineProfile = {
                id: routedSnapshot.id,
                profile: routedSnapshot.profile,
                source: routedSnapshot.source
              }
              routing = existingRouteMetadata(route, agentSurface)
            } else {
              const snapshot = selectExistingFallback(runtime, documents)
              if (!snapshot) return toolError('no existing subagent profile is available for delegation')
              inlineProfile = { id: snapshot.id, profile: snapshot.profile, source: snapshot.source }
              routing = existingFallbackMetadata(route, snapshot.id, agentSurface)
            }
          }

          return await runChild(runtime, common, context, onUpdate, {
            ...(inlineProfile ? { inlineProfile } : {}),
            ...(routing ? { routing } : {})
          })
        }
      }),
      LocalToolHost.defineTool({
        name: 'list_subagent_profiles',
        description: buildListSubagentProfilesDescription(runtime),
        inputSchema: {
          type: 'object',
          properties: {
            offset: {
              type: 'integer',
              minimum: 0,
              description: 'Zero-based reusable-profile offset.'
            },
            limit: {
              type: 'integer',
              minimum: 1,
              maximum: MAX_PROFILE_PAGE_LIMIT,
              description: `Reusable profiles to return, from 1 to ${MAX_PROFILE_PAGE_LIMIT}.`
            }
          },
          additionalProperties: false
        },
        policy: 'auto',
        sideEffect: 'read-only',
        execute: async (args, context) => {
          const offset = nonnegativeInteger(args.offset, 0)
          const limit = boundedPositiveInteger(
            args.limit,
            DEFAULT_PROFILE_PAGE_LIMIT,
            MAX_PROFILE_PAGE_LIMIT
          )
          const agentSurface = context.agentSurface ?? 'code'
          const documents = useExistingAgents
            ? await runtime.listRoutingProfiles(context.workspace, agentSurface)
            : []
          const page = documents.slice(offset, offset + limit)
          const nextOffset = offset + page.length < documents.length
            ? offset + page.length
            : null
          return {
            output: {
              mode: useExistingAgents ? 'profiles-only' : 'custom-only',
              surface: agentSurface,
              ...(!useExistingAgents ? { customAgent: customAgentCapability() } : {}),
              profileCount: documents.length,
              offset,
              limit,
              nextOffset,
              profiles: page.map((document) => ({
                id: document.id,
                name: boundedText(
                  document.profile.name ?? document.id,
                  MAX_PROFILE_NAME_LENGTH
                ),
                description: boundedText(
                  document.profile.description ?? 'No description provided.',
                  MAX_PROFILE_DESCRIPTION_LENGTH
                ),
                toolPolicy: document.profile.toolPolicy,
                access: document.profile.toolPolicy === 'readOnly'
                  ? 'Read-only investigation; cannot modify the workspace.'
                  : 'May use only tools allowed by the parent capability and approval boundary.'
              })),
              guidance: useExistingAgents
                ? 'Pass an exact id as delegate_task.profile, or omit profile for automatic routing over the effective catalog.'
                : 'Reusable profiles are disabled. Define a one-run role with delegate_task.custom_agent.'
            }
          }
        }
      })
    ]
  }]
}

function customAgentSchema(): Record<string, unknown> {
  return {
    type: 'object',
    description: 'One-run standalone role written by the parent. It always inherits the current turn model/provider/reasoning strength, is mutually exclusive with profile, and is retained only in the child-run audit snapshot.',
    properties: {
      name: { type: 'string' },
      description: { type: 'string' },
      system_prompt: { type: 'string', description: 'Self-contained expertise, scope, procedure, output, verification, and boundaries.' },
      tool_policy: { type: 'string', enum: ['readOnly', 'inherit'] },
      blocked_tools: { type: 'array', items: { type: 'string' } }
    },
    required: ['name', 'description', 'system_prompt'],
    additionalProperties: false
  }
}

function customAgentCapability(): Record<string, unknown> {
  return {
    id: 'custom',
    name: 'Custom Subagent',
    description: 'Define a focused one-run child role directly in delegate_task.custom_agent when no reusable profile is the right fit.',
    argument: 'custom_agent',
    lifetime: 'one-run',
    requiredFields: ['name', 'description', 'system_prompt'],
    optionalFields: ['tool_policy', 'blocked_tools'],
    toolPolicyOptions: [
      {
        value: 'readOnly',
        description: 'Restrict the child to host-approved read-only investigation tools.'
      },
      {
        value: 'inherit',
        description: 'Allow only the subset of parent-authorized tools that remains inside the child security boundary.'
      }
    ],
    hostControlled: [
      'model',
      'provider',
      'reasoning',
      'approval',
      'sandbox',
      'concurrency',
      'budget',
      'timeout'
    ]
  }
}

function parseCommonArgs(args: Record<string, unknown>, context: ToolHostContext): {
  prompt: string
  workspace: string
  inheritedModel?: string
  inheritedProviderId?: string
  inheritedAccountId?: string
  inheritedReasoningEffort?: string
  label?: string
  detach: boolean
  returnFormat?: 'evidence'
} | Error {
  const prompt = stringValue(args.prompt)
  if (!prompt) return new Error('prompt is required')
  return {
    prompt,
    workspace: context.workspace,
    ...(context.actingModelRoute?.model
      ? { inheritedModel: context.actingModelRoute.model }
      : context.model?.id?.trim()
        ? { inheritedModel: context.model.id.trim() }
        : {}),
    ...(context.actingModelRoute?.providerId
      ? { inheritedProviderId: context.actingModelRoute.providerId }
      : context.modelProviderId?.trim()
        ? { inheritedProviderId: context.modelProviderId.trim() }
        : {}),
    ...(context.actingModelRoute?.accountId
      ? { inheritedAccountId: context.actingModelRoute.accountId }
      : {}),
    ...(context.reasoningEffort?.trim() ? { inheritedReasoningEffort: context.reasoningEffort.trim() } : {}),
    ...(stringValue(args.label) ? { label: stringValue(args.label) } : {}),
    detach: args.detach === true,
    ...(args.returnFormat === 'evidence' ? { returnFormat: 'evidence' as const } : {})
  }
}

async function runChild(
  runtime: DelegationRuntime,
  common: Exclude<ReturnType<typeof parseCommonArgs>, Error>,
  context: ToolHostContext,
  onUpdate: ((update: ToolExecutionUpdate) => Promise<void> | void) | undefined,
  selection: { profile?: string; inlineProfile?: InlineProfile; routing?: ChildRoutingMetadata }
): Promise<{ output: Record<string, unknown>; isError: boolean }> {
  const record = await runtime.runChild({
    parentThreadId: context.threadId,
    parentTurnId: context.turnId,
    prompt: common.prompt,
    workspace: common.workspace,
    ...(common.label ? { label: common.label } : {}),
    ...(selection.profile ? { profile: selection.profile } : {}),
    ...(selection.inlineProfile ? { inlineProfile: selection.inlineProfile } : {}),
    ...(selection.routing ? { routing: selection.routing } : {}),
    agentSurface: context.agentSurface ?? 'code',
    ...(subagentTaskRequiresReadOnly(common.prompt) ? { toolPolicyCeiling: 'readOnly' as const } : {}),
    security: {
      sandboxRoot: context.workspace,
      ...(context.allowedProviderIds ? { allowedProviderIds: [...context.allowedProviderIds] } : {}),
      ...(context.allowedToolNames ? { allowedToolNames: [...context.allowedToolNames] } : {}),
      ...(context.allowedSkillIds ? { allowedSkillIds: [...context.allowedSkillIds] } : {}),
      ...(context.allowedReadPaths ? { allowedReadPaths: [...context.allowedReadPaths] } : {}),
      ...(context.allowedWritePaths ? { allowedWritePaths: [...context.allowedWritePaths] } : {}),
      ...(context.allowedArtifactIds ? { allowedArtifactIds: [...context.allowedArtifactIds] } : {}),
      ...(context.blockedProviderIds ? { blockedProviderIds: [...context.blockedProviderIds] } : {}),
      ...(context.blockedToolNames ? { blockedToolNames: [...context.blockedToolNames] } : {}),
      ...(context.blockedSkillIds ? { blockedSkillIds: [...context.blockedSkillIds] } : {}),
      memoryEnabled: context.memoryPolicy?.enabled === true
    },
    ...(common.inheritedModel ? { inheritedModel: common.inheritedModel } : {}),
    ...(common.inheritedProviderId ? { inheritedProviderId: common.inheritedProviderId } : {}),
    ...(common.inheritedAccountId ? { inheritedAccountId: common.inheritedAccountId } : {}),
    ...(common.inheritedReasoningEffort ? { inheritedReasoningEffort: common.inheritedReasoningEffort } : {}),
    approvalPolicy: context.approvalPolicy,
    ...(context.sandboxMode ? { sandboxMode: context.sandboxMode } : {}),
    approvalReviewer: context.approvalReviewer ?? 'user',
    ...(context.clientSurface ? { clientSurface: context.clientSurface } : {}),
    ...(context.guiDesignCanvas ? { guiDesignCanvas: true } : {}),
    ...(common.detach ? { detach: true } : {}),
    ...(common.returnFormat ? { returnFormat: common.returnFormat } : {}),
    onQueued: async (childId, profile, metadata) => {
      await onUpdate?.({
        output: {
          childId,
          status: 'queued',
          detached: common.detach,
          ...(profile ? { profile } : {}),
          ...(metadata?.profileName ? { profileName: metadata.profileName } : {}),
          ...(metadata?.model ? { model: metadata.model } : {}),
          ...(metadata?.reasoningEffort ? { reasoningEffort: metadata.reasoningEffort } : {})
        },
        isError: false
      })
    },
    ...(common.detach ? {} : {
      onRunning: async (childId, profile, metadata) => {
        await onUpdate?.({
          output: {
            childId,
            status: 'running',
            detached: false,
            ...(profile ? { profile } : {}),
            ...(metadata?.profileName ? { profileName: metadata.profileName } : {}),
            ...(metadata?.model ? { model: metadata.model } : {}),
            ...(metadata?.reasoningEffort ? { reasoningEffort: metadata.reasoningEffort } : {})
          },
          isError: false
        })
      }
    }),
    signal: context.abortSignal
  })
  return {
    output: {
      childId: record.id,
      status: record.status,
      detached: record.detached === true,
      summary: record.summary,
      error: record.error,
      evidence: record.evidence,
      usage: record.usage,
      returnFormat: record.returnFormat,
      ...(record.profile ? { profile: record.profile } : {}),
      ...(record.profileSnapshot?.name ? { profileName: record.profileSnapshot.name } : {}),
      ...(record.model ? { model: record.model } : {}),
      ...(record.reasoningEffort ? { reasoningEffort: record.reasoningEffort } : {}),
      ...(record.routing ? { routing: routingToolOutput(record.routing) } : {}),
      ...(record.toolPolicy ? { toolPolicy: record.toolPolicy } : {}),
      ...(record.toolInvocations !== undefined ? { toolInvocations: record.toolInvocations } : {}),
      ...(record.durationMs !== undefined ? { durationMs: record.durationMs } : {}),
      ...(record.queuedMs !== undefined ? { queuedMs: record.queuedMs } : {})
    },
    isError: record.status === 'failed' || record.status === 'aborted'
  }
}

function parseCustomAgent(value: unknown): CustomSubagentDefinition | undefined | Error {
  if (value === undefined || value === null) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) return new Error('custom_agent must be an object')
  const input = value as Record<string, unknown>
  const parsed = CustomSubagentDefinitionSchema.safeParse({
    name: input.name,
    description: input.description,
    systemPrompt: input.system_prompt,
    toolPolicy: input.tool_policy ?? 'readOnly',
    ...(input.blocked_tools !== undefined ? { blockedTools: input.blocked_tools } : {})
  })
  return parsed.success
    ? parsed.data
    : new Error(`invalid custom_agent: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`)
}

function explicitCustomMetadata(
  inlineProfile: InlineProfile,
  agentSurface: 'code' | 'write' | 'design'
): ChildRoutingMetadata {
  return {
    method: 'explicit-custom',
    selectedKind: 'custom',
    selectedId: inlineProfile.id,
    reason: 'The parent supplied a one-run standalone role.',
    agentSurface,
    candidates: [],
    customAgent: inlineProfile.profile
  }
}

function selectExistingFallback(
  runtime: DelegationRuntime,
  documents: SubagentRoutingDocument[]
): SubagentRoutingDocument | undefined {
  const preferredIds = [runtime.defaultProfileName, 'general'].filter(
    (id): id is string => Boolean(id)
  )
  for (const id of preferredIds) {
    const match = documents.find((document) => document.id === id)
    if (match) return match
  }
  return documents[0]
}

function existingRouteMetadata(
  route: SubagentRouteResult,
  agentSurface: 'code' | 'write' | 'design'
): ChildRoutingMetadata {
  return {
    method: route.source === 'llm-profile' ? 'bm25-llm-profile' : 'bm25-fallback-profile',
    selectedKind: 'profile',
    selectedId: route.profileId ?? 'general',
    agentSurface,
    reason: route.reason,
    ...(route.confidence !== undefined ? { confidence: route.confidence } : {}),
    candidates: route.candidates
  }
}

function existingFallbackMetadata(
  route: SubagentRouteResult | undefined,
  selectedId: string,
  agentSurface: 'code' | 'write' | 'design'
): ChildRoutingMetadata {
  return {
    method: 'bm25-fallback-profile',
    selectedKind: 'profile',
    selectedId,
    agentSurface,
    reason: route
      ? `${route.reason} Reused the configured default agent because existing-agent mode is enabled.`
      : 'Reused the configured default agent because existing-agent mode is enabled.',
    ...(route?.confidence !== undefined ? { confidence: route.confidence } : {}),
    candidates: route?.candidates ?? []
  }
}

function routingToolOutput(routing: ChildRoutingMetadata): Record<string, unknown> {
  return {
    method: routing.method,
    selectedKind: routing.selectedKind,
    selectedId: routing.selectedId,
    ...(routing.reason ? { reason: routing.reason } : {}),
    ...(routing.confidence !== undefined ? { confidence: routing.confidence } : {}),
    candidates: routing.candidates.map((candidate) => ({
      targetId: candidate.targetId,
      name: candidate.name,
      source: candidate.source,
      score: candidate.score
    })),
    ...(routing.generation ? { generation: routing.generation } : {}),
    ...(routing.customAgent ? {
      agent: {
        name: routing.customAgent.name,
        description: routing.customAgent.description,
        toolPolicy: routing.customAgent.toolPolicy
      }
    } : {})
  }
}

function buildDelegateTaskDescription(runtime: DelegationRuntime): string {
  const modeDescription = runtime.useExistingAgents !== false
    ? 'Select an exact reusable profile id from list_subagent_profiles, or omit profile so Kun can route over the effective catalog.'
    : 'Define the best one-run role for this task in custom_agent. Do not select or recall an existing profile in this mode.'
  return [
    'Run a standalone child agent and return its result.',
    modeDescription,
    'Child model, provider, and reasoning strength remain host-controlled and are not tool-call arguments.',
    'Issue multiple calls in one message for independent parallel work.',
    `Children default to the "${runtime.defaultToolPolicy}" tool policy and can never recursively delegate.`
  ].join(' ')
}

function buildListSubagentProfilesDescription(runtime: DelegationRuntime): string {
  return runtime.useExistingAgents !== false
    ? 'List the effective reusable subagent profiles for the current workspace and product surface.'
    : 'Describe the one-run custom subagent capability available while reusable profiles are disabled.'
}

function nonnegativeInteger(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.max(0, Math.floor(value))
}

function boundedPositiveInteger(value: unknown, fallback: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(1, Math.floor(value)))
}

function boundedText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function toolError(message: string): { output: { error: string }; isError: true } {
  return { output: { error: message }, isError: true }
}
