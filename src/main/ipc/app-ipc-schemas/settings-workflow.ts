import { z } from 'zod'
import { MIN_KUN_LOCAL_PORT } from '../../../shared/app-settings'
import {
  MAX_BODY_BYTES,
  MAX_CHANNEL_TEXT_LENGTH,
  MAX_ID_LENGTH,
  MAX_URL_LENGTH,
  defaultPathSchema,
  trimmedString
} from './common'
import {
  clawRunModeSchema,
  clawTaskStatusSchema,
  optionalModelIdSchema,
  scheduleReasoningEffortSchema
} from './settings-model'

const workflowScheduleKindSchema = z.enum(['manual', 'interval', 'daily', 'at', 'cron'])
const workflowConditionOperatorSchema = z.enum([
  'contains',
  'notContains',
  'equals',
  'notEquals',
  'startsWith',
  'endsWith',
  'isEmpty',
  'isNotEmpty',
  'gt',
  'gte',
  'lt',
  'lte'
])
const workflowHttpMethodSchema = z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
const workflowNodeRunStatusSchema = z.enum(['pending', 'running', 'success', 'error', 'skipped'])

const workflowPositionSchema = z
  .object({ x: z.number(), y: z.number() })
  .strict()

const workflowScheduleSchema = z
  .object({
    kind: workflowScheduleKindSchema.optional(),
    everyMinutes: z.number().int().min(1).max(10_080).optional(),
    timeOfDay: z.string().max(16).optional(),
    atTime: z.string().max(128).optional(),
    cron: z.string().max(256).optional()
  })
  .strict()

const workflowAiAgentConfigSchema = z
  .object({
    prompt: z.string().max(MAX_CHANNEL_TEXT_LENGTH).optional(),
    workspaceRoot: defaultPathSchema,
    providerId: z.string().trim().max(64).optional(),
    model: optionalModelIdSchema,
    reasoningEffort: scheduleReasoningEffortSchema.optional(),
    mode: clawRunModeSchema.optional()
  })
  .strict()

const workflowGenerateImageConfigSchema = z
  .object({
    prompt: z.string().max(MAX_CHANNEL_TEXT_LENGTH).optional(),
    providerId: z.string().max(MAX_ID_LENGTH).optional(),
    model: optionalModelIdSchema,
    size: z.string().max(32).optional(),
    outputDir: z.string().max(1024).optional()
  })
  .strict()

const workflowConditionConfigSchema = z
  .object({
    leftExpr: z.string().max(2_000).optional(),
    operator: workflowConditionOperatorSchema.optional(),
    rightValue: z.string().max(4_000).optional(),
    caseSensitive: z.boolean().optional()
  })
  .strict()

const workflowHttpHeaderSchema = z
  .object({
    key: z.string().max(256),
    value: z.string().max(4_000)
  })
  .strict()

const workflowHttpRequestConfigSchema = z
  .object({
    method: workflowHttpMethodSchema.optional(),
    url: z.string().max(MAX_URL_LENGTH).optional(),
    headers: z.array(workflowHttpHeaderSchema).max(50).optional(),
    body: z.string().max(MAX_BODY_BYTES).optional(),
    timeoutMs: z.number().int().min(1_000).max(600_000).optional(),
    parseJson: z.boolean().optional()
  })
  .strict()

const workflowDelayConfigSchema = z
  .object({ delayMs: z.number().int().min(0).max(86_400_000).optional() })
  .strict()

const workflowCustomConfigSchema = z
  .object({
    moduleId: z.string().max(MAX_ID_LENGTH).optional(),
    values: z.record(z.string(), z.string().max(MAX_BODY_BYTES)).optional()
  })
  .strict()

const workflowTemplateConfigSchema = z
  .object({
    template: z.string().max(MAX_BODY_BYTES).optional(),
    outputMode: z.enum(['text', 'json']).optional()
  })
  .strict()

const workflowJsonConfigSchema = z
  .object({
    mode: z.enum(['parse', 'stringify']).optional(),
    strict: z.boolean().optional()
  })
  .strict()

