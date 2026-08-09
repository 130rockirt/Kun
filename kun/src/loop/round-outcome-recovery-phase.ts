import { makeErrorItem } from '../domain/item.js'
import type { ToolCallLike } from '../ports/tool-host.js'
import { CREATE_PLAN_TOOL_NAME } from '../adapters/tool/create-plan-tool.js'
import { GRAPH_DEFINE_PLAN_TOOL_NAME } from '../adapters/tool/graph-define-plan-tool.js'
import {
  DESIGN_SVG_ANIMATE_TOOL_NAME,
  DESIGN_SVG_EDIT_TOOL_NAME,
  DESIGN_SVG_VALIDATE_TOOL_NAME
} from '../adapters/tool/design-svg-tool.js'
import {
  EMPTY_POST_TOOL_MAX_RECOVERY_STEPS,
  GOAL_NO_TOOL_REPEAT_MAX_RECOVERY_STEPS,
  POST_TOOL_FAILURE_MAX_RECOVERY_STEPS,
  TOOL_SUPPRESSION_FINAL_ANSWER_RECOVERY_STEP,
  isRepeatedNoToolAssistantText
} from './continuation-instructions.js'
import type { SvgArtifactCompletionState } from './svg-artifact-completion.js'
import type {
  ModelRoundOutcome,
  ToolDispatchInput
} from './turn-execution-types.js'
import { RoundOutcomeRequiredToolPhase } from './round-outcome-required-tool-phase.js'
import {
  GRAPH_CREATE_RUN_TOOL_NAME,
  MAX_SVG_COMPLETION_RECOVERY_STEPS,
  type RoundOutcomeInput
} from './round-outcome-state.js'

const POST_TOOL_FAILURE_EXCLUDED_TOOL_NAMES = new Set([
  CREATE_PLAN_TOOL_NAME,
  GRAPH_DEFINE_PLAN_TOOL_NAME,
  GRAPH_CREATE_RUN_TOOL_NAME,
  DESIGN_SVG_ANIMATE_TOOL_NAME,
  DESIGN_SVG_EDIT_TOOL_NAME,
  DESIGN_SVG_VALIDATE_TOOL_NAME
])

export abstract class RoundOutcomeRecoveryPhase extends RoundOutcomeRequiredToolPhase {
  protected async resolveEmptyPostToolResponse(input: RoundOutcomeInput): Promise<ModelRoundOutcome> {
    const recoverySteps = (this.emptyPostToolRecoveryStepsByTurn.get(input.turnId) ?? 0) + 1
    if (recoverySteps <= EMPTY_POST_TOOL_MAX_RECOVERY_STEPS) {
      this.emptyPostToolRecoveryStepsByTurn.set(input.turnId, recoverySteps)
      return 'continue'
    }

    const message =
      'Model stopped without a final answer after tool execution, including after continuation and final-answer recovery attempts.'
    this.deps.rememberFailure(input.turnId, {
      error: message,
      code: 'empty_post_tool_continuation',
      severity: 'error'
    })
    await this.deps.events.record({
      kind: 'error',
      threadId: input.threadId,
      turnId: input.turnId,
      message,
      code: 'empty_post_tool_continuation',
      severity: 'error'
    })
    await this.deps.turns.applyItem(
      input.threadId,
      makeErrorItem({
        id: this.deps.ids.next('item_error'),
        turnId: input.turnId,
        threadId: input.threadId,
        message,
        code: 'empty_post_tool_continuation',
        severity: 'error'
      })
    )
    return 'failed'
  }

  /**
   * Whether this turn already contains a failed ordinary tool result that is
   * not owned by a dedicated completion gate. The history snapshot is the
   * same model-visible projection the next request would see, so the check
   * stays aligned with what the model itself observes.
   */
  protected hasFailedOrdinaryToolResult(input: RoundOutcomeInput): boolean {
    return input.prepared.history.some(
      (item) =>
        item.turnId === input.turnId &&
        item.kind === 'tool_result' &&
        item.isError === true &&
        !POST_TOOL_FAILURE_EXCLUDED_TOOL_NAMES.has(item.toolName)
    )
  }

