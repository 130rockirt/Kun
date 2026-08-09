import type {
  AppSettingsV1,
  WorkflowInputFieldV1,
  WorkflowNodeRunResultV1,
  WorkflowNodeV1,
  WorkflowScheduleV1,
  WorkflowV1
} from '../shared/app-settings'
import { safeJson, type InterpScope, type WorkflowPayload } from './workflow-expression'

export const LIVE_STATUS_LINGER_MS = 8_000

export type ScheduleTriggerNode = Extract<WorkflowNodeV1, { type: 'schedule-trigger' }>

export type NodeOutcome = {
  payload: WorkflowPayload
  message: string
  /** For condition nodes: which outgoing handle to follow ('true' | 'false'). */
  branch?: string
  /** For ai-agent nodes: the Kun thread created. */
  threadId?: string
}

export type NodeExecutionContext = {
  payload: WorkflowPayload
  settings: AppSettingsV1
  inputs: WorkflowPayload[]
  depth: number
  runWorkspace: string
  scope: InterpScope
  runVars: Record<string, unknown>
  runRef?: { workflowId: string; runId: string }
  signal?: AbortSignal
  cancelId?: string
  statusWorkflowId?: string
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function isScheduleTrigger(node: WorkflowNodeV1): node is ScheduleTriggerNode {
  return node.type === 'schedule-trigger'
}

export function activeScheduleTriggers(workflow: WorkflowV1): ScheduleTriggerNode[] {
  return workflow.nodes
    .filter(isScheduleTrigger)
    .filter((node) => !node.disabled && node.config.schedule.kind !== 'manual')
}

export function workflowHasScheduleTrigger(workflow: WorkflowV1): boolean {
  return activeScheduleTriggers(workflow).length > 0
}

export function hasEnabledScheduledWorkflow(settings: AppSettingsV1): boolean {
  return settings.workflow.workflows.some((workflow) => workflow.enabled && workflowHasScheduleTrigger(workflow))
}

/** Minimal, dependency-free 5-field cron field parser ("* , - /"). */
export function parseCronField(field: string, min: number, max: number): Set<number> | null {
  const out = new Set<number>()
  for (const part of field.split(',')) {
    const match = part.trim().match(/^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/)
    if (!match) return null
    const star = match[1] === '*'
    const lo = star ? min : Number(match[1])
    const hi = star ? max : match[2] !== undefined ? Number(match[2]) : match[3] !== undefined ? max : lo
    const step = match[3] !== undefined ? Number(match[3]) : 1
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || step < 1) return null
    for (let value = lo; value <= hi; value += step) {
      if (value >= min && value <= max) out.add(value)
    }
  }
  return out.size ? out : null
}

/** Next fire time at or after `from` for a standard "min hour dom month dow" cron, in local time. */
export function cronNextRun(expr: string, from: Date): Date | null {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return null
  const minutes = parseCronField(parts[0], 0, 59)
  const hours = parseCronField(parts[1], 0, 23)
  const doms = parseCronField(parts[2], 1, 31)
  const months = parseCronField(parts[3], 1, 12)
  const dowsRaw = parseCronField(parts[4], 0, 7)
  if (!minutes || !hours || !doms || !months || !dowsRaw) return null
  const dows = new Set([...dowsRaw].map((day) => (day === 7 ? 0 : day)))
  const domRestricted = parts[2].trim() !== '*'
  const dowRestricted = parts[4].trim() !== '*'

  const cursor = new Date(from.getTime())
  cursor.setSeconds(0, 0)
  cursor.setMinutes(cursor.getMinutes() + 1)
  const limit = 366 * 24 * 60
  for (let i = 0; i < limit; i += 1) {
    if (months.has(cursor.getMonth() + 1)) {
      const dom = cursor.getDate()
      const dow = cursor.getDay()
      // Standard cron: when both DOM and DOW are restricted, match either.
      const dayOk =
        domRestricted && dowRestricted
          ? doms.has(dom) || dows.has(dow)
          : (domRestricted ? doms.has(dom) : true) && (dowRestricted ? dows.has(dow) : true)
      if (dayOk && hours.has(cursor.getHours()) && minutes.has(cursor.getMinutes())) {
        return new Date(cursor.getTime())
      }
    }
    cursor.setMinutes(cursor.getMinutes() + 1)
  }
  return null
}

