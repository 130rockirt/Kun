import { dirname } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import type { CacheRequestSignature } from '../cache/cache-diagnostics.js'
import type { ImmutablePrefix } from '../cache/immutable-prefix.js'
import type { PipelineStage } from '../contracts/events.js'
import type { ModelCapabilityMetadata } from '../contracts/capabilities.js'
import type { TurnItem } from '../contracts/items.js'
import type { ActingTurnModelRoute } from '../contracts/turns.js'
import { makeErrorItem } from '../domain/item.js'
import { repairModelHistoryItemsForModel } from '../domain/model-history-repair.js'
import { memoryPreview } from '../shared/memory-preview.js'
import type { IdGenerator } from '../ports/id-generator.js'
import type { ModelClient, ModelToolSpec } from '../ports/model-client.js'
import type { SessionStore } from '../ports/session-store.js'
import type { ThreadStore } from '../ports/thread-store.js'
import type { GuiPlanContext } from '../ports/tool-host.js'
import type { RuntimeEventRecorder } from '../services/runtime-event-recorder.js'
import type { TurnService } from '../services/turn-service.js'
import type { ThreadItemProjectionService } from '../services/thread-item-projection.js'
import { CREATE_PLAN_TOOL_NAME } from '../adapters/tool/create-plan-tool.js'
import {
  DESIGN_SVG_ANIMATE_TOOL_NAME,
  DESIGN_SVG_EDIT_TOOL_NAME,
  DESIGN_SVG_VALIDATE_TOOL_NAME
} from '../adapters/tool/design-svg-tool.js'
import { resolveWorkspacePath, shellRuntimeInstruction } from '../adapters/tool/builtin-tool-utils.js'
import { VERIFY_CHANGES_TOOL_NAME } from '../adapters/tool/builtin-verify-tool.js'
import { GRAPH_DEFINE_PLAN_TOOL_NAME } from '../adapters/tool/graph-define-plan-tool.js'
import { GRAPH_LEAD_MODE_INSTRUCTION } from '../prompt/graph-lead-mode.js'
import { buildToolPreferenceInstruction } from '../prompt/kun-system-prompt.js'
import {
  buildClientSurfaceInstruction,
  buildKunTurnContextInstructions,
  type KunTurnContextAuthority,
  type KunTurnContextBlock
} from '../prompt/kun-prompt-context.js'
import { effectiveHistoryAfterLatestCompaction } from './compaction-history.js'
import { resolveCoherentProviderAccount } from './compaction-summary.js'
import {
  EMPTY_POST_TOOL_FINAL_ANSWER_RECOVERY_STEP,
  emptyPostToolRecoveryInstruction,
  filterGoalContextsForActiveGoal,
  hasSuccessfulCreatePlanResult,
  POST_TOOL_FAILURE_FINAL_ANSWER_RECOVERY_STEP,
  postToolFailureRecoveryInstruction,
  TOOL_SUPPRESSION_FINAL_ANSWER_RECOVERY_STEP,
  toolSuppressionRecoveryInstruction,
  userInputUnavailableInstruction
} from './continuation-instructions.js'
import {
  DESIGN_MODE_INSTRUCTION,
  SVG_ARTIFACT_MODE_INSTRUCTION
} from './design-mode.js'
import type { GoalTurnCoordinator } from './goal-turn-coordinator.js'
import type { HistoryCompactionService } from './history-compaction-service.js'
import { healLoadedHistoryItems } from './history-healing.js'
import type { LoopTelemetry } from './loop-telemetry.js'
import { memoryInstructions } from './memory-instructions.js'
import { modelCapabilitiesForModel } from './model-context-profile.js'
import type { ModelRoundEngine } from './model-round-engine.js'
import { modelClientDiagnostics } from './model-client-diagnostics.js'
import { composeModelRequest, effectiveOutputBudgetTokens } from './model-request-composer.js'
import { estimateModelRequestInputTokenBreakdown } from './model-request-estimator.js'
import type { ModelRoutingService } from './model-routing-service.js'
import {
  PLAN_MODE_INSTRUCTION,
  resolvePlanModeToolSpecs,
  turnHasUnverifiedSourceChanges,
  verificationSuggestionInstruction
} from './plan-mode.js'
import {
  buildRuntimeContextInstruction,
  shouldInjectInitialRuntimeContext
} from './runtime-context.js'
import {
  GRAPH_CREATE_RUN_TOOL_NAME,
  type RoundOutcomeCoordinator
} from './round-outcome-coordinator.js'
import { svgArtifactCompletionState } from './svg-artifact-completion.js'
import {
  rehydrateGeneratedImagesForForward,
  rehydrateTransientBrowserUseOutputsForForward,
  MAX_FORWARDED_GENERATED_IMAGES
} from './tool-result-image.js'
import {
  attachmentRequestPipelineDetails,
  imageGenerationReferenceInstructions,
  type TurnAttachmentService
} from './turn-attachment-service.js'
import type { TurnBudgetGate } from './turn-budget-gate.js'
import type { TurnContextResolver } from './turn-context-resolver.js'
import { resolveTurnModeContext } from './turn-context-resolver.js'
import type {
  ModelRoundOutcome,
  PreparedTurnContext,
  TurnExecutionFailure
} from './turn-execution-types.js'
import type { TokenEconomyConfig } from './token-economy.js'
import { normalizeTurnLimits, type TurnLimitsConfig } from './turn-limits.js'
import {
  detectVolatilePrefixContent,
  type PrefixVolatilityFinding
} from '../cache/prefix-volatility.js'
import {
  shouldVerifyImmutablePrefix,
  verifyImmutablePrefix
} from '../cache/immutable-prefix.js'
import { buildToolCatalogFingerprint } from '../cache/tool-catalog-fingerprint.js'
import { rewriteItemHistoryWithRetry } from '../services/history-commit-coordinator.js'
import { TurnToolCatalogFreezer } from './turn-tool-catalog.js'

export type ModelStepServiceDeps = {
  threadStore: ThreadStore
  sessionStore: SessionStore
  turns: Pick<TurnService, 'getTurn' | 'applyItem' | 'updateItem' | 'updateTurnMetadata' | 'ensureGoalContext'>
  events: Pick<RuntimeEventRecorder, 'record'>
  model: ModelClient
  compactor: import('./context-compactor.js').ContextCompactor
  prefix: ImmutablePrefix
  ids: Pick<IdGenerator, 'next'>
  nowIso: () => string
  modelCapabilities?: (model: string, providerId?: string) => ModelCapabilityMetadata
  activePlanContext?: GuiPlanContext
  tokenEconomy?: TokenEconomyConfig
  toolArgumentRepair?: { maxStringBytes?: number }
  turnLimits?: TurnLimitsConfig
  modelRouting: ModelRoutingService
  budgetGate: TurnBudgetGate
  goalTurns: Pick<GoalTurnCoordinator, 'suppressResume'>
  threadItems: Pick<ThreadItemProjectionService, 'syncFromSession'>
  turnContextResolver: TurnContextResolver
  telemetry: Pick<LoopTelemetry, 'recordToolCatalogFingerprint'>
  historyCompaction: HistoryCompactionService
  turnAttachments: TurnAttachmentService
  modelRoundEngine: ModelRoundEngine
  roundOutcome: RoundOutcomeCoordinator
  recordPipelineStage: (
    threadId: string,
    turnId: string,
    stage: PipelineStage,
    details?: Record<string, unknown>
  ) => Promise<void>
  recordToolCatalogDrift: (input: {
    threadId: string
    turnId: string
    fingerprint: string
    toolCount: number
    toolNames: string[]
    changeKind: 'additive' | 'breaking'
    message: string
  }) => Promise<void>
  recordTokenEconomySavings: (input: {
    threadId: string
    turnId: string
    model: string
    rawInputTokens: number
    sentInputTokens: number
  }) => Promise<void>
  rememberFailure: (turnId: string, failure: TurnExecutionFailure) => void
  awaitWorkspaceCheckpoint?: (
    checkpointRequestId: string,
    signal: AbortSignal
  ) => Promise<string | null>
}

