import {
  WORKFLOW_INPUT_FIELD_TYPES,
  WORKFLOW_MODULE_FIELD_TYPES,
  WORKFLOW_NODE_KINDS,
  type WorkflowConditionOperator,
  type WorkflowConnectionV1,
  type WorkflowCustomModuleV1,
  type WorkflowEnvVarV1,
  type WorkflowFieldV1,
  WORKFLOW_HOOK_MODES,
  WORKFLOW_HOOK_PHASES,
  WORKFLOW_NODE_INPUT_TYPES,
  type WorkflowNodeInputType,
  type WorkflowNodeInputV1,
  type WorkflowClassifierCategoryV1,
  type WorkflowHookMode,
  type WorkflowHookPhase,
  type WorkflowHookTriggerV1,
  type WorkflowInputFieldType,
  type WorkflowInputFieldV1,
  type WorkflowManualTriggerConfigV1,
  type WorkflowHttpHeaderV1,
  type WorkflowHttpMethod,
  type WorkflowModuleFieldType,
  type WorkflowModuleFieldV1,
  type WorkflowNodeKind,
  type WorkflowNodeRunResultV1,
  type WorkflowNodePresetV1,
  type WorkflowNodeRunStatus,
  type WorkflowNodeV1,
  type WorkflowRunStatus,
  type WorkflowRunV1,
  type WorkflowScheduleV1,
  type WorkflowSwitchRuleV1,
  type WorkflowWebhookMethod,
  MIN_KUN_LOCAL_PORT,
  type WorkflowSettingsPatchV1,
  type WorkflowSettingsV1,
  type WorkflowTriggerScheduleKind,
  type WorkflowV1
} from './app-settings-types'
import {
  normalizeAtTime,
  normalizeBoolean,
  normalizePositiveInteger,
  normalizeRunMode,
  normalizeScheduleReasoningEffort,
  normalizeTimeOfDay
} from './app-settings-normalizers'

export const MAX_WORKFLOW_RUNS = 20

export const PREVIOUS_WORKFLOW_WEBHOOK_PORT = 8799

export const MAX_WORKFLOW_CONNECTIONS = 512

export const MAX_WORKFLOW_HTTP_HEADERS = 50

export const MAX_WORKFLOW_PRESETS = 100

export const CONDITION_OPERATORS: readonly WorkflowConditionOperator[] = [
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
]

export const HTTP_METHODS: readonly WorkflowHttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']

export function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export function asTrimmed(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : fallback
}

export function asText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function normalizeWorkflowWebhookPort(value: unknown, fallback: number): number {
  if (value === PREVIOUS_WORKFLOW_WEBHOOK_PORT) return fallback
  return normalizePositiveInteger(value, fallback, MIN_KUN_LOCAL_PORT, 65_535)
}

export function normalizeWorkflowScheduleKind(value: unknown): WorkflowTriggerScheduleKind {
  if (value === 'interval' || value === 'daily' || value === 'at' || value === 'cron') return value
  return 'manual'
}

export function normalizeConditionOperator(value: unknown): WorkflowConditionOperator {
  return CONDITION_OPERATORS.includes(value as WorkflowConditionOperator)
    ? (value as WorkflowConditionOperator)
    : 'contains'
}

export function normalizeHttpMethod(value: unknown): WorkflowHttpMethod {
  return HTTP_METHODS.includes(value as WorkflowHttpMethod) ? (value as WorkflowHttpMethod) : 'GET'
}

export function normalizeWebhookPath(value: unknown): string {
  const raw = asTrimmed(value)
  if (!raw) return '/webhook'
  return raw.startsWith('/') ? raw : `/${raw}`
}

export function normalizeWebhookMethod(value: unknown): WorkflowWebhookMethod {
  return value === 'GET' || value === 'POST' || value === 'PUT' || value === 'PATCH' || value === 'DELETE'
    ? value
    : 'ANY'
}

