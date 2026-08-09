import type { AppLocale } from './app-locales'
import type { GuiUpdateChannel } from './gui-update'
import type { KeyboardShortcutsConfigV1 } from './keyboard-shortcuts'
import type { LocalWhisperDownloadSourceId } from './local-whisper'
import type {
  ApprovalPolicy,
  ApprovalReviewer,
  SandboxMode
} from '../../kun/src/contracts/policy.js'
import type { ComputerUseMode } from '../../kun/src/contracts/capabilities.js'
import type { BrowserUseMode } from './browser-use'
import type { ModelEndpointFormat } from '../../kun/src/contracts/model-endpoint-format.js'
import type { ToolOutputLimitsConfig } from '../../kun/src/contracts/tool-output-limits.js'

import {
  ScheduleRunMode
} from './app-settings-types-provider'
import {
  WorkflowAggregateConfigV1,
  WorkflowAiAgentConfigV1,
  WorkflowCodeConfigV1,
  WorkflowConditionConfigV1,
  WorkflowCustomConfigV1,
  WorkflowCustomModuleV1,
  WorkflowDelayConfigV1,
  WorkflowFilterConfigV1,
  WorkflowGenerateImageConfigV1,
  WorkflowHttpRequestConfigV1,
  WorkflowHumanApprovalConfigV1,
  WorkflowJsonConfigV1,
  WorkflowLimitConfigV1,
  WorkflowLoopConfigV1,
  WorkflowManualTriggerConfigV1,
  WorkflowMergeConfigV1,
  WorkflowNodeInputV1,
  WorkflowNodeKind,
  WorkflowNodeRunStatus,
  WorkflowOutputConfigV1,
  WorkflowParameterExtractorConfigV1,
  WorkflowQuestionClassifierConfigV1,
  WorkflowRunStatus,
  WorkflowScheduleTriggerConfigV1,
  WorkflowSetFieldsConfigV1,
  WorkflowSortConfigV1,
  WorkflowSubWorkflowConfigV1,
  WorkflowSwitchConfigV1,
  WorkflowTemplateConfigV1,
  WorkflowWebhookTriggerConfigV1
} from './app-settings-types-workflow-node'

export type WorkflowNodeConfigByKind = {
  'manual-trigger': WorkflowManualTriggerConfigV1
  'schedule-trigger': WorkflowScheduleTriggerConfigV1
  'webhook-trigger': WorkflowWebhookTriggerConfigV1
  'ai-agent': WorkflowAiAgentConfigV1
  'generate-image': WorkflowGenerateImageConfigV1
  condition: WorkflowConditionConfigV1
  switch: WorkflowSwitchConfigV1
  filter: WorkflowFilterConfigV1
  'set-fields': WorkflowSetFieldsConfigV1
  code: WorkflowCodeConfigV1
  sort: WorkflowSortConfigV1
  limit: WorkflowLimitConfigV1
  aggregate: WorkflowAggregateConfigV1
  'http-request': WorkflowHttpRequestConfigV1
  merge: WorkflowMergeConfigV1
  subworkflow: WorkflowSubWorkflowConfigV1
  loop: WorkflowLoopConfigV1
  delay: WorkflowDelayConfigV1
  template: WorkflowTemplateConfigV1
  json: WorkflowJsonConfigV1
  output: WorkflowOutputConfigV1
  'parameter-extractor': WorkflowParameterExtractorConfigV1
  'question-classifier': WorkflowQuestionClassifierConfigV1
  'human-approval': WorkflowHumanApprovalConfigV1
  custom: WorkflowCustomConfigV1
}

/** How a node behaves when its execution fails after retries. */
export type WorkflowNodeErrorMode = 'fail' | 'continue' | 'fallback'

/** Discriminated union over `type`, each kind carrying its own `config`. */
export type WorkflowNodeV1 = {
  [K in WorkflowNodeKind]: {
    id: string
    type: K
    /** Display label shown on the canvas. */
    name: string
    /** React Flow canvas coordinates. Opaque to the backend. */
    position: { x: number; y: number }
    disabled: boolean
    /** Error policy. Absent = 'fail' (the run stops) — preserves the original behavior. */
    onError?: WorkflowNodeErrorMode
    /** Retry attempts before applying onError (0 = no retry). */
    retries?: number
    retryDelayMs?: number
    /** For onError = 'fallback': JSON the node emits instead of failing. */
    fallbackJson?: string
    /** Named, typed inputs pulled from upstream output; resolved before the node runs as {{$input.key}}. */
    inputs?: WorkflowNodeInputV1[]
    config: WorkflowNodeConfigByKind[K]
  }
}[WorkflowNodeKind]

/** Flat edge array, binds directly to React Flow. Condition uses sourceHandle 'true' | 'false'. */
export type WorkflowConnectionV1 = {
  id: string
  source: string
  sourceHandle: string
  target: string
  targetHandle: string
}

export type WorkflowNodeRunResultV1 = {
  nodeId: string
  status: WorkflowNodeRunStatus
  startedAt: string
  finishedAt: string
  /** Assistant text / HTTP body / condition branch summary. */
  message: string
  /** JSON payload this node emitted, serialized. Empty when none. */
  outputJson: string
  /** JSON payload this node received, serialized. Empty when none. (For the run history viewer.) */
  inputJson?: string
  /** Retry attempts spent before this result (0/absent = first try). */
  retries?: number
  /** For ai-agent nodes: the Kun thread it created. */
  threadId: string
  error: string
}

/** Result of a single-node test run (not persisted to history). */
export type WorkflowNodeTestResult =
  | { ok: true; result: WorkflowNodeRunResultV1 }
  | { ok: false; message: string }

