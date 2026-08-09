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
  ScheduleKind,
  ScheduleReasoningEffort,
  ScheduleRunMode
} from './app-settings-types-provider'

// ---------------------------------------------------------------------------
// Workflow (n8n-style node-based automation)
//
// A workflow is the multi-step generalization of a scheduled task: instead of a
// single prompt it is a graph of nodes connected by edges. The "ai-agent" node
// reuses the exact same Kun-runtime execution path as a scheduled task.
// ---------------------------------------------------------------------------

export type WorkflowNodeKind =
  | 'manual-trigger'
  | 'schedule-trigger'
  | 'webhook-trigger'
  | 'ai-agent'
  | 'generate-image'
  | 'condition'
  | 'switch'
  | 'filter'
  | 'set-fields'
  | 'code'
  | 'sort'
  | 'limit'
  | 'aggregate'
  | 'http-request'
  | 'merge'
  | 'subworkflow'
  | 'loop'
  | 'delay'
  | 'template'
  | 'json'
  | 'output'
  | 'parameter-extractor'
  | 'question-classifier'
  | 'human-approval'
  | 'custom'

export const WORKFLOW_NODE_KINDS: readonly WorkflowNodeKind[] = [
  'manual-trigger',
  'schedule-trigger',
  'webhook-trigger',
  'ai-agent',
  'generate-image',
  'condition',
  'switch',
  'filter',
  'set-fields',
  'code',
  'sort',
  'limit',
  'aggregate',
  'http-request',
  'merge',
  'subworkflow',
  'loop',
  'delay',
  'template',
  'json',
  'output',
  'parameter-extractor',
  'question-classifier',
  'human-approval',
  'custom'
]

export type WorkflowRunStatus = 'idle' | 'running' | 'success' | 'error'

export type WorkflowNodeRunStatus = 'pending' | 'running' | 'success' | 'error' | 'skipped'

/** Schedule trigger extends the scheduled-task schedule kinds with cron. */
export type WorkflowTriggerScheduleKind = ScheduleKind | 'cron'

export type WorkflowScheduleV1 = {
  kind: WorkflowTriggerScheduleKind
  everyMinutes: number
  timeOfDay: string
  atTime: string
  /** Cron expression, used when kind === 'cron'. */
  cron: string
}

export type WorkflowConditionOperator =
  | 'contains'
  | 'notContains'
  | 'equals'
  | 'notEquals'
  | 'startsWith'
  | 'endsWith'
  | 'isEmpty'
  | 'isNotEmpty'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'

export type WorkflowHttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export const WORKFLOW_INPUT_FIELD_TYPES = ['text', 'paragraph', 'number', 'boolean', 'select', 'json'] as const

export type WorkflowInputFieldType = (typeof WORKFLOW_INPUT_FIELD_TYPES)[number]

/** Types offered for a node's typed inputs (subset of the field types — no select/paragraph). */
export const WORKFLOW_NODE_INPUT_TYPES = ['text', 'number', 'boolean', 'json'] as const

export type WorkflowNodeInputType = (typeof WORKFLOW_NODE_INPUT_TYPES)[number]

/**
 * A named, typed input a node pulls from an upstream node's output (dify-style).
 * `source` is an expression ({{$nodes.<id>.json.path}} / {{text}} / {{json.x}});
 * the resolved + coerced value is exposed to the node as {{$input.key}}.
 */
export type WorkflowNodeInputV1 = {
  key: string
  type: WorkflowNodeInputType
  source: string
}

/**
 * The value-type vocabulary the variable picker uses to badge a node's outputs.
 * A trimmed analogue of Dify's VarType — only what our nodes actually emit. NOT
 * persisted (never enters the settings schema); derived on the fly by
 * describeNodeOutput. `object` is drillable (has children); `json` is an opaque
 * blob the user dot-paths into manually; `any` is unknowable. Defer array[*]/file
 * until a node actually produces them.
 */
export const WORKFLOW_VAR_TYPES = ['string', 'number', 'boolean', 'object', 'json', 'any'] as const

