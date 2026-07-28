import type { ApprovalPolicy, SandboxMode } from '../contracts/policy.js'
import type { DelegationRuntime } from '../delegation/delegation-runtime.js'
import type { ThreadStore } from '../ports/thread-store.js'
import type { TurnService } from '../services/turn-service.js'
import type { GraphRuntimeStartOptions } from './graph-runtime-factory.js'
import { graphParentAuthorityToolNames } from '../graph/graph-tool-boundary.js'
import type { CapabilityToolSpec } from '../adapters/tool/capability-registry.js'

type GraphAuthorityDefaults = {
  model: string
  approvalPolicy: ApprovalPolicy
  sandboxMode: SandboxMode
  allowedMcpServers: string[]
  disabledSkillIds: string[]
  networkAllowed: boolean
}

export function createGraphRuntimeStartOptions(input: {
  delegation: () => DelegationRuntime | undefined
  threads: Pick<ThreadStore, 'get'>
  startTurn: (
    request: Parameters<TurnService['startTurn']>[0]
  ) => ReturnType<TurnService['startTurn']>
  runAgentTurn: (
    threadId: string,
    turnId: string
  ) => Promise<'completed' | 'failed' | 'aborted'>
  defaults: () => GraphAuthorityDefaults
  tools: () => CapabilityToolSpec[]
  skillIds: () => string[]
}): GraphRuntimeStartOptions {
  return {
    delegation: input.delegation,
    leadTurn: async ({ run, reasons, nodeIds, digest }) => {
      const thread = await input.threads.get(run.threadId)
      if (!thread) return
      const started = await input.startTurn({
        threadId: run.threadId,
        request: {
          prompt: graphLeadPrompt({
            runId: run.id,
            runStatus: run.status,
            reasons,
            nodeIds,
            digest
          }),
          messageSource: 'graph_runtime',
          model: thread.model,
          providerId: thread.providerId,
          accountId: thread.accountId,
          mode: 'agent',
          orchestration: 'direct',
          disableUserInput: true
        }
      })
      await input.runAgentTurn(run.threadId, started.turnId)
    },
    authorityForRun: async (run) => {
      const thread = await input.threads.get(run.threadId)
      const sourceTurn = thread?.turns.find((turn) => turn.id === run.sourceTurnId)
      const defaults = input.defaults()
      const sandboxMode = thread?.sandboxMode ?? defaults.sandboxMode
      const model = sourceTurn?.model ?? thread?.model ?? defaults.model
      const providerId = sourceTurn?.providerId ?? thread?.providerId ?? 'default'
      const tools = input.tools()
      const allowedProviders = [...new Set(tools
        .filter((tool) => defaults.networkAllowed || tool.effects?.network === false)
        .map((tool) => tool.providerId))]
      return {
        workspaceRoot: run.plans.at(-1)!.workspaceRoot,
        model,
        providerId,
        allowedModelProviderIds: [providerId],
        allowedModels: [model],
        allowedProviderIds: allowedProviders,
        reasoningEffort: sourceTurn?.reasoningEffort ?? 'off',
        approvalPolicy: thread?.approvalPolicy ?? defaults.approvalPolicy,
        sandboxMode,
        allowedTools: graphParentAuthorityToolNames(tools
          .filter((tool) => allowedProviders.includes(tool.providerId))
          .map((tool) => tool.name)),
        blockedTools: [],
        allowedSkills: input.skillIds(),
        blockedSkills: defaults.disabledSkillIds,
        allowedMcpServers: defaults.allowedMcpServers,
        blockedMcpServers: [],
        readScopes: ['.'],
        writeScopes: sandboxMode === 'read-only' ? [] : ['.'],
        networkAllowed: defaults.networkAllowed
      }
    }
  }
}

function graphLeadPrompt(input: {
  runId: string
  runStatus: string
  reasons: string[]
  nodeIds: string[]
  digest: string
}): string {
  return [
    `Graph Lead supervision for durable run ${input.runId}.`,
    `Signals: ${input.reasons.join(', ') || 'status change'}.`,
    input.nodeIds.length ? `Affected nodes: ${input.nodeIds.join(', ')}.` : '',
    input.digest ? `Bounded signal digest:\n${input.digest}` : '',
    'Inspect current durable truth with graph_control_run before deciding.',
    'Use only validated Graph tools for mutations. Do not edit Graph state indirectly.',
    input.runStatus === 'completed'
      ? 'Present the persisted final synthesis, evidence, changed files, checks, costs, and unresolved risks to the user.'
      : 'Supervise progress, resolve safe issues, or request human input for policy/risk decisions.'
  ].filter(Boolean).join('\n\n')
}
