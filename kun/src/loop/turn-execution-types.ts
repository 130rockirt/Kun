import type { ModelCapabilityMetadata } from '../contracts/capabilities.js'
import type { RuntimeErrorSeverity } from '../contracts/errors.js'
import type { TurnItem } from '../contracts/items.js'
import type { MemoryRecord } from '../contracts/memory.js'
import type {
  ModelDocumentAttachment,
  ModelInputAttachment,
  ModelTextAttachmentFallback,
  ModelToolSpec
} from '../ports/model-client.js'
import type { InstructionTurnResolution } from '../instructions/instruction-runtime.js'
import type { SkillTurnResolution } from '../skills/skill-runtime.js'
import type {
  GuiDesignArtifactContext,
  GuiPlanContext,
  ToolCallLike,
  ToolHost,
  ToolHostContext,
  ToolProviderKind
} from '../ports/tool-host.js'
import type { TurnClientSurface } from '../contracts/turns.js'

/** Terminal status exposed by the public AgentLoop turn boundary. */
export type TurnExecutionStatus = 'completed' | 'failed' | 'aborted'

/** One process-local execution slice may park while its durable turn remains active. */
export type TurnRunOutcome = TurnExecutionStatus | 'suspended'

/** Failure metadata retained until the lifecycle facade finalizes a turn. */
export type TurnExecutionFailure = {
  error: string
  code?: string
  details?: unknown
  severity?: RuntimeErrorSeverity
}

/** Outcome returned by one native model round to the loop orchestrator. */
export type ModelRoundOutcome = 'continue' | 'stop' | 'failed' | 'aborted'

/** Outcome returned after the ordered tool-dispatch stage. */
export type ToolDispatchOutcome = 'continue' | 'aborted' | 'all_suppressed' | 'budget_exhausted'

export type ResolvedTurnAttachments = Readonly<{
  imageAttachments: readonly ModelInputAttachment[]
  textFallbacks: readonly ModelTextAttachmentFallback[]
  documents: readonly ModelDocumentAttachment[]
}>

export type DiscoveredTool = Awaited<ReturnType<ToolHost['listTools']>>[number]

/**
 * Immutable per-model-step snapshot. Dynamic history and approved tool
 * results are deliberately represented by a fresh snapshot on the next step,
 * rather than mutating this record after a request begins.
 */
export type PreparedTurnContext = Readonly<{
  threadId: string
  turnId: string
  workspace: string
  orchestration: 'direct' | 'graph'
  messageSource?: 'background_shell' | 'background_subagent' | 'graph_runtime'
  additionalWorkspaces?: readonly string[]
  clientSurface: TurnClientSurface
  model: string
  mode: 'agent' | 'plan'
  dedicatedSvgTurn: boolean
  planContextStale: boolean
  activePlanContext?: GuiPlanContext
  approvalPolicy: ToolHostContext['approvalPolicy']
  sandboxMode: NonNullable<ToolHostContext['sandboxMode']>
  signal: AbortSignal
  history: readonly TurnItem[]
  modelCapabilities: ModelCapabilityMetadata
  attachments: ResolvedTurnAttachments
  skillResolution: SkillTurnResolution
  instructionResolution: InstructionTurnResolution
  memories: readonly MemoryRecord[]
  activeGoalInstruction: string | null
  goalRecoveryInstruction: string | null
  activeTodoInstruction: string | null
  planTurnActive: boolean
  allowedToolNames?: readonly string[]
  extensionToolCatalogEpoch?: ToolHostContext['extensionToolCatalogEpoch']
  userInputDisabled: boolean
  toolDiscoveryContext: ToolHostContext
  tools: readonly DiscoveredTool[]
}>

/**
 * Stable inputs shared by tool discovery and tool execution. Discovery keeps
 * approval inert; the execution factory is the only boundary that may await a
 * real approval or persist interactive state.
 */
export type ToolTurnContextInput = {
  threadId: string
  turnId: string
  workspace: string
  workspaceCheckpointRequestId?: string
  orchestration?: 'direct' | 'graph'
  messageSource?: 'background_shell' | 'background_subagent' | 'graph_runtime'
  additionalWorkspaces?: readonly string[]
  clientSurface: TurnClientSurface
  threadMode?: 'agent' | 'plan'
  activePlanContext?: GuiPlanContext
  guiDesignCanvas?: boolean
  guiDesignMode?: boolean
  agentSurface?: 'code' | 'write' | 'design'
  guiDesignArtifact?: GuiDesignArtifactContext
  modelProviderId?: string
  reasoningEffort?: string
  modelCapabilities: ModelCapabilityMetadata
  activeSkillIds: readonly string[]
  allowedToolNames?: readonly string[]
  extensionToolCatalogEpoch?: ToolHostContext['extensionToolCatalogEpoch']
  userInputDisabled?: boolean
  imContext?: boolean
  approvalPolicy: ToolHostContext['approvalPolicy']
  sandboxMode: NonNullable<ToolHostContext['sandboxMode']>
  signal: AbortSignal
}

/** Internal boundary between the model round and ordered tool execution. */
export type ToolDispatchInput = ToolTurnContextInput & {
  calls: ToolCallLike[]
  toolProviderKinds: ReadonlyMap<string, ToolProviderKind | undefined>
  /** Aggregate model-visible allowance for source results in this dispatch. */
  sourceResultBudgetTokens?: number
}