export function nextRunFromSchedule(schedule: WorkflowScheduleV1, from: Date): string {
  switch (schedule.kind) {
    case 'manual':
      return ''
    case 'at':
      return schedule.atTime.trim()
    case 'interval':
      return new Date(from.getTime() + schedule.everyMinutes * 60_000).toISOString()
    case 'cron': {
      const next = schedule.cron.trim() ? cronNextRun(schedule.cron, from) : null
      return next ? next.toISOString() : ''
    }
    case 'daily':
    default: {
      const [hourRaw, minuteRaw] = schedule.timeOfDay.split(':')
      const hour = Number(hourRaw)
      const minute = Number(minuteRaw)
      const next = new Date(from)
      next.setSeconds(0, 0)
      next.setHours(Number.isFinite(hour) ? hour : 9, Number.isFinite(minute) ? minute : 0, 0, 0)
      if (next.getTime() <= from.getTime()) next.setDate(next.getDate() + 1)
      return next.toISOString()
    }
  }
}

export function computeWorkflowNextRunAt(workflow: WorkflowV1, from: Date): string {
  if (!workflow.enabled) return ''
  const candidates = activeScheduleTriggers(workflow)
    .map((node) => nextRunFromSchedule(node.config.schedule, from).trim())
    .filter((value) => value && Number.isFinite(Date.parse(value)))
    .sort()
  return candidates[0] ?? ''
}

export function coerceInputFieldValue(field: WorkflowInputFieldV1, raw: unknown): unknown {
  const asString = typeof raw === 'string' ? raw : raw === undefined || raw === null ? '' : String(raw)
  switch (field.type) {
    case 'number':
      return typeof raw === 'number' ? raw : asString.trim() === '' ? 0 : Number(asString) || 0
    case 'boolean':
      return typeof raw === 'boolean' ? raw : asString === 'true' || asString === '1'
    case 'json':
      if (raw && typeof raw === 'object') return raw
      try {
        return JSON.parse(asString)
      } catch {
        return asString
      }
    default:
      return raw && typeof raw === 'object' ? raw : asString
  }
}

/** Build the run's initial payload from the manual trigger's input schema (or pass input through verbatim). */
export function coerceInputToPayload(schema: WorkflowInputFieldV1[] | undefined, input: unknown): WorkflowPayload {
  if (!schema || schema.length === 0) {
    if (input === undefined || input === null) return { json: {}, text: '' }
    if (typeof input === 'string') return { json: { text: input }, text: input }
    return { json: input, text: safeJson(input) }
  }
  let src: Record<string, unknown> = {}
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    src = input as Record<string, unknown>
  } else if (typeof input === 'string' && input.trim()) {
    try {
      const parsed = JSON.parse(input)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) src = parsed as Record<string, unknown>
    } catch {
      /* not a JSON object — fields fall back to defaults */
    }
  }
  const json: Record<string, unknown> = {}
  for (const field of schema) {
    json[field.key] = coerceInputFieldValue(field, field.key in src ? src[field.key] : field.defaultValue)
  }
  return { json, text: safeJson(json) }
}

/** Returns the first required input key missing from `input`, or null if all present. */
export function missingRequiredInput(schema: WorkflowInputFieldV1[] | undefined, input: unknown): string | null {
  if (!schema) return null
  const src = input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {}
  for (const field of schema) {
    if (field.required && !(field.key in src) && !field.defaultValue.trim()) return field.label || field.key
  }
  return null
}

/** Coerce a resolved node-input value to its declared type. */

export function summarizeRun(results: WorkflowNodeRunResultV1[]): string {
  const lastMeaningful = [...results].reverse().find((result) => result.status === 'success' && result.message.trim())
  if (lastMeaningful) return lastMeaningful.message
  return `Completed ${results.length} step${results.length === 1 ? '' : 's'}`
}

/** Short description of a workflow for the agent's run_workflow / list_workflows tools. */
export function summarizeWorkflowForAgent(workflow: WorkflowV1): string {
  const steps = workflow.nodes.filter((node) => node.type === 'ai-agent' || node.type === 'custom').length
  const kinds = [...new Set(workflow.nodes.map((node) => node.type))].filter(
    (kind) => kind !== 'manual-trigger' && kind !== 'schedule-trigger' && kind !== 'webhook-trigger'
  )
  return `${workflow.nodes.length} nodes${steps ? `, ${steps} AI step(s)` : ''} — ${kinds.slice(0, 6).join(', ') || 'trigger only'}`
}

// ---------------------------------------------------------------------------
// WorkflowRuntime
// ---------------------------------------------------------------------------
