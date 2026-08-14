import { makeToolResultItem } from '../domain/item.js'
import type {
  ToolCallLike,
  ToolHost,
  ToolHostContext,
  ToolHostResult
} from '../ports/tool-host.js'

const SOURCE_TOOL_NAMES = new Set(['grep', 'glob', 'read'])

const FAST_CONTEXT_TOOL_DESCRIPTIONS: Record<string, string> = {
  glob: [
    'Fast Context candidate-file discovery.',
    'Use this first to locate narrow candidate paths; it returns at most 100 entries and skips dependency, build, cache, and VCS directories.',
    'Do not use cursor pagination. Every call must include task_indexes for the task(s) it supports.'
  ].join(' '),
  grep: [
    'Fast Context bounded code search.',
    'After locating candidates, search only the relevant paths; it returns at most 30 matches with at most 300 characters per match and skips dependency, build, cache, and VCS directories.',
    'Do not use cursor pagination. Every call must include task_indexes for the task(s) it supports.'
  ].join(' '),
  read: [
    'Fast Context local text inspection.',
    'Read only the necessary candidate file range; text output is capped at 200 lines, while binary and image bytes are omitted.',
    'Every call must include task_indexes for the task(s) it supports.'
  ].join(' ')
}

/**
 * Adds durable task attribution only around a Fast Context child. The model's
 * original call (including task_indexes) is persisted before this wrapper runs;
 * the underlying ordinary source tool receives the index-free arguments it
 * already understands.
 */
export function createFastContextToolHost(host: ToolHost, taskCount: number): ToolHost {
  return {
    id: `${host.id}:fast-context`,
    async listTools(context) {
      const tools = await host.listTools(context)
      return tools
        .filter((tool) => SOURCE_TOOL_NAMES.has(tool.name))
        .map((tool) => ({
          ...tool,
          description: FAST_CONTEXT_TOOL_DESCRIPTIONS[tool.name] ?? tool.description,
          inputSchema: withRequiredTaskIndexes(tool.inputSchema, taskCount)
        }))
    },
    async execute(call, context, onUpdate) {
      if (!SOURCE_TOOL_NAMES.has(call.toolName)) {
        return forbiddenToolResult(call, context)
      }
      const taskIndexes = call.arguments.task_indexes
      if (!areTaskIndexes(taskIndexes, taskCount)) return invalidTaskIndexesResult(call, context, taskCount)
      const { task_indexes: _taskIndexes, ...argumentsWithoutTaskIndexes } = call.arguments
      return host.execute({ ...call, arguments: argumentsWithoutTaskIndexes }, context, onUpdate)
    },
    ...(host.clearReadTracker
      ? { clearReadTracker: (threadId?: string) => host.clearReadTracker?.(threadId) }
      : {})
  }
}

function forbiddenToolResult(call: ToolCallLike, context: ToolHostContext): ToolHostResult {
  return {
    item: makeToolResultItem({
      id: `item_${call.callId}`,
      threadId: context.threadId,
      turnId: context.turnId,
      callId: call.callId,
      toolName: call.toolName,
      toolKind: call.toolKind ?? 'tool_call',
      output: {
        code: 'fast_context_tool_not_allowed',
        error: 'Fast Context permits only grep, glob, and read.',
        fast_context: true
      },
      isError: true
    }),
    approved: false
  }
}

function withRequiredTaskIndexes(inputSchema: Record<string, unknown>, taskCount: number): Record<string, unknown> {
  const properties = record(inputSchema.properties)
  const required = Array.isArray(inputSchema.required)
    ? inputSchema.required.filter((entry): entry is string => typeof entry === 'string')
    : []
  return {
    ...inputSchema,
    properties: {
      ...properties,
      task_indexes: {
        type: 'array',
        minItems: 1,
        maxItems: taskCount,
        uniqueItems: true,
        items: { type: 'integer', minimum: 1, maximum: taskCount },
        description: `Required Fast Context task indexes from 1 to ${taskCount}; include every task this source call supports.`
      }
    },
    required: [...new Set([...required, 'task_indexes'])]
  }
}

function invalidTaskIndexesResult(
  call: ToolCallLike,
  context: ToolHostContext,
  taskCount: number
): ToolHostResult {
  return {
    item: makeToolResultItem({
      id: `item_${call.callId}`,
      threadId: context.threadId,
      turnId: context.turnId,
      callId: call.callId,
      toolName: call.toolName,
      toolKind: call.toolKind ?? 'tool_call',
      output: {
        code: 'fast_context_task_indexes_required',
        error: `Fast Context source calls require a non-empty unique task_indexes array with integers from 1 to ${taskCount}.`,
        // The invalid call is already persisted as the tool_call. Do not echo
        // an unvalidated (potentially huge or nested) argument into a second
        // durable tool_result and bypass the Fast Context output budget.
        task_indexes_provided: Object.prototype.hasOwnProperty.call(call.arguments, 'task_indexes'),
        fast_context: true
      },
      isError: true
    }),
    approved: false
  }
}

function areTaskIndexes(value: unknown, taskCount: number): value is number[] {
  return Array.isArray(value) &&
    value.length >= 1 &&
    value.length <= taskCount &&
    value.every((entry) => typeof entry === 'number' && Number.isInteger(entry) && entry >= 1 && entry <= taskCount) &&
    new Set(value).size === value.length
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}