const workflowOutputConfigSchema = z
  .object({
    mode: z.enum(['auto', 'text', 'json']).optional(),
    textTemplate: z.string().max(MAX_BODY_BYTES).optional(),
    jsonPath: z.string().max(2_000).optional()
  })
  .strict()

const workflowFieldSchema = z
  .object({ key: z.string().max(256), value: z.string().max(MAX_BODY_BYTES) })
  .strict()

const workflowSetFieldsConfigSchema = z
  .object({
    fields: z.array(workflowFieldSchema).max(50).optional(),
    keepIncoming: z.boolean().optional(),
    scope: z.enum(['payload', 'run']).optional()
  })
  .strict()

const workflowSwitchRuleSchema = z
  .object({
    leftExpr: z.string().max(2_000),
    operator: workflowConditionOperatorSchema,
    rightValue: z.string().max(4_000),
    caseSensitive: z.boolean()
  })
  .partial()
  .strict()

const workflowSwitchConfigSchema = z
  .object({
    rules: z.array(workflowSwitchRuleSchema).max(20).optional(),
    fallback: z.boolean().optional()
  })
  .strict()

const workflowCodeConfigSchema = z
  .object({
    language: z.enum(['javascript', 'python', 'bash']).optional(),
    code: z.string().max(MAX_BODY_BYTES).optional()
  })
  .strict()

const workflowMergeConfigSchema = z.object({ mode: z.enum(['array', 'object']).optional() }).strict()

const workflowFilterConfigSchema = z
  .object({
    leftExpr: z.string().max(2_000).optional(),
    operator: workflowConditionOperatorSchema.optional(),
    rightValue: z.string().max(4_000).optional(),
    caseSensitive: z.boolean().optional()
  })
  .strict()

const workflowSortConfigSchema = z
  .object({
    field: z.string().max(256).optional(),
    order: z.enum(['asc', 'desc']).optional(),
    numeric: z.boolean().optional()
  })
  .strict()

const workflowLimitConfigSchema = z
  .object({ count: z.number().int().min(1).max(100_000).optional(), from: z.enum(['first', 'last']).optional() })
  .strict()

const workflowAggregateConfigSchema = z
  .object({
    mode: z.enum(['count', 'sum', 'collect', 'join']).optional(),
    field: z.string().max(256).optional(),
    separator: z.string().max(32).optional()
  })
  .strict()

const workflowSubWorkflowConfigSchema = z
  .object({ workflowId: z.string().max(MAX_ID_LENGTH).optional() })
  .strict()

const workflowLoopConfigSchema = z
  .object({
    workflowId: z.string().max(MAX_ID_LENGTH).optional(),
    mode: z.enum(['condition', 'foreach']).optional(),
    arraySource: z.string().max(2_000).optional(),
    execution: z.enum(['sequential', 'parallel']).optional(),
    concurrency: z.number().int().min(1).max(8).optional(),
    continueOnError: z.boolean().optional(),
    maxIterations: z.number().int().min(1).max(100).optional(),
    leftExpr: z.string().max(2_000).optional(),
    operator: workflowConditionOperatorSchema.optional(),
    rightValue: z.string().max(4_000).optional(),
    caseSensitive: z.boolean().optional()
  })
  .strict()