export class ModelStepService {
  private readonly turnToolCatalogs = new TurnToolCatalogFreezer()
  private readonly workspaceCheckpointGates = new Map<string, Promise<void>>()

  constructor(private readonly deps: ModelStepServiceDeps) {}

  async run(
    threadId: string,
    turnId: string,
    signal: AbortSignal,
    stepIndex = 0,
    maxToolCallsPerStep = normalizeTurnLimits(this.deps.turnLimits).maxToolCallsPerStep
  ): Promise<ModelRoundOutcome> {
    if (shouldVerifyImmutablePrefix()) {
      verifyImmutablePrefix(this.deps.prefix)
    }
    const [thread, turn] = await Promise.all([
      this.deps.threadStore.get(threadId),
      this.deps.turns.getTurn(threadId, turnId)
    ])
    // A delete/interrupt can win while a model step is waiting for its prior
    // I/O. Do not fall back to empty workspace/default settings: that would
    // let a stale continuation issue a new request or dispatch a tool after
    // its owning thread/turn no longer exists.
    if (signal.aborted || !thread || !turn) return 'aborted'
    const modeContext = resolveTurnModeContext({
      turn,
      workspace: thread.workspace,
      threadMode: thread.mode,
      ...(this.deps.activePlanContext ? { fallbackPlanContext: this.deps.activePlanContext } : {})
    })
    const { dedicatedSvgTurn, activePlanContext } = modeContext
    await this.deps.recordPipelineStage(threadId, turnId, 'input_received', { stepIndex })
    const budgetGate = await this.deps.budgetGate.check(thread, threadId, turnId)
    // A deadline, lease loss, or explicit interruption can win while an
    // asynchronous budget check is settling. Do not materialize internal
    // history (or perform any further model preparation) for that aborted
    // execution merely because the persisted turn has not been finalized yet.
    if (signal.aborted) return 'aborted'
    if (budgetGate === 'blocked') {
      // A cost-budget stop is a deliberate cap, not an interrupted goal turn:
      // suppress goal auto-resume so it isn't relaunched straight back into
      // the same exhausted budget.
      this.deps.goalTurns.suppressResume(turnId)
      if (this.deps.roundOutcome.toolSuppressionRecoverySteps(turnId) > 0) {
        return this.deps.roundOutcome.failToolSuppressionRecovery(threadId, turnId)
      }
      if (dedicatedSvgTurn) {
        const persistedCompletion = svgArtifactCompletionState(
          await this.deps.sessionStore.loadItems(threadId),
          turnId
        )
        if (persistedCompletion.validationAfterMutation) return 'stop'
        this.deps.rememberFailure(turnId, {
          error: 'Dedicated SVG artifact turn could not satisfy its completion gate before the budget was exhausted.',
          code: 'svg_completion_budget_blocked',
          severity: 'error'
        })
        return 'failed'
      }
      return 'stop'
    }
    const planTurnSuppressesGoalContext = !modeContext.dedicatedSvgTurn && !modeContext.planContextStale && (
      modeContext.effectiveMode === 'plan' || Boolean(modeContext.activePlanContext)
    )
    if (!planTurnSuppressesGoalContext) {
      await this.deps.turns.ensureGoalContext(threadId, turnId, signal)
    }
    if (signal.aborted) return 'aborted'
    const loadedItems = await this.deps.sessionStore.loadItems(threadId)
    // Heal (and possibly rewrite) on-disk history once per turn: within a
    // turn the loop only appends well-formed items, and healing's deep
    // change detection costs two full-history stringifies per call.
    let historyItems: TurnItem[] = loadedItems
    if (stepIndex === 0) {
      const healing = await rewriteItemHistoryWithRetry({
        sessionStore: this.deps.sessionStore,
        threadId,
        maxAttempts: 2,
        build: (snapshot) => {
          const healed = healLoadedHistoryItems(snapshot.items)
          return { changed: healed.changed, items: healed.items, value: undefined }
        }
      })
      if (healing.status === 'applied') {
        await this.deps.threadItems.syncFromSession(threadId)
        historyItems = healing.items
      } else if (healing.status === 'unchanged') {
        historyItems = healing.items
      } else {
        // A later step will retry persistence. Use a locally healed view now
        // rather than letting one malformed legacy record poison this request.
        historyItems = healLoadedHistoryItems(
          await this.deps.sessionStore.loadItems(threadId)
        ).items
      }
    }
    // Keep historical goal records durable without replaying an instruction
    // for a goal that has since paused, ended, been cleared, or been replaced.
    // A plan turn intentionally suppresses goal continuation just as it did
    // before goal context became canonical history.
    const goalForHistory = planTurnSuppressesGoalContext
      ? undefined
      : (await this.deps.threadStore.get(threadId))?.goal
    historyItems = filterGoalContextsForActiveGoal(historyItems, goalForHistory)
    await this.deps.recordPipelineStage(
      threadId,
      turnId,
      'input_cached',
      prefixVolatilityStageDetails(detectVolatilePrefixContent(this.deps.prefix))
    )
    if (stepIndex > 0) {
      const toolResultCount = historyItems.filter(
        (item) => item.turnId === turnId && item.kind === 'tool_result'
      ).length
      await this.deps.events.record({
        kind: 'tool_result_upload_wait',
        threadId,
        turnId,
        status: 'waiting',
        toolResultCount
      })
    }
    const items = repairModelHistoryItemsForModel(
      effectiveHistoryAfterLatestCompaction(historyItems)
    )
    const inheritedProviderAccount = resolveCoherentProviderAccount({
      turnProviderId: turn.providerId,
      turnAccountId: turn.accountId,
      threadProviderId: thread.providerId,
      threadAccountId: thread.accountId
    })
    const routeProviderId = turn.actingModelRoute?.providerId ?? inheritedProviderAccount.providerId
    const routeAccountId = turn.actingModelRoute?.accountId ?? inheritedProviderAccount.accountId
    const modelRoute = turn.actingModelRoute
      ? {
          model: turn.actingModelRoute.model,
          ...(turn.reasoningEffort ? { reasoningEffort: turn.reasoningEffort } : {})
        }
      : await this.deps.modelRouting.resolve({
          threadId,
          turnId,
          latestRequest: turn?.prompt ?? '',
          items,
          signal,
          ...(routeProviderId ? { providerId: routeProviderId } : {}),
          ...(routeAccountId ? { accountId: routeAccountId } : {}),
          reasoningEffort: turn?.reasoningEffort,
          candidates: [turn?.model, thread?.model, this.deps.model.model]
        })
    const actingModelRoute = turn.actingModelRoute ?? {
      model: modelRoute.model,
      ...(routeProviderId ? { providerId: routeProviderId } : {}),
      ...(routeAccountId ? { accountId: routeAccountId } : {})
    }
    const historyRoutesByTurnId = modelHistoryRoutesByTurnId(thread, actingModelRoute, turnId)
    const routeSelectionDeferred =
      !turn.actingModelRoute &&
      this.deps.model.selectsRouteTargetDuringStream?.({
        model: modelRoute.model,
        ...(routeProviderId ? { providerId: routeProviderId } : {})
      }) === true
    if (!turn.actingModelRoute && !routeSelectionDeferred) {
      await this.deps.turns.updateTurnMetadata(threadId, turnId, { actingModelRoute })
    }
    const providerId = actingModelRoute.providerId
    const accountId = actingModelRoute.accountId
    await this.deps.recordPipelineStage(threadId, turnId, 'input_routed', {
      model: modelRoute.model,
      ...(modelRoute.reasoningEffort ? { reasoningEffort: modelRoute.reasoningEffort } : {})
    })
    const model = modelRoute.model
    // `default` is the explicit turn pin for the runtime's implicit provider.
    // Capability resolvers historically receive that provider as `undefined`;
    // keep that contract while still sending the explicit alias to the model
    // router so a later thread selection cannot take over this turn.
    const capabilityProviderId = providerId?.trim().toLowerCase() === 'default'
      ? undefined
      : providerId
    const modelCapabilities =
      this.deps.modelCapabilities?.(model, capabilityProviderId) ?? modelCapabilitiesForModel(model)
    const serviceTier =
      turn?.serviceTier === 'priority' &&
      modelCapabilities.serviceTiers?.includes('priority')
        ? 'priority' as const
        : undefined
    const prepared = await this.deps.turnContextResolver.resolve({
      threadId,
      turnId,
      thread,
      turn,
      history: historyItems,
      model,
      actingModelRoute,
      modelCapabilities,
      signal,
      mode: modeContext,
      goalNoToolRecoverySteps: this.deps.roundOutcome.goalNoToolRecoverySteps(turnId)
    })
    const {
      mode: effectiveMode,
      approvalPolicy,
      sandboxMode,
      attachments,
      skillResolution,
      instructionResolution,
      memories,
      activeGoalInstruction,
      goalRecoveryInstruction,
      activeTodoInstruction,
      planTurnActive,
      allowedToolNames,
      userInputDisabled,
      toolDiscoveryContext: toolContext,
      tools: liveTools
    } = prepared
    const frozenToolCatalog = this.turnToolCatalogs.resolve(
      threadId,
      turnId,
      [...liveTools],
      toolCatalogPolicyScope(prepared)
    )
    const tools = frozenToolCatalog.tools
    if (dedicatedSvgTurn) {
      const toolNames = new Set(tools.map((tool) => tool.name))
      const hasMutationTool = toolNames.has(DESIGN_SVG_EDIT_TOOL_NAME) || toolNames.has(DESIGN_SVG_ANIMATE_TOOL_NAME)
      const hasValidationTool = toolNames.has(DESIGN_SVG_VALIDATE_TOOL_NAME)
      const completionAlreadySatisfied = svgArtifactCompletionState(historyItems, turnId).validationAfterMutation
      if (!completionAlreadySatisfied && (approvalPolicy === 'never' || !hasMutationTool || !hasValidationTool)) {
        const message = approvalPolicy === 'never'
          ? 'Dedicated SVG artifact turns require tool execution, but the current approval policy disables tools.'
          : 'Dedicated SVG artifact tools are unavailable under the current plan, skill, or sandbox policy.'
        this.deps.rememberFailure(turnId, { error: message, code: 'svg_tools_unavailable', severity: 'error' })
        await this.deps.events.record({
          kind: 'error', threadId, turnId, message, code: 'svg_tools_unavailable', severity: 'error'
        })
        await this.deps.turns.applyItem(threadId, makeErrorItem({
          id: this.deps.ids.next('item_error'), turnId, threadId, message,
          code: 'svg_tools_unavailable', severity: 'error'
        }))
        return 'failed'
      }
    }
    const toolSpecs: ModelToolSpec[] = [...tools]
    const toolProviderMetadata = new Map(
      tools.map((tool) => [tool.name, { providerId: tool.providerId, providerKind: tool.providerKind }])
    )
    const streamToolMetadata = new Map(
      tools.map((tool) => [tool.name, { providerId: tool.providerId, toolKind: tool.toolKind }])
    )
    const toolProviderKinds = new Map(
      tools.map((tool) => [tool.name, tool.providerKind])
    )
    const toolCatalog = buildToolCatalogFingerprint(toolSpecs)
    const previousTurnDrift = this.deps.telemetry.recordToolCatalogFingerprint({
      threadId,
      workspace: thread?.workspace ?? '',
      mode: effectiveMode ?? 'agent',
      model: modelCapabilities.id,
      activeSkillIds: skillResolution.activeSkillIds,
      allowedToolNames,
      userInputDisabled,
      guiDesignCanvas: turn?.guiDesignCanvas === true,
      guiDesignMode: turn?.guiDesignMode === true,
      guiDesignArtifact: turn?.guiDesignArtifact,
      fingerprint: toolCatalog.fingerprint,
      toolNames: toolCatalog.toolNames,
      toolHashes: toolCatalog.toolHashes
    })
    const toolCatalogDrift = frozenToolCatalog.pendingDrift.kind !== 'none'
      ? frozenToolCatalog.pendingDrift
      : previousTurnDrift
    const diagnosticCatalog = frozenToolCatalog.pendingCatalog ?? toolCatalog
    const toolCatalogDriftMessage = toolCatalogDrift.kind !== 'none'
      ? buildToolCatalogDriftMessage(
          diagnosticCatalog,
          toolCatalogDrift.kind,
          frozenToolCatalog.pendingCatalog ? 'deferred' : 'applied'
        )
      : undefined
    if (toolCatalogDrift.kind !== 'none' && toolCatalogDriftMessage) {
      await this.deps.recordToolCatalogDrift({
        threadId,
        turnId,
        fingerprint: diagnosticCatalog.fingerprint,
        toolCount: diagnosticCatalog.toolCount,
        toolNames: diagnosticCatalog.toolNames,
        changeKind: toolCatalogDrift.kind,
        message: toolCatalogDriftMessage
      })
    }
    if (turn) {
      await this.deps.turns.updateTurnMetadata(threadId, turnId, {
        activeSkillIds: skillResolution.activeSkillIds,
        skillInjectionBytes: skillResolution.injectedBytes,
        injectedMemoryIds: memories.map((memory) => memory.id),
        injectedMemorySummaries: memories.map((memory) => ({
          id: memory.id,
          content: memoryPreview(memory.content)
        })),
        injectedInstructionSources: instructionResolution.sources,
        instructionInjectionBytes: instructionResolution.injectedBytes,
        toolCatalogFingerprint: toolCatalog.fingerprint,
        toolCatalogToolCount: toolCatalog.toolCount,
        toolCatalogDrift: toolCatalogDrift.kind !== 'none'
      })
    }
    const toolKinds = new Map(toolSpecs.map((tool) => [tool.name, tool.toolKind]))
    const createPlanSatisfied = planTurnActive
      ? hasSuccessfulCreatePlanResult(historyItems, turnId)
      : false
    const graphCreateSatisfied = turn.orchestration === 'graph'
      ? turn.graphPlanningLifecycle?.state === 'committed' ||
        hasSuccessfulToolResult(historyItems, turnId, GRAPH_DEFINE_PLAN_TOOL_NAME) ||
        hasSuccessfulToolResult(historyItems, turnId, GRAPH_CREATE_RUN_TOOL_NAME)
      : false
    const svgCompletion = turn?.guiDesignArtifact?.kind === 'svg'
      ? svgArtifactCompletionState(historyItems, turnId)
      : null
    const hardRequiredToolName =
      svgCompletion?.mutationSucceeded &&
            !svgCompletion.validationAfterMutation
        ? DESIGN_SVG_VALIDATE_TOOL_NAME
        : undefined
    // Plan creation is deliberately a soft completion condition. A Plan turn
    // may investigate, ask for user input, or stop on a genuine clarification
    // before its prose is materialized through create_plan.
    const softRequiredToolName =
      turn.orchestration === 'graph' &&
      !graphCreateSatisfied &&
      toolSpecs.some((tool) => tool.name === GRAPH_DEFINE_PLAN_TOOL_NAME)
        ? GRAPH_DEFINE_PLAN_TOOL_NAME
        : planTurnActive &&
      !createPlanSatisfied &&
      toolSpecs.some((tool) => tool.name === CREATE_PLAN_TOOL_NAME)
        ? CREATE_PLAN_TOOL_NAME
        : undefined
    const suggestVerification =
      !planTurnActive &&
      toolSpecs.some((tool) => tool.name === VERIFY_CHANGES_TOOL_NAME) &&
      turnHasUnverifiedSourceChanges(historyItems, turnId)
    const effectiveToolSpecs = resolvePlanModeToolSpecs(toolSpecs, {
      planTurnActive,
      createPlanSatisfied,
      stepIndex
    })
    const emptyPostToolRecoveryStep = this.deps.roundOutcome.emptyPostToolRecoverySteps(turnId)
    const forceEmptyPostToolFinalAnswerRecovery =
      emptyPostToolRecoveryStep >= EMPTY_POST_TOOL_FINAL_ANSWER_RECOVERY_STEP
    const toolSuppressionRecoveryStep =
      this.deps.roundOutcome.toolSuppressionRecoverySteps(turnId)
    const forceToolSuppressionFinalAnswerRecovery =
      !hardRequiredToolName &&
      !softRequiredToolName &&
      !dedicatedSvgTurn &&
      toolSuppressionRecoveryStep >= TOOL_SUPPRESSION_FINAL_ANSWER_RECOVERY_STEP
    const postToolFailureRecoveryStep =
      this.deps.roundOutcome.postToolFailureRecoverySteps(turnId)
    const forcePostToolFailureFinalAnswerRecovery =
      postToolFailureRecoveryStep >= POST_TOOL_FAILURE_FINAL_ANSWER_RECOVERY_STEP
    const forceFinalAnswerRecovery =
      forceEmptyPostToolFinalAnswerRecovery ||
      forceToolSuppressionFinalAnswerRecovery ||
      forcePostToolFailureFinalAnswerRecovery
    const planningToolSpecs = turn.orchestration === 'graph' && !graphCreateSatisfied
      ? effectiveToolSpecs.filter((tool) =>
          tool.name === GRAPH_DEFINE_PLAN_TOOL_NAME ||
          tool.name === 'request_user_input' ||
          tool.name === 'user_input' ||
          tool.sideEffect === 'read-only')
      : effectiveToolSpecs
    const requestToolSpecs = hardRequiredToolName
      ? planningToolSpecs.filter((tool) => tool.name === hardRequiredToolName)
      : forceFinalAnswerRecovery
        ? []
        : planningToolSpecs
    if (hardRequiredToolName && (
      requestToolSpecs.length !== 1 ||
      requestToolSpecs[0]?.name !== hardRequiredToolName ||
      !modelCapabilities.supportsToolCalling
    )) {
      return this.failRequiredToolConstraint({
        threadId,
        turnId,
        code: modelCapabilities.supportsToolCalling
          ? 'required_tool_unavailable'
          : 'required_tool_unsupported',
        message: modelCapabilities.supportsToolCalling
          ? `The required tool \`${hardRequiredToolName}\` is unavailable for this turn.`
          : `The selected model does not support the required tool \`${hardRequiredToolName}\`.`
      })
    }
    const runtimeContextInstruction = shouldInjectInitialRuntimeContext({
      stepIndex,
      turnId,
      historyItems
    })
      ? buildRuntimeContextInstruction({
          workspace: thread?.workspace,
          nowIso: this.deps.nowIso()
        })
      : null
    const toolPreferenceInstruction = buildToolPreferenceInstruction(requestToolSpecs)
    const contextBlocks: KunTurnContextBlock[] = [
      kunContextBlock(
        'client-surface',
        'runtime',
        buildClientSurfaceInstruction(prepared.clientSurface)
      ),
      ...(runtimeContextInstruction
        ? [kunContextBlock('runtime-context', 'runtime', runtimeContextInstruction)]
        : []),
      ...(thread?.additionalWorkspaces?.length
        ? [kunContextBlock(
            'additional-workspaces',
            'workspace',
            `Additional workspace roots explicitly added by the user:\n${thread.additionalWorkspaces.map((path) => `- ${JSON.stringify(path)}`).join('\n')}`
          )]
        : []),
      ...(thread.extensionProfile?.instructionOverlay?.trim()
        ? [kunContextBlock(
            'extension-profile',
            'extension',
            buildExtensionProfileInstruction(
              thread.ownerExtensionId ?? 'unknown',
              thread.extensionProfile.id,
              thread.extensionProfile.instructionOverlay
            )
          )]
        : []),
      ...(instructionResolution.instruction
        ? [kunContextBlock('agents-instructions', 'workspace', instructionResolution.instruction)]
        : []),
      ...(goalRecoveryInstruction && this.deps.roundOutcome.goalNoToolRecoverySteps(turnId) > 0
        ? [kunContextBlock('goal-recovery', 'runtime', goalRecoveryInstruction)]
        : []),
      ...(activeTodoInstruction
        ? [kunContextBlock('thread-todos', 'runtime', activeTodoInstruction)]
        : []),
      ...(emptyPostToolRecoveryStep > 0
        ? [kunContextBlock(
            'model-recovery',
            'runtime',
            emptyPostToolRecoveryInstruction(emptyPostToolRecoveryStep)
          )]
        : []),
      ...(toolSuppressionRecoveryStep > 0
        ? [kunContextBlock(
            'tool-loop-recovery',
            'runtime',
            toolSuppressionRecoveryInstruction(
              toolSuppressionRecoveryStep,
              forceToolSuppressionFinalAnswerRecovery
            )
          )]
        : []),
      ...(postToolFailureRecoveryStep > 0
        ? [kunContextBlock(
            'tool-failure-recovery',
            'runtime',
            postToolFailureRecoveryInstruction(postToolFailureRecoveryStep)
          )]
        : []),
      ...imageGenerationReferenceInstructions({
        imageAttachments: attachments.imageAttachments,
        textFallbacks: attachments.textFallbacks,
        workspace: thread?.workspace ?? '',
        tools: requestToolSpecs
      }).map((content) => kunContextBlock('attachment-reference', 'reference', content)),
      ...memoryInstructions(memories)
        .map((content) => kunContextBlock('memory', 'user', content)),
      ...(skillResolution.catalogInstruction
        ? [kunContextBlock('skill-catalog', 'skill', skillResolution.catalogInstruction)]
        : []),
      ...skillResolution.instructions
        .map((content) => kunContextBlock('skill-instruction', 'skill', content)),
      ...(userInputDisabled
        ? [kunContextBlock('user-input-capability', 'runtime', userInputUnavailableInstruction())]
        : []),
      ...(toolPreferenceInstruction
        ? [kunContextBlock('tool-guidance', 'runtime', toolPreferenceInstruction)]
        : []),
      ...(this.deps.roundOutcome.graphPlanNoToolRecoverySteps(turnId) > 0 &&
          !graphCreateSatisfied
        ? [kunContextBlock(
            'graph-plan-finalization',
            'runtime',
            `You inspected or described the plan but did not call \`${GRAPH_DEFINE_PLAN_TOOL_NAME}\`. ` +
              'If no genuine user clarification is required, call it now using the advertised schema. ' +
              'Do not replace the tool call with prose.'
          )]
        : []),
      ...(requestToolSpecs.some((tool) => tool.name === 'bash')
        ? [kunContextBlock('shell-runtime', 'runtime', shellRuntimeInstruction())]
        : []),
      ...(!forceFinalAnswerRecovery && suggestVerification
        ? [kunContextBlock('verification', 'runtime', verificationSuggestionInstruction())]
        : []),
      ...(toolCatalogDriftMessage
        ? [kunContextBlock('tool-catalog', 'runtime', toolCatalogDriftMessage)]
        : [])
    ]
    const contextInstructions = buildKunTurnContextInstructions(contextBlocks)
    const skillContextInstructions = buildKunTurnContextInstructions(
      contextBlocks.filter((block) => block.authority === 'skill')
    ).slice(1)
    await this.deps.recordPipelineStage(threadId, turnId, 'input_remembered', {
      memoryCount: memories.length,
      contextInstructionCount: contextInstructions.length
    })
    const modeInstruction = [
      ...(turn.orchestration === 'graph' ? [GRAPH_LEAD_MODE_INSTRUCTION] : []),
      ...(planTurnActive ? [PLAN_MODE_INSTRUCTION] : []),
      ...(turn.guiDesignArtifact?.kind === 'svg'
        ? [SVG_ARTIFACT_MODE_INSTRUCTION]
        : turn.guiDesignMode
          ? [DESIGN_MODE_INSTRUCTION]
          : [])
    ].join('\n\n')
    // Automatic compaction must see every non-history part of the request that
    // will actually be sent. Building the same request with empty history gives
    // us an authoritative overhead estimate for system/thread prompts, dynamic
    // context, skills, tools, and attachments without mixing in cumulative
    // provider usage.
    const requestOverheadTokens = composeModelRequest({
      threadId,
      turnId,
      model,
      ...(providerId ? { providerId } : {}),
      ...(accountId ? { accountId } : {}),
      ...(modelRoute.reasoningEffort ? { reasoningEffort: modelRoute.reasoningEffort } : {}),
      ...(serviceTier ? { serviceTier } : {}),
      immutablePrefix: this.deps.prefix,
      ...(thread.systemPrompt !== undefined ? { threadSystemPrompt: thread.systemPrompt } : {}),
      ...(modeInstruction ? { modeInstruction } : {}),
      contextInstructions,
      history: [],
      historyRoutesByTurnId,
      attachments,
      tools: requestToolSpecs,
      ...(hardRequiredToolName ? { requiredToolName: hardRequiredToolName } : {}),
      ...(this.deps.tokenEconomy ? { tokenEconomy: this.deps.tokenEconomy } : {}),
      signal
    }).sentInputTokens
    // Share one capacity model between the compaction preflight and the
    // send-time guard. The output budget is reserved for this request's
    // completion, so compaction must treat `input + output` as the real
    // pressure instead of only comparing input against the soft threshold.
    const declaredOutputBudgetTokens = modelCapabilities.maxOutputTokens
    const requestHardCapTokens = modelCapabilities.contextWindowTokens
      ? Math.floor(modelCapabilities.contextWindowTokens * 0.85)
      : this.deps.compactor.hardCap(model, providerId)
    // Use the request overhead as the conservative input floor during compaction;
    // the final request is recalculated after history/image rehydration.
    const effectiveBudget = (inputTokens: number): number =>
      modelCapabilities.endpointFormat === 'messages' && declaredOutputBudgetTokens === undefined
        ? 0
        : effectiveOutputBudgetTokens({
            inputTokens,
            contextCapTokens: requestHardCapTokens,
            ...(declaredOutputBudgetTokens !== undefined
              ? { declaredMaxOutputTokens: declaredOutputBudgetTokens }
              : {})
          })
    let outputBudgetTokens = effectiveBudget(requestOverheadTokens)
    // History compaction retries from the latest canonical snapshot to avoid
    // losing concurrent writes. That snapshot deliberately retains internal
    // goal records, including records for goals that later ended or changed.
    // Always restore the model-facing projection after a compaction result so
    // a CAS retry cannot resurrect an obsolete system instruction.
    const projectCompactedGoalHistory = async (candidate: TurnItem[]): Promise<TurnItem[]> =>
      filterGoalContextsForActiveGoal(
        candidate,
        planTurnSuppressesGoalContext
          ? undefined
          : (await this.deps.threadStore.get(threadId))?.goal
      )
    const firstCompaction = await this.deps.historyCompaction.compactIfNeeded({
      items,
      model,
      ...(providerId ? { providerId } : {}),
      ...(accountId ? { accountId } : {}),
      ...(serviceTier ? { serviceTier } : {}),
      signal,
      threadId,
      turnId,
      clientSurface: prepared.clientSurface,
      toolSpecs: requestToolSpecs,
      requestOverheadTokens,
      outputBudgetTokens,
      requestHardCapTokens,
      reserveModelRequest: () => this.deps.budgetGate.reserveAdditionalModelRequest(threadId, turnId)
    })
    if (signal.aborted) return 'aborted'
    const postCompactionBudgetGate = await this.deps.budgetGate.recheckReservedMainModelRequest(
      threadId,
      turnId
    )
    if (postCompactionBudgetGate === 'blocked') {
      this.deps.goalTurns.suppressResume(turnId)
      if (this.deps.roundOutcome.toolSuppressionRecoverySteps(turnId) > 0) {
        return this.deps.roundOutcome.failToolSuppressionRecovery(threadId, turnId)
      }
      if (dedicatedSvgTurn) {
        const persistedCompletion = svgArtifactCompletionState(
          await this.deps.sessionStore.loadItems(threadId),
          turnId
        )
        if (persistedCompletion.validationAfterMutation) return 'stop'
        this.deps.rememberFailure(turnId, {
          error: 'Dedicated SVG artifact turn could not satisfy its completion gate before the budget was exhausted.',
          code: 'svg_completion_budget_blocked',
          severity: 'error'
        })
        return 'failed'
      }
      return 'stop'
    }
    let history = await projectCompactedGoalHistory(firstCompaction.history)
    let fallbackCompactionAttempted = false
    let fallbackCompactionApplied = false
    let replacedTokens = firstCompaction.replacedTokens
    let composedRequest = await this.composeForwardedRequest({
      history,
      threadId,
      thread,
      turnId,
      model,
      providerId,
      accountId,
      modelRoute,
      serviceTier,
      modeInstruction,
      contextInstructions,
      historyRoutesByTurnId,
      requestToolSpecs,
      attachments,
      hardRequiredToolName,
      signal
    })
    if (signal.aborted) return 'aborted'
    let inputTokens = composedRequest.sentInputTokens
    outputBudgetTokens = effectiveBudget(inputTokens)
    composedRequest = {
      ...composedRequest,
      request: outputBudgetTokens > 0
        ? { ...composedRequest.request, maxTokens: outputBudgetTokens }
        : composedRequest.request
    }
    // Send-boundary fallback: the final request is rebuilt with transient
    // image/browser-use rehydration, token economy, and history hygiene, so it
    // can legitimately be larger than the compaction preflight estimated. When
    // the exact `input + output` still breaks the cap, compact once more with
    // the exact input as the floor and the deterministic heuristic summary
    // (never a second model call), rebuild, and only then fail if it still
    // does not fit. No loops, no recursion, no upstream dispatch before this
    // guard passes.
    if (inputTokens + outputBudgetTokens > requestHardCapTokens) {
      fallbackCompactionAttempted = true
      const fallbackCompaction = await this.deps.historyCompaction.compactIfNeeded({
        items: history,
        model,
        ...(providerId ? { providerId } : {}),
        ...(accountId ? { accountId } : {}),
        ...(serviceTier ? { serviceTier } : {}),
        signal,
        threadId,
        turnId,
        clientSurface: prepared.clientSurface,
        toolSpecs: requestToolSpecs,
        requestOverheadTokens,
        requestInputTokens: inputTokens,
        outputBudgetTokens,
        requestHardCapTokens,
        allowModelSummary: false,
        reserveModelRequest: () => this.deps.budgetGate.reserveAdditionalModelRequest(threadId, turnId)
      })
      if (signal.aborted) return 'aborted'
      history = await projectCompactedGoalHistory(fallbackCompaction.history)
      fallbackCompactionApplied = fallbackCompaction.compacted
      replacedTokens += fallbackCompaction.replacedTokens
      composedRequest = await this.composeForwardedRequest({
        history,
        threadId,
        thread,
        turnId,
        model,
        providerId,
        accountId,
        modelRoute,
        serviceTier,
        modeInstruction,
        contextInstructions,
        historyRoutesByTurnId,
        requestToolSpecs,
        attachments,
        hardRequiredToolName,
        signal
      })
      if (signal.aborted) return 'aborted'
      inputTokens = composedRequest.sentInputTokens
      outputBudgetTokens = effectiveBudget(inputTokens)
      composedRequest = {
        ...composedRequest,
        request: outputBudgetTokens > 0
          ? { ...composedRequest.request, maxTokens: outputBudgetTokens }
          : composedRequest.request
      }
    }
    if (inputTokens + outputBudgetTokens > requestHardCapTokens) {
      const overBy = inputTokens + outputBudgetTokens - requestHardCapTokens
      const reason = outputBudgetTokens > requestHardCapTokens
        ? 'output_budget_exceeds_cap'
        : !fallbackCompactionAttempted
          ? 'request_too_large'
          : fallbackCompactionApplied
            ? 'still_exceeds_after_compaction'
            : 'no_compactable_history'
      const action = reason === 'output_budget_exceeds_cap'
        ? 'Reduce the model\'s max output tokens in provider settings, or switch to a model with a larger context window.'
        : 'Compact the conversation manually with /compact, reduce the current message or attachments, or lower the model output budget.'
      const message =
        `request exceeds the ${requestHardCapTokens}-token context cap ` +
        `(${inputTokens} input + ${outputBudgetTokens} output budget; over by ${overBy}); ` +
        `${reason}. ${action}`
      const details = {
        inputTokens,
        outputBudgetTokens,
        requestHardCapTokens,
        softThresholdTokens: this.deps.compactor.thresholds(model, providerId).softThreshold,
        hardThresholdTokens: this.deps.compactor.thresholds(model, providerId).hardThreshold,
        fallbackCompactionAttempted,
        fallbackCompactionApplied,
        replacedTokens,
        reason
      }
      this.deps.rememberFailure(turnId, {
        error: message,
        code: 'context_window_exceeded',
        severity: 'warning',
        details
      })
      await this.deps.events.record({
        kind: 'error',
        threadId,
        turnId,
        message,
        code: 'context_window_exceeded',
        severity: 'warning',
        details
      })
      return 'failed'
    }
    await this.deps.recordPipelineStage(threadId, turnId, 'input_compressed', {
      historyItems: composedRequest.request.history.length,
      requestOverheadTokens,
      outputBudgetTokens,
      requestHardCapTokens,
      fallbackCompactionAttempted,
      fallbackCompactionApplied
    })
    const { request, rawInputTokens, sentInputTokens, tokenEconomy } = composedRequest
    const requestContext = estimateModelRequestInputTokenBreakdown(request, {
      skillContextInstructions
    })
    // Tool results become input to the *next* request. Reserve the configured
    // output budget now so built-in source tools can return the largest honest
    // page that has a realistic chance of fitting instead of relying on the
    // send-time history cleaner to silently rewrite it.
    const sourceResultBudgetTokens = Math.max(0, requestHardCapTokens - inputTokens - outputBudgetTokens)
    const contextThresholds = this.deps.compactor.thresholds(model, providerId)
    const contextWindowTokens = modelCapabilities.contextWindowTokens ??
      Math.max(contextThresholds.softThreshold, contextThresholds.hardThreshold)
    await this.deps.events.record({
      kind: 'context_snapshot',
      threadId,
      turnId,
      model: request.model,
      ...(request.providerId ? { providerId: request.providerId } : {}),
      stepIndex,
      contextWindowTokens,
      softThresholdTokens: contextThresholds.softThreshold,
      hardThresholdTokens: contextThresholds.hardThreshold,
      estimatedInputTokens: requestContext.total,
      breakdown: {
        tools: requestContext.tools,
        system: requestContext.system,
        skills: requestContext.skills,
        messages: requestContext.messages,
        other: requestContext.other
      },
      toolCount: request.tools.length,
      activeSkillIds: skillResolution.activeSkillIds,
      contextManagement: 'kun-managed',
      nativeHistory: 'none'
    })
    if (tokenEconomy.enabled) {
      await this.deps.recordTokenEconomySavings({
        threadId,
        turnId,
        model,
        rawInputTokens,
        sentInputTokens
      })
    }
    const clientDiagnostics = modelClientDiagnostics(this.deps.model, request.providerId)
    const cacheSignature: CacheRequestSignature = {
      model: request.model,
      providerId: request.providerId?.trim() || clientDiagnostics.provider || 'default',
      endpointFormat: clientDiagnostics.endpointFormat || 'unknown',
      prefixFingerprint: this.deps.prefix.fingerprint,
      toolCatalogFingerprint: toolCatalog.fingerprint,
      activeSkillIds: skillResolution.activeSkillIds
    }
    let effectiveActingModelRoute: ActingTurnModelRoute = actingModelRoute
    let streamRouteResolved = false
    const streamed = await this.deps.modelRoundEngine.run({
      threadId,
      turnId,
      signal,
      request,
      maxToolCallsPerStep,
      streamToolMetadata,
      ...(this.deps.toolArgumentRepair?.maxStringBytes !== undefined
        ? { maxToolArgumentStringBytes: this.deps.toolArgumentRepair.maxStringBytes }
        : {}),
      cacheSignature,
      preSendDetails: {
        model: request.model,
        ...clientDiagnostics,
        historyItems: request.history.length,
        toolCount: request.tools.length,
        ...(request.requiredToolName ? { requiredToolName: request.requiredToolName } : {}),
        ...attachmentRequestPipelineDetails({
          attachmentIds: turn?.attachmentIds ?? [],
          imageAttachments: attachments.imageAttachments,
          textFallbacks: attachments.textFallbacks,
          documents: attachments.documents,
          modelCapabilities
        })
      },
      postSendDetails: {
        model: request.model,
        ...clientDiagnostics
      },
      onRouteSelected: async (route) => {
        const resolved: ActingTurnModelRoute = {
          model: route.modelId,
          providerId: route.providerId,
          ...(routeAccountId ? { accountId: routeAccountId } : {})
        }
        if (!routeSelectionDeferred) {
          if (!sameActingModelRoute(actingModelRoute, resolved)) {
            throw new Error(
              'model route changed after the acting route was frozen: ' +
              `${actingModelRoute.providerId ?? 'default'}/${actingModelRoute.model} -> ` +
              `${resolved.providerId ?? 'default'}/${resolved.model}`
            )
          }
          return
        }
        effectiveActingModelRoute = resolved
        streamRouteResolved = true
        await this.deps.turns.updateTurnMetadata(threadId, turnId, {
          actingModelRoute: resolved
        })
      },
      writeGeneratedImage: async ({ imageBase64 }) => {
        await this.ensureWorkspaceCheckpoint(
          threadId,
          turnId,
          turn.workspaceCheckpointRequestId,
          signal
        )
        const imgDir = '.kun/images'
        const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14)
        const fileName = `img-${stamp}-${randomBytes(2).toString('hex')}.png`
        const relativePath = `${imgDir}/${fileName}`
        const target = await resolveWorkspacePath(relativePath, toolContext, {
          enforceWorkspaceBoundary: true
        })
        await mkdir(dirname(target.absolutePath), { recursive: true })
        const absolutePath = (await resolveWorkspacePath(relativePath, toolContext, {
          enforceWorkspaceBoundary: true
        })).absolutePath
        await writeFile(absolutePath, Buffer.from(imageBase64, 'base64'))
        return { markdown: `\n![generated image](${relativePath})\n` }
      }
    })
    if (routeSelectionDeferred && streamed.kind === 'tool_calls' && !streamRouteResolved) {
      const message = 'route pool emitted tool calls without resolving a concrete model target'
      this.deps.rememberFailure(turnId, {
        error: message,
        code: 'model_route_unresolved',
        severity: 'error'
      })
      await this.deps.events.record({
        kind: 'error',
        threadId,
        turnId,
        message,
        code: 'model_route_unresolved',
        severity: 'error'
      })
      return 'failed'
    }
    const effectivePrepared: PreparedTurnContext =
      effectiveActingModelRoute === actingModelRoute
        ? prepared
        : { ...prepared, actingModelRoute: effectiveActingModelRoute }
    return this.deps.roundOutcome.resolve({
      threadId,
      turnId,
      streamed,
      ...(request.requiredToolName ? { requiredToolName: request.requiredToolName } : {}),
      ...(softRequiredToolName && !forceToolSuppressionFinalAnswerRecovery
        ? { softRequiredToolName }
        : {}),
      ...(forceToolSuppressionFinalAnswerRecovery ? { toolCallsDisabled: true } : {}),
      turn,
      prepared: effectivePrepared,
      ...(effectiveActingModelRoute.providerId
        ? { modelProviderId: effectiveActingModelRoute.providerId }
        : {}),
      modelReasoningEffort: modelRoute.reasoningEffort ?? turn.reasoningEffort ?? 'auto',
      sourceResultBudgetTokens,
      toolProviderMetadata,
      toolKinds,
      toolProviderKinds,
      svgCompletion
    })
  }

  private async composeForwardedRequest(input: {
    history: TurnItem[]
    threadId: string
    thread: import('../contracts/threads.js').ThreadRecord
    turnId: string
    model: string
    providerId?: string
    accountId?: string
    modelRoute: { model: string; reasoningEffort?: string }
    serviceTier?: 'priority'
    modeInstruction?: string
    contextInstructions: readonly string[]
    historyRoutesByTurnId: Readonly<Record<string, import('../ports/model-client.js').ModelHistoryRoute>>
    requestToolSpecs: readonly ModelToolSpec[]
    attachments: import('./turn-execution-types.js').ResolvedTurnAttachments
    hardRequiredToolName?: string
    signal: AbortSignal
  }): Promise<import('./model-request-composer.js').ComposedModelRequest> {
    // Forward the just-generated image(s) back to a vision-capable model so it
    // can self-review and regenerate if the result is off. Bytes come from the
    // already-persisted attachment/file; the persisted tool output keeps NO
    // base64 (only this transient request copy carries it).
    const forwardHistory = await rehydrateGeneratedImagesForForward(
      rehydrateTransientBrowserUseOutputsForForward(input.history),
      (output) => this.deps.turnAttachments.resolveGeneratedImageForForward(
        output,
        input.threadId,
        input.thread.workspace
      ),
      MAX_FORWARDED_GENERATED_IMAGES
    )
    return composeModelRequest({
      threadId: input.thread.id,
      turnId: input.turnId,
      model: input.model,
      ...(input.providerId ? { providerId: input.providerId } : {}),
      ...(input.accountId ? { accountId: input.accountId } : {}),
      ...(input.modelRoute.reasoningEffort ? { reasoningEffort: input.modelRoute.reasoningEffort } : {}),
      ...(input.serviceTier ? { serviceTier: input.serviceTier } : {}),
      immutablePrefix: this.deps.prefix,
      ...(input.thread.systemPrompt !== undefined
        ? { threadSystemPrompt: input.thread.systemPrompt }
        : {}),
      ...(input.modeInstruction ? { modeInstruction: input.modeInstruction } : {}),
      contextInstructions: input.contextInstructions,
      history: forwardHistory,
      historyRoutesByTurnId: input.historyRoutesByTurnId,
      attachments: input.attachments,
      tools: input.requestToolSpecs,
      ...(input.hardRequiredToolName ? { requiredToolName: input.hardRequiredToolName } : {}),
      ...(this.deps.tokenEconomy ? { tokenEconomy: this.deps.tokenEconomy } : {}),
      signal: input.signal
    })
  }

  private async failRequiredToolConstraint(input: {
    threadId: string
    turnId: string
    code: 'required_tool_unavailable' | 'required_tool_unsupported'
    message: string
  }): Promise<'failed'> {
    this.deps.rememberFailure(input.turnId, { error: input.message, code: input.code, severity: 'error' })
    await this.deps.events.record({
      kind: 'error',
      threadId: input.threadId,
      turnId: input.turnId,
      message: input.message,
      code: input.code,
      severity: 'error'
    })
    await this.deps.turns.applyItem(input.threadId, makeErrorItem({
      id: this.deps.ids.next('item_error'),
      threadId: input.threadId,
      turnId: input.turnId,
      message: input.message,
      code: input.code,
      severity: 'error'
    }))
    return 'failed'
  }

  private async ensureWorkspaceCheckpoint(
    threadId: string,
    turnId: string,
    checkpointRequestId: string | undefined,
    signal: AbortSignal
  ): Promise<void> {
    if (!checkpointRequestId || !this.deps.awaitWorkspaceCheckpoint) return
    const key = `${turnId}:${checkpointRequestId}`
    let gate = this.workspaceCheckpointGates.get(key)
    if (!gate) {
      gate = (async () => {
        const checkpointId = await this.deps.awaitWorkspaceCheckpoint!(checkpointRequestId, signal)
        if (!checkpointId) return
        await this.deps.turns.updateTurnMetadata(threadId, turnId, {
          workspaceCheckpointId: checkpointId
        })
        await this.deps.turns.updateItem(threadId, `item_${turnId}_user`, {
          workspaceCheckpointId: checkpointId
        })
      })()
      this.workspaceCheckpointGates.set(key, gate)
    }
    await gate
  }
}