export type WorkflowVarType = (typeof WORKFLOW_VAR_TYPES)[number]

/**
 * One advertised output field of a node, for the typed reference picker. `key` is
 * a dot-path relative to the node's json (or the literal 'text'). Derived metadata
 * only — see workflow-output-descriptors.ts. `children` cascades object types.
 */
export type WorkflowOutputVar = {
  key: string
  type: WorkflowVarType
  /** Present only for object types; lets the picker drill in. */
  children?: WorkflowOutputVar[]
  /** Optional human label for the picker row. */
  label?: string
}

/**
 * One typed input the caller supplies when starting a workflow. Drives the
 * "Run once" form, validates the /workflow/run + run_workflow input, and lifts
 * each value onto the run's initial payload.json by `key`.
 */
export type WorkflowInputFieldV1 = {
  key: string
  label: string
  type: WorkflowInputFieldType
  required: boolean
  /** Options for `select`. */
  options: string[]
  defaultValue: string
  description: string
}

/**
 * Triggers carry the run's working directory. When a workflow fires from this
 * trigger, `workspaceRoot` is the default cwd for AI / image / code nodes
 * (empty inherits settings.workflow.defaultWorkspaceRoot, then the app workspace).
 */
export type WorkflowManualTriggerConfigV1 = {
  workspaceRoot?: string
  /** Typed inputs the caller provides when starting the workflow. */
  inputSchema?: WorkflowInputFieldV1[]
}

export type WorkflowScheduleTriggerConfigV1 = {
  schedule: WorkflowScheduleV1
  workspaceRoot?: string
}

export type WorkflowWebhookMethod = 'ANY' | 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export type WorkflowWebhookTriggerConfigV1 = {
  /** Path (leading slash) the local webhook listener matches, e.g. "/my-hook". */
  path: string
  method: WorkflowWebhookMethod
  workspaceRoot?: string
}

export type WorkflowAiAgentConfigV1 = {
  prompt: string
  workspaceRoot: string
  providerId: string
  model: string
  reasoningEffort: ScheduleReasoningEffort
  mode: ScheduleRunMode
}

export type WorkflowGenerateImageConfigV1 = {
  /** Image prompt; supports {{json.x}} / {{text}} interpolation. */
  prompt: string
  /** Provider profile (with an image capability) to use; empty falls back to the Settings image provider. */
  providerId: string
  /** Image model name; empty uses the provider/Settings default. */
  model: string
  /** Optional size override (e.g. "1024x1024"); empty uses the provider default. */
  size: string
  /**
   * Folder to save the image into. Empty = <workspace>/workflow-images.
   * Relative paths resolve against the workspace; absolute paths are used as-is.
   * Supports {{json.x}} / {{text}} interpolation.
   */
  outputDir: string
}

export type WorkflowConditionConfigV1 = {
  /** Accessor into the incoming payload, e.g. "text" or "json.value". Empty = previous node's text. */
  leftExpr: string
  operator: WorkflowConditionOperator
  rightValue: string
  caseSensitive: boolean
}

/** One rule of a Switch node; matches feed the output handle `case-<index>`. */
export type WorkflowSwitchRuleV1 = {
  leftExpr: string
  operator: WorkflowConditionOperator
  rightValue: string
  caseSensitive: boolean
}

export type WorkflowSwitchConfigV1 = {
  rules: WorkflowSwitchRuleV1[]
  /** When true, expose a `fallback` output for inputs that match no rule. */
  fallback: boolean
}

/** Filter gate: passes the payload through only when the condition holds. */
export type WorkflowFilterConfigV1 = {
  leftExpr: string
  operator: WorkflowConditionOperator
  rightValue: string
  caseSensitive: boolean
}

export type WorkflowSortOrder = 'asc' | 'desc'

export type WorkflowSortConfigV1 = {
  /** Field path within each array item; empty sorts by the item itself. */
  field: string
  order: WorkflowSortOrder
  numeric: boolean
}