export function normalizeWorkflowSchedule(value: unknown): WorkflowScheduleV1 {
  const s = record(value)
  return {
    kind: normalizeWorkflowScheduleKind(s.kind),
    everyMinutes: normalizePositiveInteger(s.everyMinutes, 60, 1, 10_080),
    timeOfDay: normalizeTimeOfDay(s.timeOfDay),
    atTime: normalizeAtTime(s.atTime),
    cron: asTrimmed(s.cron)
  }
}

export function normalizePosition(value: unknown): { x: number; y: number } {
  const p = record(value)
  const x = typeof p.x === 'number' && Number.isFinite(p.x) ? p.x : 0
  const y = typeof p.y === 'number' && Number.isFinite(p.y) ? p.y : 0
  return { x, y }
}

export function normalizeHttpHeaders(value: unknown): WorkflowHttpHeaderV1[] {
  if (!Array.isArray(value)) return []
  return value
    .map((entry) => {
      const r = record(entry)
      return { key: asTrimmed(r.key), value: asText(r.value) }
    })
    .filter((header) => header.key)
    .slice(0, MAX_WORKFLOW_HTTP_HEADERS)
}

export function normalizeFields(value: unknown): WorkflowFieldV1[] {
  if (!Array.isArray(value)) return []
  return value
    .map((entry) => {
      const r = record(entry)
      return { key: asTrimmed(r.key), value: asText(r.value) }
    })
    .filter((field) => field.key)
    .slice(0, MAX_WORKFLOW_HTTP_HEADERS)
}

export function normalizeSwitchRules(value: unknown): WorkflowSwitchRuleV1[] {
  if (!Array.isArray(value)) return []
  return value
    .map((entry) => {
      const r = record(entry)
      return {
        leftExpr: asText(r.leftExpr),
        operator: normalizeConditionOperator(r.operator),
        rightValue: asText(r.rightValue),
        caseSensitive: normalizeBoolean(r.caseSensitive, false)
      }
    })
    .slice(0, 20)
}

export function normalizeNodeErrorFields(n: Record<string, unknown>): {
  onError?: 'continue' | 'fallback'
  retries?: number
  retryDelayMs?: number
  fallbackJson?: string
} {
  const out: { onError?: 'continue' | 'fallback'; retries?: number; retryDelayMs?: number; fallbackJson?: string } = {}
  if (n.onError === 'continue' || n.onError === 'fallback') out.onError = n.onError
  const retries = normalizePositiveInteger(n.retries, 0, 0, 10)
  if (retries > 0) out.retries = retries
  const delay = normalizePositiveInteger(n.retryDelayMs, 0, 0, 600_000)
  if (delay > 0) out.retryDelayMs = delay
  const fallback = asText(n.fallbackJson)
  if (fallback) out.fallbackJson = fallback
  return out
}

/** Named, typed inputs a node pulls from upstream output (resolved as {{$input.key}}). */
export function normalizeNodeInputs(value: unknown): WorkflowNodeInputV1[] | undefined {
  if (!Array.isArray(value)) return undefined
  const inputs = value
    .map((entry): WorkflowNodeInputV1 => {
      const e = record(entry)
      const type = WORKFLOW_NODE_INPUT_TYPES.includes(e.type as WorkflowNodeInputType)
        ? (e.type as WorkflowNodeInputType)
        : 'text'
      return { key: asTrimmed(e.key), type, source: asText(e.source) }
    })
    .filter((input) => input.key.length > 0)
    .slice(0, 30)
  return inputs.length ? inputs : undefined
}

export function normalizeWorkflowInputSchema(value: unknown): WorkflowInputFieldV1[] {
  if (!Array.isArray(value)) return []
  return value
    .map((entry): WorkflowInputFieldV1 => {
      const f = record(entry)
      const type = f.type
      return {
        key: asTrimmed(f.key),
        label: asTrimmed(f.label),
        type: WORKFLOW_INPUT_FIELD_TYPES.includes(type as WorkflowInputFieldType)
          ? (type as WorkflowInputFieldType)
          : 'text',
        required: normalizeBoolean(f.required, false),
        options: Array.isArray(f.options)
          ? f.options.map((option) => asTrimmed(option)).filter((option) => option.length > 0).slice(0, 50)
          : [],
        defaultValue: asText(f.defaultValue),
        description: asText(f.description)
      }
    })
    .filter((field) => field.key.length > 0)
    .slice(0, 50)
}