/** A human-approval node that has paused a run and is awaiting a decision. */
export type WorkflowPendingApprovalV1 = {
  token: string
  workflowId: string
  runId: string
  nodeId: string
  nodeName: string
  title: string
  instruction: string
  createdAt: string
}

export type WorkflowRunV1 = {
  id: string
  /** 'manual' | 'schedule' | trigger node id. */
  trigger: string
  status: WorkflowRunStatus
  startedAt: string
  finishedAt: string
  message: string
  nodeResults: WorkflowNodeRunResultV1[]
}

/** A workflow-scoped variable readable via {{$env.key}} in node expressions. */
export type WorkflowEnvVarV1 = {
  key: string
  value: string
  type: 'string' | 'number' | 'boolean' | 'secret'
}

export type WorkflowV1 = {
  id: string
  name: string
  enabled: boolean
  /** When true, the Kun agent may invoke this workflow as a tool (list_workflows / run_workflow). */
  callableByAgent: boolean
  /** Workflow-scoped variables, exposed to node expressions as {{$env.key}}. */
  env: WorkflowEnvVarV1[]
  nodes: WorkflowNodeV1[]
  connections: WorkflowConnectionV1[]
  createdAt: string
  updatedAt: string
  lastRunAt: string
  nextRunAt: string
  lastStatus: WorkflowRunStatus
  lastMessage: string
  /** Bounded history of recent runs (most recent last, capped). */
  runs: WorkflowRunV1[]
}

/**
 * A reusable palette item created by snapshotting a configured node. Dropping it
 * onto the canvas creates a fresh node of `nodeType` pre-filled with `config`.
 */
export type WorkflowNodePresetV1 = {
  id: string
  /** Palette label chosen by the user. */
  label: string
  /** Optional lucide icon name; empty falls back to the node kind's default icon. */
  icon: string
  /** Underlying built-in node kind this preset instantiates. */
  nodeType: WorkflowNodeKind
  /** Default name applied to the created node. */
  nodeName: string
  /** Saved config snapshot; shape matches `nodeType`. */
  config: WorkflowNodeV1['config']
}

/** The kun agent hook phases a workflow can be bound to. Mirrors kun's HOOK_PHASES. */
export const WORKFLOW_HOOK_PHASES = [
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
  'TurnStart',
  'TurnEnd',
  'PreCompact'
] as const

export type WorkflowHookPhase = (typeof WORKFLOW_HOOK_PHASES)[number]

/** How a bound workflow's output maps back to the hook result. */
export const WORKFLOW_HOOK_MODES = ['observe', 'block', 'rewrite'] as const

export type WorkflowHookMode = (typeof WORKFLOW_HOOK_MODES)[number]

/** Binds a Create Loop workflow to a kun agent hook phase (reactive automation). */
export type WorkflowHookTriggerV1 = {
  id: string
  enabled: boolean
  /** Workflow to run when the phase fires. */
  workflowId: string
  phase: WorkflowHookPhase
  /** Exact tool names to match (tool phases only); empty matches all tools. */
  toolNames: string[]
  /**
   * observe = run, change nothing; block = deny the action if the workflow fails/says DENY;
   * rewrite = fold the workflow output into the tool result / injected context.
   */
  mode: WorkflowHookMode
  /** Hook timeout in ms; 0 uses the kun default. */
  timeoutMs: number
}

export type WorkflowSettingsV1 = {
  enabled: boolean
  defaultWorkspaceRoot: string
  /** Default model provider for new AI nodes. Empty inherits the Kun runtime provider. */
  providerId?: string
  model: string
  mode: ScheduleRunMode
  keepAwake: boolean
  /** Local-only (127.0.0.1) port the webhook-trigger listener binds to. */
  webhookPort: number
  /** Optional shared secret required on inbound webhook requests (x-kun-secret / Bearer). */
  webhookSecret: string
  workflows: WorkflowV1[]
  /** Reusable palette items the user saved from configured nodes. */
  presets: WorkflowNodePresetV1[]
  /** User-defined script-backed modules. */
  modules: WorkflowCustomModuleV1[]
  /** Workflows bound to kun agent hook phases (reactive automation in code mode). */
  hookTriggers: WorkflowHookTriggerV1[]
}

export type WorkflowSettingsPatchV1 = Partial<Omit<WorkflowSettingsV1, 'workflows'>> & {
  /** Replaced wholesale when present. */
  workflows?: Array<Partial<WorkflowV1>>
}

export type WorkflowRunResult =
  | { ok: true; runId: string; status: WorkflowRunStatus; message: string }
  | { ok: false; message: string }

/** Result of an editor-time syntax check on a Code node's script. */
export type WorkflowCodeCheckResult =
  | { status: 'ok' }
  | { status: 'error'; message: string }
  | { status: 'unavailable'; message: string }

export type WorkflowNodeStatusMap = Record<string, WorkflowNodeRunStatus>

export type WorkflowRuntimeStatus = {
  runningWorkflowIds: string[]
  /** workflowId -> nodeId -> live status, for lighting up the canvas during a run. */
  nodeStatus: Record<string, WorkflowNodeStatusMap>
  /** workflowId -> nodeId -> live per-node result (input/output/timing), for the run-log panel. */
  nodeResults: Record<string, Record<string, WorkflowNodeRunResultV1>>
  powerSaveBlockerActive: boolean
  /** Human-approval nodes currently paused, awaiting an approve/reject decision. */
  pendingApprovals: WorkflowPendingApprovalV1[]
}