export type WorkflowLimitFrom = 'first' | 'last'

export type WorkflowLimitConfigV1 = {
  count: number
  from: WorkflowLimitFrom
}

export type WorkflowAggregateMode = 'count' | 'sum' | 'collect' | 'join'

export type WorkflowAggregateConfigV1 = {
  mode: WorkflowAggregateMode
  /** Field path within each array item (for sum/collect/join). */
  field: string
  /** Separator for 'join' mode. */
  separator: string
}

export type WorkflowMergeMode = 'array' | 'object'

export type WorkflowMergeConfigV1 = {
  /** 'array' collects upstream outputs into a list; 'object' shallow-merges object outputs. */
  mode: WorkflowMergeMode
}

export const WORKFLOW_CODE_LANGUAGES = ['javascript', 'python', 'bash'] as const

export type WorkflowCodeLanguage = (typeof WORKFLOW_CODE_LANGUAGES)[number]

export type WorkflowCodeConfigV1 = {
  /** Execution language. javascript runs sandboxed in-process; python/bash spawn a local interpreter. */
  language: WorkflowCodeLanguage
  /**
   * Script body.
   * - javascript: receives $json / $text and may `return` a value (sandboxed, short timeout).
   * - python / bash: input arrives on stdin as JSON and via $WORKFLOW_JSON / $WORKFLOW_TEXT;
   *   whatever the script prints to stdout becomes the output (parsed as JSON when possible).
   */
  code: string
}

export type WorkflowSubWorkflowConfigV1 = {
  /** id of another workflow to run; its output becomes this node's output. */
  workflowId: string
}

/** Renders the payload into a free-form text string (or JSON parsed from it). */
export type WorkflowTemplateConfigV1 = {
  /** Template with {{json.x}} / {{text}} interpolation. */
  template: string
  /** 'text' emits the rendered string; 'json' parses it as JSON (falls back to { text }). */
  outputMode: 'text' | 'json'
}

/** Converts between text and structured JSON. */
export type WorkflowJsonConfigV1 = {
  /** 'parse' turns the incoming text into JSON; 'stringify' serializes the incoming JSON to text. */
  mode: 'parse' | 'stringify'
  /** When parsing, throw on invalid JSON instead of falling back to { text }. */
  strict: boolean
}

/**
 * Terminal node that shapes the workflow's final output — what run_workflow,
 * the local /workflow/run endpoint, and the run viewer treat as the result.
 */
export type WorkflowOutputConfigV1 = {
  /** 'auto' passes the incoming payload through; 'text' renders a template; 'json' extracts a path. */
  mode: 'auto' | 'text' | 'json'
  /** Used in 'text' mode — supports {{json.x}} / {{text}}. */
  textTemplate: string
  /** Used in 'json' mode — dot path into the incoming json (empty = the whole json). */
  jsonPath: string
}

/** A node that runs a user-defined custom module, with the module's field values. */
export type WorkflowCustomConfigV1 = {
  /** id of the WorkflowCustomModuleV1 this node runs. */
  moduleId: string
  /** Field key -> value (stored as strings; coerced by the field's type at runtime). */
  values: Record<string, string>
}

/** dify-style Parameter Extractor: an LLM turns free text into typed JSON fields. */
export type WorkflowParameterExtractorConfigV1 = {
  /** Expression for the source text (default {{text}}). */
  source: string
  instruction: string
  /** Fields to extract (reuses the typed input-field schema). */
  fields: WorkflowInputFieldV1[]
  providerId: string
  model: string
  reasoningEffort: ScheduleReasoningEffort
}

export type WorkflowClassifierCategoryV1 = { id: string; label: string }

/** dify-style Question Classifier: an LLM routes the input to one of N categories. */
export type WorkflowQuestionClassifierConfigV1 = {
  /** Expression for the text to classify (default {{text}}). */
  source: string
  instruction: string
  categories: WorkflowClassifierCategoryV1[]
  providerId: string
  model: string
  reasoningEffort: ScheduleReasoningEffort
}