const workflowWebhookTriggerConfigSchema = z
  .object({
    path: z.string().max(256).optional(),
    method: z.enum(['ANY', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE']).optional(),
    workspaceRoot: defaultPathSchema
  })
  .strict()

const workflowNodeBaseShape = {
  id: z.string().max(MAX_ID_LENGTH),
  name: z.string().max(512).optional(),
  position: workflowPositionSchema.optional(),
  disabled: z.boolean().optional(),
  onError: z.enum(['fail', 'continue', 'fallback']).optional(),
  retries: z.number().int().min(0).max(10).optional(),
  retryDelayMs: z.number().int().min(0).max(600_000).optional(),
  fallbackJson: z.string().max(MAX_BODY_BYTES).optional(),
  inputs: z
    .array(
      z
        .object({
          key: z.string().max(128),
          type: z.enum(['text', 'number', 'boolean', 'json']),
          source: z.string().max(4_000)
        })
        .strict()
    )
    .max(30)
    .optional()
}

const workflowInputFieldSchema = z
  .object({
    key: z.string().max(128),
    label: z.string().max(200).optional(),
    type: z.enum(['text', 'paragraph', 'number', 'boolean', 'select', 'json']).optional(),
    required: z.boolean().optional(),
    options: z.array(z.string().max(500)).max(50).optional(),
    defaultValue: z.string().max(MAX_BODY_BYTES).optional(),
    description: z.string().max(500).optional()
  })
  .strict()

const workflowParameterExtractorConfigSchema = z
  .object({
    source: z.string().max(MAX_BODY_BYTES).optional(),
    instruction: z.string().max(MAX_BODY_BYTES).optional(),
    fields: z.array(workflowInputFieldSchema).max(50).optional(),
    providerId: z.string().trim().max(64).optional(),
    model: optionalModelIdSchema,
    reasoningEffort: scheduleReasoningEffortSchema.optional()
  })
  .strict()

const workflowQuestionClassifierConfigSchema = z
  .object({
    source: z.string().max(MAX_BODY_BYTES).optional(),
    instruction: z.string().max(MAX_BODY_BYTES).optional(),
    categories: z
      .array(z.object({ id: z.string().max(64).optional(), label: z.string().max(200).optional() }).strict())
      .max(20)
      .optional(),
    providerId: z.string().trim().max(64).optional(),
    model: optionalModelIdSchema,
    reasoningEffort: scheduleReasoningEffortSchema.optional()
  })
  .strict()

const workflowHumanApprovalConfigSchema = z
  .object({
    title: z.string().max(200).optional(),
    instruction: z.string().max(MAX_BODY_BYTES).optional(),
    timeoutMs: z.number().int().min(0).max(86_400_000).optional(),
    onTimeout: z.enum(['approved', 'rejected']).optional()
  })
  .strict()

const workflowNodePatchSchema = z.discriminatedUnion('type', [
  z
    .object({
      ...workflowNodeBaseShape,
      type: z.literal('manual-trigger'),
      config: z
        .object({
          workspaceRoot: defaultPathSchema,
          inputSchema: z.array(workflowInputFieldSchema).max(50).optional()
        })
        .strict()
        .optional()
    })
    .strict(),
  z
    .object({
      ...workflowNodeBaseShape,
      type: z.literal('schedule-trigger'),
      config: z
        .object({ schedule: workflowScheduleSchema.optional(), workspaceRoot: defaultPathSchema })
        .strict()
        .optional()
    })
    .strict(),
  z
    .object({
      ...workflowNodeBaseShape,
      type: z.literal('webhook-trigger'),
      config: workflowWebhookTriggerConfigSchema.optional()
    })
    .strict(),
  z.object({ ...workflowNodeBaseShape, type: z.literal('ai-agent'), config: workflowAiAgentConfigSchema.optional() }).strict(),
  z.object({ ...workflowNodeBaseShape, type: z.literal('generate-image'), config: workflowGenerateImageConfigSchema.optional() }).strict(),
  z.object({ ...workflowNodeBaseShape, type: z.literal('condition'), config: workflowConditionConfigSchema.optional() }).strict(),
  z.object({ ...workflowNodeBaseShape, type: z.literal('switch'), config: workflowSwitchConfigSchema.optional() }).strict(),
  z.object({ ...workflowNodeBaseShape, type: z.literal('filter'), config: workflowFilterConfigSchema.optional() }).strict(),
  z.object({ ...workflowNodeBaseShape, type: z.literal('set-fields'), config: workflowSetFieldsConfigSchema.optional() }).strict(),
  z.object({ ...workflowNodeBaseShape, type: z.literal('code'), config: workflowCodeConfigSchema.optional() }).strict(),
  z.object({ ...workflowNodeBaseShape, type: z.literal('sort'), config: workflowSortConfigSchema.optional() }).strict(),
  z.object({ ...workflowNodeBaseShape, type: z.literal('limit'), config: workflowLimitConfigSchema.optional() }).strict(),
  z.object({ ...workflowNodeBaseShape, type: z.literal('aggregate'), config: workflowAggregateConfigSchema.optional() }).strict(),
  z.object({ ...workflowNodeBaseShape, type: z.literal('http-request'), config: workflowHttpRequestConfigSchema.optional() }).strict(),
  z.object({ ...workflowNodeBaseShape, type: z.literal('merge'), config: workflowMergeConfigSchema.optional() }).strict(),
  z.object({ ...workflowNodeBaseShape, type: z.literal('subworkflow'), config: workflowSubWorkflowConfigSchema.optional() }).strict(),
  z.object({ ...workflowNodeBaseShape, type: z.literal('loop'), config: workflowLoopConfigSchema.optional() }).strict(),
  z.object({ ...workflowNodeBaseShape, type: z.literal('delay'), config: workflowDelayConfigSchema.optional() }).strict(),
  z.object({ ...workflowNodeBaseShape, type: z.literal('template'), config: workflowTemplateConfigSchema.optional() }).strict(),
  z.object({ ...workflowNodeBaseShape, type: z.literal('json'), config: workflowJsonConfigSchema.optional() }).strict(),
  z.object({ ...workflowNodeBaseShape, type: z.literal('output'), config: workflowOutputConfigSchema.optional() }).strict(),
  z.object({ ...workflowNodeBaseShape, type: z.literal('parameter-extractor'), config: workflowParameterExtractorConfigSchema.optional() }).strict(),
  z.object({ ...workflowNodeBaseShape, type: z.literal('question-classifier'), config: workflowQuestionClassifierConfigSchema.optional() }).strict(),
  z.object({ ...workflowNodeBaseShape, type: z.literal('human-approval'), config: workflowHumanApprovalConfigSchema.optional() }).strict(),
  z.object({ ...workflowNodeBaseShape, type: z.literal('custom'), config: workflowCustomConfigSchema.optional() }).strict()
])

const workflowConnectionPatchSchema = z
  .object({
    id: z.string().max(MAX_ID_LENGTH).optional(),
    source: z.string().max(MAX_ID_LENGTH),
    sourceHandle: z.string().max(64).optional(),
    target: z.string().max(MAX_ID_LENGTH),
    targetHandle: z.string().max(64).optional()
  })
  .strict()

const workflowNodeResultPatchSchema = z
  .object({
    nodeId: z.string().max(MAX_ID_LENGTH).optional(),
    status: workflowNodeRunStatusSchema.optional(),
    startedAt: z.string().max(128).optional(),
    finishedAt: z.string().max(128).optional(),
    message: z.string().max(MAX_CHANNEL_TEXT_LENGTH).optional(),
    outputJson: z.string().max(MAX_BODY_BYTES).optional(),
    inputJson: z.string().max(MAX_BODY_BYTES).optional(),
    retries: z.number().int().min(0).max(100).optional(),
    threadId: z.string().max(MAX_ID_LENGTH).optional(),
    error: z.string().max(MAX_CHANNEL_TEXT_LENGTH).optional()
  })
  .strict()

const workflowRunPatchSchema = z
  .object({
    id: z.string().max(MAX_ID_LENGTH).optional(),
    trigger: z.string().max(128).optional(),
    status: clawTaskStatusSchema.optional(),
    startedAt: z.string().max(128).optional(),
    finishedAt: z.string().max(128).optional(),
    message: z.string().max(MAX_CHANNEL_TEXT_LENGTH).optional(),
    nodeResults: z.array(workflowNodeResultPatchSchema).max(200).optional()
  })
  .strict()

const workflowPatchSchema = z
  .object({
    id: z.string().max(MAX_ID_LENGTH).optional(),
    name: z.string().max(512).optional(),
    enabled: z.boolean().optional(),
    callableByAgent: z.boolean().optional(),
    env: z
      .array(
        z
          .object({
            key: z.string().max(128),
            value: z.string().max(MAX_BODY_BYTES),
            type: z.enum(['string', 'number', 'boolean', 'secret'])
          })
          .strict()
      )
      .max(100)
      .optional(),
    nodes: z.array(workflowNodePatchSchema).max(200).optional(),
    connections: z.array(workflowConnectionPatchSchema).max(512).optional(),
    createdAt: z.string().max(128).optional(),
    updatedAt: z.string().max(128).optional(),
    lastRunAt: z.string().max(128).optional(),
    nextRunAt: z.string().max(128).optional(),
    lastStatus: clawTaskStatusSchema.optional(),
    lastMessage: z.string().max(MAX_CHANNEL_TEXT_LENGTH).optional(),
    runs: z.array(workflowRunPatchSchema).max(50).optional()
  })
  .strict()

const workflowModuleFieldSchema = z
  .object({
    key: z.string().max(128),
    label: z.string().max(200).optional(),
    type: z.enum(['text', 'textarea', 'number', 'boolean', 'select']).optional(),
    defaultValue: z.string().max(MAX_BODY_BYTES).optional(),
    options: z.array(z.string().max(200)).max(50).optional(),
    placeholder: z.string().max(200).optional()
  })
  .strict()

const workflowCustomModuleSchema = z
  .object({
    id: z.string().max(MAX_ID_LENGTH),
    name: z.string().max(200).optional(),
    description: z.string().max(2_000).optional(),
    icon: z.string().max(64).optional(),
    language: z.enum(['javascript', 'python', 'bash']).optional(),
    fields: z.array(workflowModuleFieldSchema).max(50).optional(),
    code: z.string().max(MAX_BODY_BYTES).optional()
  })
  .strict()

// Lenient: nodeType / config are re-validated per kind by normalizeNodePreset.
const workflowNodePresetSchema = z
  .object({
    id: z.string().max(MAX_ID_LENGTH),
    label: z.string().max(200),
    icon: z.string().max(64).optional(),
    nodeType: z.string().max(64),
    nodeName: z.string().max(200).optional(),
    config: z.record(z.string(), z.unknown()).optional()
  })
  .strict()

export const workflowSettingsPatchSchema = z
  .object({
    enabled: z.boolean().optional(),
    defaultWorkspaceRoot: defaultPathSchema,
    providerId: z.string().trim().max(64).optional(),
    model: optionalModelIdSchema,
    mode: clawRunModeSchema.optional(),
    keepAwake: z.boolean().optional(),
    webhookPort: z.number().int().min(MIN_KUN_LOCAL_PORT).max(65_535).optional(),
    webhookSecret: z.string().max(MAX_BODY_BYTES).optional(),
    workflows: z.array(workflowPatchSchema).max(200).optional(),
    presets: z.array(workflowNodePresetSchema).max(100).optional(),
    modules: z.array(workflowCustomModuleSchema).max(100).optional(),
    hookTriggers: z
      .array(
        z
          .object({
            id: z.string().max(MAX_ID_LENGTH).optional(),
            enabled: z.boolean().optional(),
            workflowId: z.string().max(MAX_ID_LENGTH).optional(),
            phase: z.enum(['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'TurnStart', 'TurnEnd', 'PreCompact']).optional(),
            toolNames: z.array(z.string().max(128)).max(50).optional(),
            mode: z.enum(['observe', 'block', 'rewrite']).optional(),
            timeoutMs: z.number().int().min(0).max(3_600_000).optional()
          })
          .strict()
      )
      .max(50)
      .optional()
  })
  .strict()

export const workflowRunNodePayloadSchema = z
  .object({
    workflowId: trimmedString(MAX_ID_LENGTH),
    nodeId: trimmedString(MAX_ID_LENGTH)
  })
  .strict()

export const workflowTestNodePayloadSchema = z
  .object({
    workflowId: trimmedString(MAX_ID_LENGTH),
    nodeId: trimmedString(MAX_ID_LENGTH),
    mockJson: z.string().max(MAX_BODY_BYTES)
  })
  .strict()

export const workflowResolveApprovalPayloadSchema = z
  .object({
    token: trimmedString(MAX_ID_LENGTH),
    decision: z.enum(['approved', 'rejected'])
  })
  .strict()

export const workflowCodeCheckPayloadSchema = z
  .object({
    language: z.enum(['javascript', 'python', 'bash']),
    code: z.string().max(MAX_BODY_BYTES)
  })
  .strict()