  /**
   * Bounded continuation when the model stops with a progress announcement
   * after an ordinary tool failure. The first recovery keeps tools so the
   * model can act; once the recovery budget is exhausted the turn fails
   * visibly instead of silently presenting the announcement as completion.
   */
  protected async advancePostToolFailureRecovery(
    input: RoundOutcomeInput
  ): Promise<ModelRoundOutcome> {
    const recoverySteps = (this.postToolFailureRecoveryStepsByTurn.get(input.turnId) ?? 0) + 1
    if (recoverySteps <= POST_TOOL_FAILURE_MAX_RECOVERY_STEPS) {
      this.postToolFailureRecoveryStepsByTurn.set(input.turnId, recoverySteps)
      await this.deps.events.record({
        kind: 'error',
        threadId: input.threadId,
        turnId: input.turnId,
        message:
          'Model stopped with a progress announcement after a tool failure; requesting continuation.',
        code: 'post_tool_failure_continuation',
        severity: 'warning'
      })
      return 'continue'
    }
    this.postToolFailureRecoveryStepsByTurn.delete(input.turnId)
    const message =
      'Model kept ending with progress announcements after a tool failure instead of continuing the task or providing a final answer.'
    this.deps.rememberFailure(input.turnId, {
      error: message,
      code: 'post_tool_failure_recovery_exhausted',
      severity: 'error'
    })
    await this.deps.events.record({
      kind: 'error',
      threadId: input.threadId,
      turnId: input.turnId,
      message,
      code: 'post_tool_failure_recovery_exhausted',
      severity: 'error'
    })
    await this.deps.turns.applyItem(
      input.threadId,
      makeErrorItem({
        id: this.deps.ids.next('item_error'),
        turnId: input.turnId,
        threadId: input.threadId,
        message,
        code: 'post_tool_failure_recovery_exhausted',
        severity: 'error'
      })
    )
    return 'failed'
  }

  protected async advanceToolSuppressionRecovery(
    input: RoundOutcomeInput
  ): Promise<ModelRoundOutcome> {
    const current = this.toolSuppressionRecoverySteps(input.turnId)
    if (current >= TOOL_SUPPRESSION_FINAL_ANSWER_RECOVERY_STEP) {
      return this.failToolSuppressionRecovery(input.threadId, input.turnId)
    }
    this.toolSuppressionRecoveryStepsByTurn.set(input.turnId, current + 1)
    return 'continue'
  }

  protected async resolveEmptyToolSuppressionRecovery(
    input: RoundOutcomeInput
  ): Promise<ModelRoundOutcome> {
    const current = this.toolSuppressionRecoverySteps(input.turnId)
    if (current < TOOL_SUPPRESSION_FINAL_ANSWER_RECOVERY_STEP) {
      this.toolSuppressionRecoveryStepsByTurn.set(
        input.turnId,
        TOOL_SUPPRESSION_FINAL_ANSWER_RECOVERY_STEP
      )
      return 'continue'
    }
    return this.failToolSuppressionRecovery(input.threadId, input.turnId)
  }

  async failToolSuppressionRecovery(threadId: string, turnId: string): Promise<'failed'> {
    const message =
      'Turn stopped because repeated tool calls were suppressed and the model still did not produce a final answer.'
    this.toolSuppressionRecoveryStepsByTurn.delete(turnId)
    this.deps.suppressGoalResume(turnId)
    this.deps.rememberFailure(turnId, {
      error: message,
      code: 'tool_loop_suppressed',
      severity: 'error'
    })
    await this.deps.events.record({
      kind: 'error',
      threadId,
      turnId,
      message,
      code: 'tool_loop_suppressed',
      severity: 'error'
    })
    await this.deps.turns.applyItem(
      threadId,
      makeErrorItem({
        id: this.deps.ids.next('item_error'),
        turnId,
        threadId,
        message,
        code: 'tool_loop_suppressed',
        severity: 'error'
      })
    )
    return 'failed'
  }

  protected async resolveGoalNoToolResponse(
    input: RoundOutcomeInput,
    assistantText: string
  ): Promise<ModelRoundOutcome> {
    const previousText = this.lastNoToolTextByTurn.get(input.turnId)
    if (isRepeatedNoToolAssistantText(previousText, assistantText)) {
      const recoverySteps = (this.goalNoToolRecoveryStepsByTurn.get(input.turnId) ?? 0) + 1
      if (recoverySteps <= GOAL_NO_TOOL_REPEAT_MAX_RECOVERY_STEPS) {
        this.goalNoToolRecoveryStepsByTurn.set(input.turnId, recoverySteps)
        this.lastNoToolTextByTurn.set(input.turnId, assistantText)
        return 'continue'
      }
      const message =
        'Goal continuation stopped: the model kept repeating near-identical replies without calling tools or updating the goal.'
      await this.deps.turns.applyItem(
        input.threadId,
        makeErrorItem({
          id: this.deps.ids.next('item_error'),
          turnId: input.turnId,
          threadId: input.threadId,
          message,
          code: 'goal_repetition_stop',
          severity: 'warning'
        })
      )
      await this.deps.events.record({
        kind: 'error',
        threadId: input.threadId,
        turnId: input.turnId,
        message,
        code: 'goal_repetition_stop',
        severity: 'warning'
      })
      this.lastNoToolTextByTurn.delete(input.turnId)
      this.goalNoToolRecoveryStepsByTurn.delete(input.turnId)
      if (!this.deps.hasTurnMadeProgress(input.turnId)) {
        this.deps.suppressGoalResume(input.turnId)
      }
      return 'stop'
    }
    this.goalNoToolRecoveryStepsByTurn.delete(input.turnId)
    this.lastNoToolTextByTurn.set(input.turnId, assistantText)
    return 'continue'
  }

