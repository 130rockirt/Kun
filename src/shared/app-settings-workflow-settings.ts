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

import {
  MAX_WORKFLOW_CONNECTIONS,
  MAX_WORKFLOW_PRESETS,
  MAX_WORKFLOW_RUNS,
  asText,
  asTrimmed,
  normalizeCustomModule,
  normalizeEnvVars,
  normalizeHookTriggers,
  normalizeWorkflowNode,
  normalizeWorkflowWebhookPort,
  record
} from './app-settings-workflow-node'

export function normalizeConnections(value: unknown, nodeIds: Set<string>): WorkflowConnectionV1[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const out: WorkflowConnectionV1[] = []
  value.forEach((entry, index) => {
    const r = record(entry)
    const source = asTrimmed(r.source)
    const target = asTrimmed(r.target)
    // Drop dangling edges so the execution engine never references a missing node.
    if (!source || !target || !nodeIds.has(source) || !nodeIds.has(target)) return
    const id = asTrimmed(r.id) || `edge-${index + 1}`
    if (seen.has(id)) return
    seen.add(id)
    out.push({
      id,
      source,
      sourceHandle: asTrimmed(r.sourceHandle) || 'out',
      target,
      targetHandle: asTrimmed(r.targetHandle) || 'in'
    })
  })
  return out.slice(0, MAX_WORKFLOW_CONNECTIONS)
}

export function normalizeNodeRunStatus(value: unknown): WorkflowNodeRunStatus {
  if (value === 'running' || value === 'success' || value === 'error' || value === 'skipped') return value
  return 'pending'
}

export function normalizeWorkflowRunStatus(value: unknown): WorkflowRunStatus {
  if (value === 'running' || value === 'success' || value === 'error') return value
  return 'idle'
}

export function normalizeNodeResult(value: unknown): WorkflowNodeRunResultV1 {
  const r = record(value)
  return {
    nodeId: asTrimmed(r.nodeId),
    status: normalizeNodeRunStatus(r.status),
    startedAt: asTrimmed(r.startedAt),
    finishedAt: asTrimmed(r.finishedAt),
    message: asText(r.message),
    outputJson: asText(r.outputJson),
    threadId: asTrimmed(r.threadId),
    error: asText(r.error),
    ...(r.inputJson !== undefined ? { inputJson: asText(r.inputJson) } : {}),
    ...(r.retries !== undefined ? { retries: normalizePositiveInteger(r.retries, 0, 0, 100) } : {})
  }
}

export function normalizeRun(value: unknown, index: number): WorkflowRunV1 {
  const r = record(value)
  return {
    id: asTrimmed(r.id) || `run-${index + 1}`,
    trigger: asTrimmed(r.trigger) || 'manual',
    status: normalizeWorkflowRunStatus(r.status),
    startedAt: asTrimmed(r.startedAt),
    finishedAt: asTrimmed(r.finishedAt),
    message: asText(r.message),
    nodeResults: Array.isArray(r.nodeResults) ? r.nodeResults.map(normalizeNodeResult) : []
  }
}

export function normalizeWorkflow(workflow: Partial<WorkflowV1>, index: number, now: string): WorkflowV1 {
  const w = workflow ?? {}
  const nodes = Array.isArray(w.nodes)
    ? w.nodes
        .map((node, nodeIndex) => normalizeWorkflowNode(node, nodeIndex))
        .filter((node): node is WorkflowNodeV1 => node !== null)
    : []
  const nodeIds = new Set(nodes.map((node) => node.id))
  const connections = normalizeConnections(w.connections, nodeIds)
  const runs = Array.isArray(w.runs)
    ? w.runs.map((run, runIndex) => normalizeRun(run, runIndex)).slice(-MAX_WORKFLOW_RUNS)
    : []
  return {
    id: asTrimmed(w.id) || `workflow-${index + 1}`,
    name: asTrimmed(w.name) || `Workflow ${index + 1}`,
    enabled: normalizeBoolean(w.enabled, true),
    callableByAgent: normalizeBoolean(w.callableByAgent, false),
    env: normalizeEnvVars(w.env),
    nodes,
    connections,
    createdAt: asTrimmed(w.createdAt) || now,
    updatedAt: asTrimmed(w.updatedAt) || now,
    lastRunAt: asTrimmed(w.lastRunAt),
    nextRunAt: asTrimmed(w.nextRunAt),
    lastStatus: normalizeWorkflowRunStatus(w.lastStatus),
    lastMessage: asText(w.lastMessage),
    runs
  }
}

export function defaultWorkflowSettings(): WorkflowSettingsV1 {
  return {
    enabled: false,
    defaultWorkspaceRoot: '',
    providerId: '',
    model: '',
    mode: 'agent',
    keepAwake: false,
    webhookPort: 18799,
    webhookSecret: '',
    workflows: [],
    presets: [],
    modules: [],
    hookTriggers: []
  }
}

export function normalizeNodePreset(value: unknown, index: number): WorkflowNodePresetV1 | null {
  const p = record(value)
  // Reuse the node normalizer so the preset's saved config is validated per kind.
  const node = normalizeWorkflowNode({ type: p.nodeType, name: p.nodeName, config: p.config }, index)
  if (!node) return null
  return {
    id: asTrimmed(p.id) || `preset-${index}`,
    label: asTrimmed(p.label) || node.name || node.type,
    icon: asTrimmed(p.icon),
    nodeType: node.type,
    nodeName: node.name,
    config: node.config
  }
}

export function normalizeWorkflowSettings(input: WorkflowSettingsPatchV1 | undefined): WorkflowSettingsV1 {
  const defaults = defaultWorkflowSettings()
  const source = input ?? {}
  const now = new Date().toISOString()
  return {
    enabled: normalizeBoolean(source.enabled, defaults.enabled),
    defaultWorkspaceRoot: asTrimmed(source.defaultWorkspaceRoot),
    providerId: asTrimmed(source.providerId),
    model: asTrimmed(source.model),
    mode: normalizeRunMode(source.mode),
    keepAwake: normalizeBoolean(source.keepAwake, defaults.keepAwake),
    webhookPort: normalizeWorkflowWebhookPort(source.webhookPort, defaults.webhookPort),
    webhookSecret: asTrimmed(source.webhookSecret),
    workflows: Array.isArray(source.workflows)
      ? source.workflows.map((workflow, index) => normalizeWorkflow(workflow as Partial<WorkflowV1>, index, now))
      : [],
    presets: Array.isArray(source.presets)
      ? source.presets
          .map((preset, index) => normalizeNodePreset(preset, index))
          .filter((preset): preset is WorkflowNodePresetV1 => preset !== null)
          .slice(0, MAX_WORKFLOW_PRESETS)
      : [],
    modules: Array.isArray(source.modules)
      ? source.modules
          .map((module, index) => normalizeCustomModule(module, index))
          .filter((module): module is WorkflowCustomModuleV1 => module !== null)
          .slice(0, MAX_WORKFLOW_PRESETS)
      : [],
    hookTriggers: normalizeHookTriggers(source.hookTriggers)
  }
}

export function mergeWorkflowSettings(
  current: WorkflowSettingsV1,
  patch: WorkflowSettingsPatchV1 | undefined
): WorkflowSettingsV1 {
  if (!patch) return normalizeWorkflowSettings(current)
  return normalizeWorkflowSettings({
    ...current,
    ...patch,
    workflows: patch.workflows ?? current.workflows,
    presets: patch.presets ?? current.presets,
    modules: patch.modules ?? current.modules,
    hookTriggers: patch.hookTriggers ?? current.hookTriggers
  })
}