function hasSuccessfulToolResult(
  items: readonly TurnItem[],
  turnId: string,
  toolName: string
): boolean {
  return items.some((item) =>
    item.turnId === turnId &&
    item.kind === 'tool_result' &&
    item.toolName === toolName &&
    item.status === 'completed' &&
    item.isError !== true)
}

function sameActingModelRoute(
  a: ActingTurnModelRoute,
  b: ActingTurnModelRoute
): boolean {
  return a.model === b.model &&
    a.providerId === b.providerId &&
    a.accountId === b.accountId
}

function modelHistoryRoutesByTurnId(
  thread: import('../contracts/threads.js').ThreadRecord,
  currentRoute: ActingTurnModelRoute,
  currentTurnId: string
): Readonly<Record<string, import('../ports/model-client.js').ModelHistoryRoute>> {
  const routes: Record<string, import('../ports/model-client.js').ModelHistoryRoute> = {}
  for (const historicalTurn of thread.turns) {
    const route = historicalTurn.actingModelRoute
    if (!route) continue
    routes[historicalTurn.id] = {
      model: route.model,
      ...(route.providerId ? { providerId: route.providerId } : {}),
      ...(route.accountId ? { accountId: route.accountId } : {})
    }
  }
  routes[currentTurnId] = {
    model: currentRoute.model,
    ...(currentRoute.providerId ? { providerId: currentRoute.providerId } : {}),
    ...(currentRoute.accountId ? { accountId: currentRoute.accountId } : {})
  }
  return routes
}