export function normalizeHookTriggers(value: unknown): WorkflowHookTriggerV1[] {
  if (!Array.isArray(value)) return []
  return value
    .map((entry, index): WorkflowHookTriggerV1 => {
      const h = record(entry)
      const phase = WORKFLOW_HOOK_PHASES.includes(h.phase as WorkflowHookPhase)
        ? (h.phase as WorkflowHookPhase)
        : 'PostToolUse'
      const mode = WORKFLOW_HOOK_MODES.includes(h.mode as WorkflowHookMode) ? (h.mode as WorkflowHookMode) : 'observe'
      return {
        id: asTrimmed(h.id) || `hook-${index + 1}`,
        enabled: normalizeBoolean(h.enabled, false),
        workflowId: asTrimmed(h.workflowId),
        phase,
        toolNames: Array.isArray(h.toolNames)
          ? h.toolNames
              .map((name) => asTrimmed(name))
              .filter((name) => name.length > 0)
              .slice(0, 50)
          : [],
        mode,
        timeoutMs: normalizePositiveInteger(h.timeoutMs, 0, 0, 3_600_000)
      }
    })
    .slice(0, 50)
}

export function normalizeClassifierCategories(value: unknown): WorkflowClassifierCategoryV1[] {
  if (!Array.isArray(value)) return []
  return value
    .map((entry, index): WorkflowClassifierCategoryV1 => {
      const c = record(entry)
      return { id: asTrimmed(c.id) || `cat-${index + 1}`, label: asTrimmed(c.label) }
    })
    .slice(0, 20)
}

export function normalizeEnvVars(value: unknown): WorkflowEnvVarV1[] {
  if (!Array.isArray(value)) return []
  return value
    .map((entry): WorkflowEnvVarV1 => {
      const e = record(entry)
      const type = e.type
      return {
        key: asTrimmed(e.key),
        value: asText(e.value),
        type: type === 'number' || type === 'boolean' || type === 'secret' ? type : 'string'
      }
    })
    .filter((entry) => entry.key.length > 0)
    .slice(0, 100)
}