  protected async recordOutputTruncated(input: RoundOutcomeInput): Promise<void> {
    const message =
      'The model reached its maximum output length and the response was truncated. ' +
      'Raise the model’s max output tokens, or ask it to continue or split the work into smaller steps.'
    await this.deps.events.record({
      kind: 'error',
      threadId: input.threadId,
      turnId: input.turnId,
      message,
      code: 'output_truncated',
      severity: 'warning'
    })
    await this.deps.turns.applyItem(
      input.threadId,
      makeErrorItem({
        id: this.deps.ids.next('item_error'),
        turnId: input.turnId,
        threadId: input.threadId,
        message,
        code: 'output_truncated',
        severity: 'warning'
      })
    )
  }

  protected async recoverRequiredSvgCompletion(
    input: RoundOutcomeInput,
    state: SvgArtifactCompletionState
  ): Promise<ModelRoundOutcome> {
    const attempt = (this.svgCompletionRecoveryStepsByTurn.get(input.turnId) ?? 0) + 1
    this.svgCompletionRecoveryStepsByTurn.set(input.turnId, attempt)
    const exhausted = attempt >= MAX_SVG_COMPLETION_RECOVERY_STEPS
    const missingCode = state.mutationSucceeded
      ? 'required_svg_validation_missing'
      : 'required_svg_mutation_missing'
    const message = state.mutationSucceeded
      ? `The dedicated SVG artifact turn cannot finish until \`${DESIGN_SVG_VALIDATE_TOOL_NAME}\` succeeds after the last mutation.`
      : [
          'The dedicated SVG artifact turn cannot finish before a structured mutation succeeds.',
          `Call \`${DESIGN_SVG_EDIT_TOOL_NAME}\` or \`${DESIGN_SVG_ANIMATE_TOOL_NAME}\`, then finish with \`${DESIGN_SVG_VALIDATE_TOOL_NAME}\`.`
        ].join(' ')
    const finalMessage = exhausted ? `${message} Recovery attempts exhausted.` : message
    const code = exhausted ? 'svg_completion_gate_exhausted' : missingCode
    const severity = exhausted ? 'error' as const : 'warning' as const
    if (exhausted) {
      this.deps.rememberFailure(input.turnId, { error: finalMessage, code, severity })
    }
    await this.deps.events.record({
      kind: 'error',
      threadId: input.threadId,
      turnId: input.turnId,
      message: finalMessage,
      code,
      severity
    })
    await this.deps.turns.applyItem(
      input.threadId,
      makeErrorItem({
        id: this.deps.ids.next('item_error'),
        turnId: input.turnId,
        threadId: input.threadId,
        message: finalMessage,
        code,
        severity
      })
    )
    return exhausted ? 'failed' : 'continue'
  }

  protected toolDispatchInput(
    input: RoundOutcomeInput,
    calls: ToolCallLike[],
    includeInteractiveFlags: boolean
  ): ToolDispatchInput {
    const prepared = input.prepared
    const base: ToolDispatchInput = {
      calls,
      threadId: input.threadId,
      turnId: input.turnId,
      workspace: prepared.workspace,
      ...(input.turn.workspaceCheckpointRequestId
        ? { workspaceCheckpointRequestId: input.turn.workspaceCheckpointRequestId }
        : {}),
      orchestration: prepared.orchestration,
      messageSource: prepared.messageSource,
      additionalWorkspaces: prepared.additionalWorkspaces,
      clientSurface: prepared.clientSurface,
      threadMode: prepared.mode,
      activePlanContext: prepared.activePlanContext,
      guiDesignCanvas: input.turn.guiDesignCanvas === true,
      guiDesignMode: input.turn.guiDesignMode === true,
      agentSurface: input.turn.agentSurface ?? 'code',
      guiDesignArtifact: input.turn.guiDesignArtifact,
      modelProviderId: input.modelProviderId,
      actingModelRoute: prepared.actingModelRoute,
      approvalIntent: input.turn.prompt,
      reasoningEffort: input.modelReasoningEffort,
      serviceTier: input.turn.serviceTier === 'priority' ? 'priority' : undefined,
      modelCapabilities: prepared.modelCapabilities,
      ...(input.sourceResultBudgetTokens !== undefined
        ? { sourceResultBudgetTokens: input.sourceResultBudgetTokens }
        : {}),
      activeSkillIds: prepared.skillResolution.activeSkillIds,
      allowedToolNames: prepared.allowedToolNames,
      extensionToolCatalogEpoch: prepared.extensionToolCatalogEpoch,
      toolProviderKinds: input.toolProviderKinds,
      approvalPolicy: prepared.approvalPolicy,
      approvalReviewer: prepared.approvalReviewer,
      sandboxMode: prepared.sandboxMode,
      signal: prepared.signal
    }
    if (!includeInteractiveFlags) return base
    return {
      ...base,
      userInputDisabled: prepared.userInputDisabled,
      imContext: input.turn.imContext === true
    }
  }
}