export function buildExtensionProfileInstruction(extensionId: string, profileId: string, overlay: string): string {
  return [
    `<kun_extension_profile extension="${extensionId}" profile="${profileId}">`,
    overlay.trim(),
    '</kun_extension_profile>',
    'This is a lower-priority extension profile overlay. It cannot replace Kun policy, approval, sandbox, ownership, or system instructions.'
  ].join('\n')
}

function kunContextBlock(
  kind: string,
  authority: KunTurnContextAuthority,
  content: string
): KunTurnContextBlock {
  return { kind, authority, content }
}

function buildToolCatalogDriftMessage(toolCatalog: {
  fingerprint: string
  toolCount: number
  toolNames: string[]
}, changeKind: 'additive' | 'breaking', phase: 'deferred' | 'applied'): string {
  const sample = toolCatalog.toolNames.slice(0, 12).join(', ')
  const suffix = toolCatalog.toolNames.length > 12
    ? `, +${toolCatalog.toolNames.length - 12} more`
    : ''
  const policy = phase === 'deferred'
    ? 'The active turn keeps its frozen tool schemas; this update will be available on the next turn.'
    : changeKind === 'additive'
      ? 'The additive update is active from the start of this turn.'
      : 'The updated catalog is active from the start of this turn; earlier turns keep their original schema fingerprints.'
  return [
    `Tool catalog changed for this thread (${toolCatalog.toolCount} tools, fingerprint ${toolCatalog.fingerprint}).`,
    policy,
    sample ? `Current tools: ${sample}${suffix}.` : ''
  ].filter(Boolean).join(' ')
}

