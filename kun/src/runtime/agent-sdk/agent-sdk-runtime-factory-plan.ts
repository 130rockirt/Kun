/**
 * Binds the decoupled {@link AgentSdkRuntime} to kun's real runtime services.
 * This is the only place that touches the SDK package and kun's concrete stores,
 * keeping the orchestration (and its tests) free of both.
 */
import {
  AgentSdkCredentialUnavailableError,
  AgentSdkRuntime,
  agentSdkCapabilities,
  type SdkRuntimeDeps,
  type SdkTurnContext
} from './agent-sdk-runtime.js'
import type { SdkStreamResourceLimits } from './sdk-event-mapper.js'
import {
  normalizeClaudeOAuthToken,
  resolveSdkModel,
  type ToolApprovalDecision
} from './sdk-options-builder.js'
import {
  selectBridgeableTools,
  type BridgeableTool,
  type KunToolResult
} from './sdk-tool-bridge.js'
import type { SdkApi } from './sdk-protocol.js'
import type { RuntimeEventRecorder } from '../../services/runtime-event-recorder.js'
import type { LlmDebugSink } from '../../services/llm-debug-recorder.js'
import type { TurnService } from '../../services/turn-service.js'
import type { TurnRunOutcome } from '../../loop/turn-execution-types.js'
import type { SessionStore } from '../../ports/session-store.js'
import type { ThreadStore } from '../../ports/thread-store.js'
import type { CapabilityRegistry } from '../../adapters/tool/capability-registry.js'
import type { ToolHost, ToolHostContext } from '../../ports/tool-host.js'
import {
  DEFAULT_APPROVAL_REVIEWER,
  DEFAULT_SANDBOX_MODE,
  type ApprovalPolicy,
  type ApprovalReviewer,
  type SandboxMode
} from '../../contracts/policy.js'
import type { ServeProviderConfig } from '../../config/kun-config.js'
import type { AttachmentStore } from '../../attachments/attachment-store.js'
import type { SkillRuntime } from '../../skills/skill-runtime.js'
import type { InstructionRuntime } from '../../instructions/instruction-runtime.js'
import type { MemoryStore } from '../../memory/memory-store.js'
import {
  PLAN_MODE_INSTRUCTION,
  todoContinuationInstruction,
  memoryInstructions,
  isStalePlanContext
} from '../../loop/agent-loop.js'
import {
  filterGoalContextsForGoalKey,
  goalContextKey
} from '../../loop/continuation-instructions.js'
import {
  DESIGN_MODE_INSTRUCTION,
  SVG_ARTIFACT_ALLOWED_TOOL_NAMES,
  SVG_ARTIFACT_MODE_INSTRUCTION
} from '../../loop/design-mode.js'
import type { GuiDesignArtifactContext, GuiPlanContext } from '../../ports/tool-host.js'
import type { ThreadRecord } from '../../contracts/threads.js'
import type {
  UserInputGate,
  UserInputRequest,
  UserInputResolution
} from '../../ports/user-input-gate.js'
import { goalContextTexts, type TurnItem } from '../../contracts/items.js'
import type { ApprovalGate } from '../../ports/approval-gate.js'
import {
  createApprovalActionEnvelope,
  createApprovalRequest,
  safeApprovalActionSummary,
  type ApprovalRequest,
  type ApprovalResolution
} from '../../domain/approval.js'
import type { ApprovalReviewPort } from '../../ports/approval-review.js'
import type { ActingTurnModelRoute } from '../../contracts/turns.js'
import { makeUserInputItem } from '../../domain/item.js'
import { awaitAbortableGate } from '../../services/interactive-gate.js'
import {
  buildHistoryTranscript,
  DEFAULT_SDK_HISTORY_TRANSCRIPT_MAX_BYTES
} from './sdk-context-assembler.js'
import { shellSpawnEnv } from '../../adapters/tool/builtin-tool-utils.js'
import type { TurnLimitsConfig } from '../../loop/turn-limits.js'
import { userMessageTextWithComposerContexts } from '../../domain/composer-context.js'
import { mkdir } from 'node:fs/promises'
import { resolveTurnClientSurface } from '../../loop/turn-context-resolver.js'
import { buildClientSurfaceInstruction } from '../../prompt/kun-prompt-context.js'
import {
  delegatedCapabilityFingerprint,
  delegatedCredentialIdentity,
  priorItemsForDelegatedTurn,
  type DelegatedSessionCoordinator,
  type DelegatedSessionPreparation
} from '../delegated-session-binding.js'
import {
  delegatedGraphCompletionCheck,
  delegatedGraphAllowedToolNames,
  delegatedGraphTurnPolicy,
  intersectDelegatedToolNames,
  parkDelegatedGraphTurnAfterRecovery
} from '../delegated-graph-turn-policy.js'

const CLAUDE_KUN_TOOL_INSTRUCTION = [
  'Kun-managed capabilities are available through the mcp__kun__ tools.',
  'Use these tools for Kun capabilities such as MCP, extensions, skills, memory, media, GUI input, and delegation.',
  'Their execution remains governed by Kun ToolHost approval and sandbox policy.'
].join(' ')

const SDK_ON_REQUEST_AUTO_ALLOWED_TOOLS = new Set([
  'Read',
  'Glob',
  'Grep',
  'TodoWrite'
])

export function resolveTurnPlanContext(
  thread: ThreadRecord,
  turnId: string
): { planMode: boolean; guiPlan?: GuiPlanContext } {
  const turn = thread.turns.find((entry) => entry.id === turnId)
  const candidate = turn?.guiPlan ? ({ ...turn.guiPlan, turnId } as GuiPlanContext) : undefined
  const guiPlan = candidate && !isStalePlanContext(candidate, thread.workspace) ? candidate : undefined
  const planMode = (turn?.mode ?? thread.mode) === 'plan' || Boolean(guiPlan)
  return { planMode, ...(guiPlan ? { guiPlan } : {}) }
}

/**
 * Await a user-input gate resolution, cancelling the pending request if the turn
 * aborts first. Mirrors the native loop's waitForUserInput abort handling.
 */
export function waitForGate(
  gate: UserInputGate,
  request: UserInputRequest,
  signal: AbortSignal,
  armedPending?: Promise<UserInputResolution>
): Promise<UserInputResolution> {
  const pending = armedPending ?? gate.request(request)
  if (signal.aborted) {
    gate.resolve(request.id, { status: 'cancelled' })
    return Promise.resolve({ status: 'cancelled' })
  }
  return awaitAbortableGate(
    pending,
    signal,
    () => { gate.resolve(request.id, { status: 'cancelled' }) },
    'cancelled while awaiting user input'
  )
}