export function normalizeWorkflowNode(value: unknown, index: number): WorkflowNodeV1 | null {
  const n = record(value)
  const type = n.type
  if (typeof type !== 'string' || !WORKFLOW_NODE_KINDS.includes(type as WorkflowNodeKind)) return null
  const kind = type as WorkflowNodeKind
  const nodeInputs = normalizeNodeInputs(n.inputs)
  const base = {
    id: asTrimmed(n.id) || `node-${index + 1}`,
    name: asTrimmed(n.name),
    position: normalizePosition(n.position),
    disabled: normalizeBoolean(n.disabled, false),
    ...normalizeNodeErrorFields(n),
    ...(nodeInputs ? { inputs: nodeInputs } : {})
  }
  const config = record(n.config)
  switch (kind) {
    case 'manual-trigger': {
      const manualConfig: WorkflowManualTriggerConfigV1 = { workspaceRoot: asTrimmed(config.workspaceRoot) }
      const inputSchema = normalizeWorkflowInputSchema(config.inputSchema)
      if (inputSchema.length) manualConfig.inputSchema = inputSchema
      return { ...base, type: 'manual-trigger', config: manualConfig }
    }
    case 'schedule-trigger':
      return {
        ...base,
        type: 'schedule-trigger',
        config: { schedule: normalizeWorkflowSchedule(config.schedule), workspaceRoot: asTrimmed(config.workspaceRoot) }
      }
    case 'webhook-trigger':
      return {
        ...base,
        type: 'webhook-trigger',
        config: {
          path: normalizeWebhookPath(config.path),
          method: normalizeWebhookMethod(config.method),
          workspaceRoot: asTrimmed(config.workspaceRoot)
        }
      }
    case 'ai-agent':
      return {
        ...base,
        type: 'ai-agent',
        config: {
          prompt: asText(config.prompt),
          workspaceRoot: asTrimmed(config.workspaceRoot),
          providerId: asTrimmed(config.providerId),
          model: asTrimmed(config.model),
          reasoningEffort: normalizeScheduleReasoningEffort(config.reasoningEffort),
          mode: normalizeRunMode(config.mode)
        }
      }
    case 'generate-image':
      return {
        ...base,
        type: 'generate-image',
        config: {
          prompt: asText(config.prompt),
          providerId: asTrimmed(config.providerId),
          model: asTrimmed(config.model),
          size: asTrimmed(config.size),
          outputDir: asTrimmed(config.outputDir)
        }
      }
    case 'condition':
      return {
        ...base,
        type: 'condition',
        config: {
          leftExpr: asText(config.leftExpr),
          operator: normalizeConditionOperator(config.operator),
          rightValue: asText(config.rightValue),
          caseSensitive: normalizeBoolean(config.caseSensitive, false)
        }
      }
    case 'switch':
      return {
        ...base,
        type: 'switch',
        config: {
          rules: normalizeSwitchRules(config.rules),
          fallback: normalizeBoolean(config.fallback, true)
        }
      }
    case 'filter':
      return {
        ...base,
        type: 'filter',
        config: {
          leftExpr: asText(config.leftExpr),
          operator: normalizeConditionOperator(config.operator),
          rightValue: asText(config.rightValue),
          caseSensitive: normalizeBoolean(config.caseSensitive, false)
        }
      }
    case 'set-fields':
      return {
        ...base,
        type: 'set-fields',
        config: {
          fields: normalizeFields(config.fields),
          keepIncoming: normalizeBoolean(config.keepIncoming, false),
          scope: config.scope === 'run' ? 'run' : 'payload'
        }
      }
    case 'sort':
      return {
        ...base,
        type: 'sort',
        config: {
          field: asTrimmed(config.field),
          order: config.order === 'desc' ? 'desc' : 'asc',
          numeric: normalizeBoolean(config.numeric, false)
        }
      }
    case 'limit':
      return {
        ...base,
        type: 'limit',
        config: {
          count: normalizePositiveInteger(config.count, 10, 1, 100_000),
          from: config.from === 'last' ? 'last' : 'first'
        }
      }
    case 'aggregate':
      return {
        ...base,
        type: 'aggregate',
        config: {
          mode:
            config.mode === 'sum' || config.mode === 'collect' || config.mode === 'join' ? config.mode : 'count',
          field: asTrimmed(config.field),
          separator: asText(config.separator)
        }
      }
    case 'code':
      return {
        ...base,
        type: 'code',
        config: {
          language: config.language === 'python' || config.language === 'bash' ? config.language : 'javascript',
          code: asText(config.code)
        }
      }
    case 'merge':
      return {
        ...base,
        type: 'merge',
        config: { mode: config.mode === 'object' ? 'object' : 'array' }
      }
    case 'subworkflow':
      return {
        ...base,
        type: 'subworkflow',
        config: { workflowId: asTrimmed(config.workflowId) }
      }
    case 'loop':
      return {
        ...base,
        type: 'loop',
        config: {
          workflowId: asTrimmed(config.workflowId),
          mode: config.mode === 'foreach' ? 'foreach' : 'condition',
          arraySource: asText(config.arraySource),
          execution: config.execution === 'parallel' ? 'parallel' : 'sequential',
          concurrency: normalizePositiveInteger(config.concurrency, 4, 1, 8),
          continueOnError: normalizeBoolean(config.continueOnError, false),
          maxIterations: normalizePositiveInteger(config.maxIterations, 10, 1, 100),
          leftExpr: asText(config.leftExpr),
          operator: normalizeConditionOperator(config.operator),
          rightValue: asText(config.rightValue),
          caseSensitive: normalizeBoolean(config.caseSensitive, false)
        }
      }
    case 'http-request':
      return {
        ...base,
        type: 'http-request',
        config: {
          method: normalizeHttpMethod(config.method),
          url: asTrimmed(config.url),
          headers: normalizeHttpHeaders(config.headers),
          body: asText(config.body),
          timeoutMs: normalizePositiveInteger(config.timeoutMs, 30_000, 1_000, 600_000),
          parseJson: normalizeBoolean(config.parseJson, false)
        }
      }
    case 'delay':
      return {
        ...base,
        type: 'delay',
        config: { delayMs: normalizePositiveInteger(config.delayMs, 1_000, 0, 86_400_000) }
      }
    case 'template':
      return {
        ...base,
        type: 'template',
        config: { template: asText(config.template), outputMode: config.outputMode === 'json' ? 'json' : 'text' }
      }
    case 'json':
      return {
        ...base,
        type: 'json',
        config: {
          mode: config.mode === 'stringify' ? 'stringify' : 'parse',
          strict: normalizeBoolean(config.strict, false)
        }
      }
    case 'output':
      return {
        ...base,
        type: 'output',
        config: {
          mode: config.mode === 'text' || config.mode === 'json' ? config.mode : 'auto',
          textTemplate: asText(config.textTemplate),
          jsonPath: asTrimmed(config.jsonPath)
        }
      }
    case 'parameter-extractor':
      return {
        ...base,
        type: 'parameter-extractor',
        config: {
          source: asText(config.source),
          instruction: asText(config.instruction),
          fields: normalizeWorkflowInputSchema(config.fields),
          providerId: asTrimmed(config.providerId),
          model: asTrimmed(config.model),
          reasoningEffort: normalizeScheduleReasoningEffort(config.reasoningEffort)
        }
      }
    case 'question-classifier':
      return {
        ...base,
        type: 'question-classifier',
        config: {
          source: asText(config.source),
          instruction: asText(config.instruction),
          categories: normalizeClassifierCategories(config.categories),
          providerId: asTrimmed(config.providerId),
          model: asTrimmed(config.model),
          reasoningEffort: normalizeScheduleReasoningEffort(config.reasoningEffort)
        }
      }
    case 'human-approval':
      return {
        ...base,
        type: 'human-approval',
        config: {
          title: asText(config.title),
          instruction: asText(config.instruction),
          timeoutMs: normalizePositiveInteger(config.timeoutMs, 0, 0, 86_400_000),
          onTimeout: config.onTimeout === 'approved' ? 'approved' : 'rejected'
        }
      }
    case 'custom':
      return {
        ...base,
        type: 'custom',
        config: { moduleId: asTrimmed(config.moduleId), values: normalizeStringRecord(config.values) }
      }
    default:
      return null
  }
}