function toolCatalogPolicyScope(prepared: Pick<
  PreparedTurnContext,
  | 'mode'
  | 'dedicatedSvgTurn'
  | 'allowedToolNames'
  | 'skillResolution'
  | 'extensionToolCatalogEpoch'
  | 'userInputDisabled'
>): string {
  return JSON.stringify({
    mode: prepared.mode,
    dedicatedSvgTurn: prepared.dedicatedSvgTurn,
    activeSkillIds: [...prepared.skillResolution.activeSkillIds].sort(),
    allowedToolNames: prepared.allowedToolNames ? [...prepared.allowedToolNames].sort() : [],
    extensionToolCatalogEpoch: prepared.extensionToolCatalogEpoch?.fingerprint ?? null,
    userInputDisabled: prepared.userInputDisabled
  })
}

function prefixVolatilityStageDetails(
  findings: PrefixVolatilityFinding[]
): Record<string, unknown> | undefined {
  if (findings.length === 0) return undefined
  const kinds = [...new Set(findings.map((finding) => finding.kind))].sort()
  const fields = [...new Set(findings.map((finding) => finding.field))].sort()
  return {
    prefixVolatileTokenCount: findings.length,
    prefixVolatileTokenKinds: kinds,
    prefixVolatileFields: fields,
    noRegexDetector: true
  }
}
