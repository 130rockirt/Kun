import type { CoreChildRuntimeMetadataJson, CoreRuntimeEventJson, CoreTurnItemJson } from './kun-contract'
import type {
  ApprovalStatusPayload,
  CompactionEventPayload,
  ReviewEventPayload,
  RequestContextSnapshot,
  RuntimeErrorEventPayload,
  RuntimeStatusEventPayload,
  ThreadUsageSnapshot,
  ToolEventPayload,
  UserInputAnswer,
  UserInputRequestPayload,
  UserMessageEventPayload
} from './types'
import type { RuntimeProjectionAction } from './runtime-projection-actions'

export type KunEventNormalizerDeps = {
  userMessage: (item: CoreTurnItemJson) => UserMessageEventPayload
  tool: (item: CoreTurnItemJson, child?: CoreChildRuntimeMetadataJson) => ToolEventPayload
  compaction: (item: CoreTurnItemJson) => CompactionEventPayload
  review: (item: CoreTurnItemJson) => ReviewEventPayload
  itemRuntimeError: (item: CoreTurnItemJson) => RuntimeErrorEventPayload
  childTool: (event: CoreRuntimeEventJson) => ToolEventPayload | null
  readyTool: (event: CoreRuntimeEventJson) => ToolEventPayload | null
  runtimeStatus: (event: CoreRuntimeEventJson) => RuntimeStatusEventPayload | null
  approvalAction: (event: CoreRuntimeEventJson) => RuntimeProjectionAction
  approvalStatus: (event: CoreRuntimeEventJson) => ApprovalStatusPayload | null
  userInputRequest: (event: CoreRuntimeEventJson) => UserInputRequestPayload
  userInputAnswers: (answers: unknown) => UserInputAnswer[] | undefined
  compactionAction: (
    event: CoreRuntimeEventJson,
    status: 'running' | 'success'
  ) => RuntimeProjectionAction
  goalAction: (event: CoreRuntimeEventJson, cleared: boolean) => RuntimeProjectionAction
  todosAction: (event: CoreRuntimeEventJson, cleared: boolean) => RuntimeProjectionAction
  contextSnapshot: (event: CoreRuntimeEventJson) => RequestContextSnapshot | null
  usage: (event: CoreRuntimeEventJson) => ThreadUsageSnapshot | null
  runtimeError: (event: CoreRuntimeEventJson, fallback: string) => RuntimeErrorEventPayload
  errorFromRuntime: (payload: RuntimeErrorEventPayload) => Error
}

export function normalizeKunTurnItem(
  item: CoreTurnItemJson,
  child: CoreChildRuntimeMetadataJson | undefined,
  deps: KunEventNormalizerDeps
): RuntimeProjectionAction | null {
  switch (item.kind) {
    case 'user_message':
      return { type: 'user_message_received', payload: deps.userMessage(item) }
    case 'assistant_text':
    case 'assistant_reasoning':
    case 'approval':
    case 'user_input':
      return null
    case 'tool_call':
    case 'tool_result':
      return { type: 'tool_updated', payload: deps.tool(item, child) }
    case 'compaction':
      return { type: 'compaction_updated', payload: deps.compaction(item) }
    case 'review':
      return { type: 'review_updated', payload: deps.review(item) }
    case 'error':
      return { type: 'runtime_error_received', payload: deps.itemRuntimeError(item) }
    default:
      return null
  }
}