export function normalizeStringRecord(value: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  let count = 0
  for (const [key, raw] of Object.entries(record(value))) {
    if (count >= 100) break
    const trimmedKey = key.trim()
    if (!trimmedKey) continue
    out[trimmedKey] = typeof raw === 'string' ? raw : raw == null ? '' : String(raw)
    count += 1
  }
  return out
}

export function normalizeModuleField(value: unknown): WorkflowModuleFieldV1 | null {
  const f = record(value)
  const key = asTrimmed(f.key)
  if (!key) return null
  const type = WORKFLOW_MODULE_FIELD_TYPES.includes(f.type as WorkflowModuleFieldType)
    ? (f.type as WorkflowModuleFieldType)
    : 'text'
  return {
    key,
    label: asTrimmed(f.label) || key,
    type,
    defaultValue: asText(f.defaultValue),
    options: Array.isArray(f.options)
      ? f.options.map((option) => asTrimmed(option)).filter((option) => option.length > 0).slice(0, 50)
      : [],
    placeholder: asTrimmed(f.placeholder)
  }
}

export function normalizeCustomModule(value: unknown, index: number): WorkflowCustomModuleV1 | null {
  const m = record(value)
  const id = asTrimmed(m.id)
  if (!id) return null
  return {
    id,
    name: asTrimmed(m.name) || `Module ${index + 1}`,
    description: asText(m.description),
    icon: asTrimmed(m.icon),
    language: m.language === 'python' || m.language === 'bash' ? m.language : 'javascript',
    fields: Array.isArray(m.fields)
      ? m.fields
          .map((field) => normalizeModuleField(field))
          .filter((field): field is WorkflowModuleFieldV1 => field !== null)
          .slice(0, 50)
      : [],
    code: asText(m.code)
  }
}
