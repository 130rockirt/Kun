import type { ApprovalPolicy, SandboxMode } from '../contracts/policy.js'
import type { DelegationRuntime } from '../delegation/delegation-runtime.js'
import type { ThreadStore } from '../ports/thread-store.js'
import type { TurnService } from '../services/turn-service.js'
import type { GraphRuntimeStartOptions } from './graph-runtime-factory.js'
import { graphParentAuthorityToolNames } from '../graph/graph-tool-boundary.js'
import type { CapabilityToolSpec } from '../adapters/tool/capability-registry.js'
import type { TurnRunOutcome } from '../loop/turn-execution-types.js'

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
  resumeTurn: (
    request: Parameters<TurnService['resumeGraphLeadTurn']>[0]
  ) => ReturnType<TurnService['resumeGraphLeadTurn']>
  isTurnExecutionActive: (turnId: string) => boolean
  steerTurn: (
    request: Parameters<TurnService['steerTurn']>[0]
  ) => ReturnType<TurnService['steerTurn']>
  runAgentTurn: (
    threadId: string,
    turnId: string
  ) => Promise<TurnRunOutcome>
  defaults: () => GraphAuthorityDefaults
  tools: () => CapabilityToolSpec[]
  skillIds: () => string[]
}): GraphRuntimeStartOptions {
  return {
    delegation: input.delegation,
    leadTurn: async ({ run, reasons, nodeIds, digest }) => {
      const thread = await input.threads.get(run.threadId)
      if (!thread) return
      const prompt = graphLeadPrompt({
        runId: run.id,
        runStatus: run.status,
        reasons,
        nodeIds,
        digest
      })
      const sourceTurn = thread.turns.find((turn) => turn.id === run.sourceTurnId)
      if (!sourceTurn) return
      if (sourceTurn.status !== 'running') {
        // Legacy GraphRuns may have been detached from an already-terminal
        // source turn. Preserve immutable history instead of fabricating a
        // replacement Lead turn.
        return
      }
      if (input.isTurnExecutionActive(sourceTurn.id)) {
        await input.steerTurn({
          threadId: run.threadId,
          turnId: sourceTurn.id,
          text: prompt,
          messageSource: 'graph_runtime'
        })
        return
      }
      const resumed = await input.resumeTurn({
        threadId: run.threadId,
        turnId: sourceTurn.id,
        runId: run.id,
        lastDeliveredSeq: run.lastEventSeq,
        terminal:
          run.status === 'completed' ||
          run.status === 'failed' ||
          run.status === 'cancelled'
      })
      await input.steerTurn({
        threadId: run.threadId,
        turnId: sourceTurn.id,
        text: prompt,
        messageSource: 'graph_runtime'
      })
      if (resumed === 'already_running') return
      let outcome = await input.runAgentTurn(run.threadId, sourceTurn.id)
      // A wake-up can reacquire the execution lease during the tiny interval
      // between a previous slice parking and its active-run promise settling.
      // Once that promise is gone, start the continuation that owns the lease.
      while (outcome === 'suspended' && input.isTurnExecutionActive(sourceTurn.id)) {
        outcome = await input.runAgentTurn(run.threadId, sourceTurn.id)
      }
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
    ['completed', 'failed', 'cancelled'].includes(input.runStatus)
      ? 'Present the persisted terminal outcome, synthesis, evidence, changed files, checks, costs, and unresolved risks to the user.'
      : [
          'Report a concise milestone to the user from this same Lead turn.',
          'Supervise progress and resolve safe issues; retry, repair, patch, or rebind eligible work when evidence requires it.',
          'Request human input only for decisions that policy or risk prevents you from making.',
          'When the run remains nonterminal after this update, stop cleanly so the host can suspend this turn until the next material event.'
        ].join(' ')
  ].filter(Boolean).join('\n\n')
}