export type WorkflowApprovalDecision = 'approved' | 'rejected'

/** Human-in-the-loop pause: the run waits for an approve/reject decision before continuing. */
export type WorkflowHumanApprovalConfigV1 = {
  title: string
  instruction: string
  /** Auto-resolve after this many ms; 0 = wait indefinitely. */
  timeoutMs: number
  onTimeout: WorkflowApprovalDecision
}

export const WORKFLOW_MODULE_FIELD_TYPES = ['text', 'textarea', 'number', 'boolean', 'select'] as const

export type WorkflowModuleFieldType = (typeof WORKFLOW_MODULE_FIELD_TYPES)[number]

/** One input on a custom module's auto-generated form. */
export type WorkflowModuleFieldV1 = {
  /** Identifier exposed to the script as $fields.<key> / WORKFLOW_FIELDS[<key>]. */
  key: string
  label: string
  type: WorkflowModuleFieldType
  /** Default value (string form); number/boolean are coerced from this. */
  defaultValue: string
  /** Options for `select` fields. */
  options: string[]
  placeholder: string
}

/**
 * A reusable, user-defined module = a script (JS/Python/Shell) plus a set of
 * named form fields. Instantiated on the canvas as a `custom` node, which shows
 * a form generated from `fields` and runs `code` with those values injected.
 */
export type WorkflowCustomModuleV1 = {
  id: string
  name: string
  description: string
  /** Reserved for a future icon picker; empty uses a generic module icon. */
  icon: string
  language: WorkflowCodeLanguage
  fields: WorkflowModuleFieldV1[]
  code: string
}

/**
 * Loop agent: repeatedly runs a body workflow, feeding each iteration's output
 * back in as the next input, until the stop condition holds or maxIterations is
 * reached. Turns "you press enter each step" into "you set the goal, the loop runs".
 */
export type WorkflowLoopMode = 'condition' | 'foreach'

export type WorkflowLoopExecution = 'sequential' | 'parallel'

export type WorkflowLoopConfigV1 = {
  /** id of the workflow run once per iteration. */
  workflowId: string
  /** 'condition' (while-loop, default) or 'foreach' (iterate an array). */
  mode?: WorkflowLoopMode
  /** foreach: expression resolving to the array to iterate (empty = the incoming payload json). */
  arraySource?: string
  /** foreach: run items one-at-a-time or concurrently. */
  execution?: WorkflowLoopExecution
  /** foreach: max concurrent iterations when execution = 'parallel' (1-8). */
  concurrency?: number
  /** foreach: collect failed items as { error } instead of aborting the loop. */
  continueOnError?: boolean
  /** Caps iterations (condition mode) and array length (foreach mode). */
  maxIterations: number
  /** Stop-when condition evaluated against each iteration's output (condition mode). */
  leftExpr: string
  operator: WorkflowConditionOperator
  rightValue: string
  caseSensitive: boolean
}

export type WorkflowHttpHeaderV1 = {
  key: string
  value: string
}

export type WorkflowHttpRequestConfigV1 = {
  method: WorkflowHttpMethod
  url: string
  headers: WorkflowHttpHeaderV1[]
  /** Templated with {{json.x}} / {{text}} from the incoming payload. */
  body: string
  timeoutMs: number
  /** Parse the response body as JSON into the payload for downstream nodes. */
  parseJson: boolean
}

export type WorkflowDelayConfigV1 = {
  delayMs: number
}

export type WorkflowFieldV1 = {
  key: string
  /** Templated with {{json.x}} / {{text}} from the incoming payload. */
  value: string
}

export type WorkflowSetFieldsConfigV1 = {
  fields: WorkflowFieldV1[]
  /** When true, merge the new fields onto the incoming json; otherwise replace it. */
  keepIncoming: boolean
  /** 'payload' (default) writes to the node output; 'run' writes into run-scoped vars ({{$run.key}}). */
  scope?: 'payload' | 'run'
}