/** Pure Kun wire-event to normalized projection-action conversion. */
export function normalizeKunRuntimeEvent(
  event: CoreRuntimeEventJson,
  deps: KunEventNormalizerDeps
): RuntimeProjectionAction[] {
  switch (event.kind) {
    case 'assistant_text_delta':
    case 'assistant_reasoning_delta': {
      const text = event.item?.text ?? ''
      return text
        ? [{
            type: 'deltas_received',
            deltas: [{
              text,
              kind: event.kind === 'assistant_text_delta' ? 'agent_message' : 'agent_reasoning',
              seq: event.seq
            }]
          }]
        : []
    }
    case 'item_created':
    case 'item_updated':
    case 'item_completed':
    case 'tool_call_started':
    case 'tool_call_finished': {
      const action = event.item ? normalizeKunTurnItem(event.item, event.child, deps) : null
      return action ? [action] : []
    }
    case 'turn_started': {
      if (!event.child) return []
      const tool = deps.childTool(event)
      return tool ? [{ type: 'tool_updated', payload: tool }] : []
    }
    case 'tool_call_ready': {
      const tool = deps.readyTool(event)
      return tool ? [{ type: 'tool_updated', payload: tool }] : []
    }
    case 'tool_result_upload_wait':
    case 'model_request_retry':
    case 'tool_catalog_changed':
    case 'tool_storm_suppressed': {
      const status = deps.runtimeStatus(event)
      return status ? [{ type: 'runtime_status_received', payload: status }] : []
    }
    case 'approval_requested':
      return [deps.approvalAction(event)]
    case 'approval_resolved': {
      const status = deps.approvalStatus(event)
      return status ? [{ type: 'approval_status_changed', payload: status }] : []
    }
    case 'user_input_requested':
      return [{ type: 'user_input_requested', payload: deps.userInputRequest(event) }]
    case 'user_input_resolved': {
      const answers = deps.userInputAnswers(event.answers)
      return [{
        type: 'user_input_status_changed',
        payload: {
          itemId: event.itemId ?? event.inputId ?? `input_${event.seq ?? 'unknown'}`,
          status: event.status === 'cancelled' ? 'cancelled' : 'submitted',
          ...(answers ? { answers } : {})
        }
      }]
    }
    case 'compaction_started':
      return [deps.compactionAction(event, 'running')]
    case 'compaction_completed':
      return [deps.compactionAction(event, 'success')]
    case 'goal_updated':
      return [deps.goalAction(event, false)]
    case 'goal_cleared':
      return [deps.goalAction(event, true)]
    case 'todos_updated':
      return [deps.todosAction(event, false)]
    case 'todos_cleared':
      return [deps.todosAction(event, true)]
    case 'context_snapshot': {
      const snapshot = deps.contextSnapshot(event)
      return snapshot ? [{ type: 'context_snapshot_received', payload: snapshot }] : []
    }
    case 'usage': {
      const usage = deps.usage(event)
      return usage ? [{ type: 'usage_received', payload: usage }] : []
    }
    case 'thread_updated':
      return [{
        type: 'thread_metadata_changed',
        payload: {
          threadId: event.threadId ?? '',
          ...(event.title !== undefined ? { title: event.title } : {}),
          ...(event.titleAuto !== undefined ? { titleAuto: event.titleAuto } : {}),
          ...(typeof event.status === 'string' ? { status: event.status } : {})
        }
      }]
    case 'turn_completed':
    case 'turn_aborted':
      if (event.child) {
        const tool = deps.childTool(event)
        return tool ? [{ type: 'tool_updated', payload: tool }] : []
      }
      return [{ type: 'turn_completed' }]
    case 'turn_failed': {
      if (event.child) {
        const tool = deps.childTool(event)
        return tool ? [{ type: 'tool_updated', payload: tool }] : []
      }
      const payload = deps.runtimeError(event, 'Kun turn failed')
      return [
        { type: 'runtime_error_received', payload },
        { type: 'turn_failed', error: deps.errorFromRuntime(payload), options: { terminal: true } }
      ]
    }
    case 'error':
      if (event.code === 'compaction_summary_fallback') {
        const status = deps.runtimeStatus(event)
        return status ? [{ type: 'runtime_status_received', payload: status }] : []
      }
      return [{ type: 'runtime_error_received', payload: deps.runtimeError(event, 'Runtime error') }]
    default:
      return []
  }
}
