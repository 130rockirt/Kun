import type { TurnItem } from '../contracts/items.js'
import { makeToolResultItem } from '../domain/item.js'
import { CREATE_PLAN_TOOL_NAME } from '../adapters/tool/create-plan-tool.js'
import type { ToolCallLike, ToolHost, ToolHostContext, ToolHostResult } from '../ports/tool-host.js'
import type { RuntimeEventRecorder } from '../services/runtime-event-recorder.js'
import type { TurnService } from '../services/turn-service.js'
import { InflightTracker } from './inflight-tracker.js'
import { prepareBrowserUseToolResultForPersistence } from './tool-result-image.js'

export type PlanWrittenCallback = (input: {
  threadId: string
  turnId: string
  planId: string
  relativePath: string
  markdown: string
}) => Promise<void>

export type ToolExecutionServiceDeps = {
  toolHost: ToolHost
  inflight: InflightTracker
  turns: TurnService
  events: RuntimeEventRecorder
  nowIso: () => string
  onPlanWritten?: PlanWrittenCallback
  awaitWorkspaceCheckpoint?: (
    checkpointRequestId: string,
    signal: AbortSignal
  ) => Promise<string | null>
}

export type ToolExecutionInput = {
  threadId: string
  turnId: string
  call: ToolCallLike
  context: ToolHostContext
}

/**
 * Executes an already-persisted tool call and persists its result. Batch and
 * storm policy remain with the dispatcher; this service owns only execution,
 * partial updates, error normalization, and result-side plan integration.
 */
export class ToolExecutionService {
  private readonly checkpointGates = new Map<string, Promise<void>>()

  constructor(private readonly deps: ToolExecutionServiceDeps) {}

  async executeSafely(input: ToolExecutionInput): Promise<ToolHostResult> {
    try {
      return await this.execute(input)
    } catch (error) {
      if (input.context.abortSignal.aborted) throw error
      const message = error instanceof Error ? error.message : String(error)
      await this.deps.events.record({
        kind: 'error',
        threadId: input.threadId,
        turnId: input.turnId,
        message: `Tool call ${input.call.toolName} failed: ${message}`,
        code: 'tool_execution_failed',
        severity: 'warning'
      })
      return {
        item: makeToolResultItem({
          id: `item_${input.call.callId}`,
          turnId: input.turnId,
          threadId: input.threadId,
          callId: input.call.callId,
          toolName: input.call.toolName,
          toolKind: input.call.toolKind ?? 'tool_call',
          output: {
            code: 'tool_execution_failed',
            error: message,
            guidance:
              'The tool crashed while executing. Adjust the arguments or take a different approach instead of retrying the identical call.'
          },
          isError: true
        }),
        approved: false
      }
    }
  }

  async persistResult(
    threadId: string,
    turnId: string,
    call: ToolCallLike,
    result: ToolHostResult
  ): Promise<void> {
    await this.deps.turns.updateItem(threadId, `item_tool_${turnId}_${call.callId}`, {
      status: result.item.kind === 'tool_result' && result.item.isError ? 'failed' : 'completed',
      finishedAt: this.deps.nowIso()
    } as Partial<TurnItem>)
    await this.deps.turns.applyItem(
      threadId,
      prepareBrowserUseToolResultForPersistence(result.item)
    )
    await this.afterResultPersisted(threadId, turnId, call, result)
  }

  async persistSuppressed(input: {
    threadId: string
    turnId: string
    call: ToolCallLike
    reason?: string
  }): Promise<void> {
    const item = makeToolResultItem({
      id: `item_${input.call.callId}_storm`,
      turnId: input.turnId,
      threadId: input.threadId,
      callId: input.call.callId,
      toolName: input.call.toolName,
      toolKind: input.call.toolKind ?? 'tool_call',
      output: { error: input.reason ?? 'duplicate tool call suppressed by repeat-loop guard' },
      isError: true
    })
    const message = input.reason ?? 'duplicate tool call suppressed by repeat-loop guard'
    await this.deps.turns.updateItem(input.threadId, `item_tool_${input.turnId}_${input.call.callId}`, {
      status: 'failed',
      finishedAt: this.deps.nowIso()
    } as Partial<TurnItem>)
    await this.deps.turns.applyItem(input.threadId, item)
    await this.deps.events.record({
      kind: 'tool_storm_suppressed',
      threadId: input.threadId,
      turnId: input.turnId,
      itemId: item.id,
      toolName: input.call.toolName,
      callId: input.call.callId,
      message
    })
  }

  private async execute(input: ToolExecutionInput): Promise<ToolHostResult> {
    return this.deps.inflight.run(
      {
        id: `inflight_${input.threadId}_${input.turnId}_${input.call.callId}`,
        kind: 'tool',
        threadId: input.threadId,
        turnId: input.turnId,
        callId: input.call.callId
      },
      async () => {
        try {
          await this.ensureWorkspaceCheckpoint(input)
          let acceptingUpdates = true
          let updateFailure: unknown
          let pendingUpdates = Promise.resolve()
          let result: ToolHostResult
          try {
            result = await this.deps.toolHost.execute(input.call, input.context, (item) => {
              if (!acceptingUpdates) return
              const update = pendingUpdates.then(async () => {
                const existing = await this.deps.turns.updateItem(input.threadId, item.id, {
                  output: item.kind === 'tool_result' ? item.output : undefined,
                  isError: item.kind === 'tool_result' ? item.isError : undefined,
                  status: 'running'
                } as Partial<TurnItem>)
                if (existing) return
                await this.deps.turns.applyItem(input.threadId, item)
              })
              pendingUpdates = update.catch((error) => {
                updateFailure ??= error
              })
              return update
            })
          } finally {
            // Tool progress is scoped to the execute() promise. Detached work
            // may keep a callback reference, but it must not regress an already
            // completed tool_result back to "running".
            acceptingUpdates = false
            await pendingUpdates
          }
          if (updateFailure) throw updateFailure
          await this.recordSourceToolPage(input, result)
          return result
        } catch (error) {
          if (input.context.abortSignal.aborted || !isRecoverableToolDispatchError(error)) {
            throw error
          }
          const message = error instanceof Error ? error.message : String(error)
          const planActive = input.context.threadMode === 'plan' || Boolean(input.context.guiPlan)
          const guidance = input.call.toolName.startsWith('ppt_master_')
            ? 'PPT Master is not active in this turn. Call `load_skill` once with `skill_id: "ppt-master"`, then retry the managed PPT tool on the next model step after the tool catalog refreshes. If it remains unavailable, stop and report the problem. Never run PPT Master scripts through `bash`, `background_shell`, or direct Python.'
            : planActive
            ? `\`${input.call.toolName}\` is not available in Plan mode. Continue with advertised read-only tools, \`git_inspect\`, or \`write\`/\`edit\` for Markdown only. Call \`create_plan\` and put a COMPLETE implementation plan in its \`markdown\` argument — concrete steps, the files to create with their intended contents, and how to verify. Do NOT copy this message into the plan; write the actual plan. If the request is still ambiguous, ask the user a clarifying question and wait instead.`
            : 'Use only tools advertised in the current turn context.'
          await this.deps.events.record({
            kind: 'error',
            threadId: input.threadId,
            turnId: input.turnId,
            message: `Tool call ${input.call.toolName} was rejected: ${message}`,
            code: 'tool_dispatch_rejected',
            severity: 'warning'
          })
          return {
            item: makeToolResultItem({
              id: `item_${input.call.callId}`,
              turnId: input.turnId,
              threadId: input.threadId,
              callId: input.call.callId,
              toolName: input.call.toolName,
              toolKind: input.call.toolKind ?? 'tool_call',
              output: { code: 'tool_dispatch_rejected', error: message, guidance },
              isError: true
            }),
            approved: false
          }
        }
      }
    )
  }

  private async recordSourceToolPage(input: ToolExecutionInput, result: ToolHostResult): Promise<void> {
    const toolName = input.call.toolName
    if (!['read', 'grep', 'glob', 'find'].includes(toolName)) return
    const output = result.item.kind === 'tool_result' && result.item.output && typeof result.item.output === 'object'
      ? result.item.output as Record<string, unknown> : undefined
    if (!output) return
    const hasMore = output.has_more === true
    const continuation = typeof output.next_offset === 'number'
      ? 'offset' as const
      : typeof output.next_cursor === 'string' ? 'cursor' as const : 'none' as const
    await this.deps.events.record({
      kind: 'source_tool_page',
      threadId: input.threadId,
      turnId: input.turnId,
      toolName: toolName as 'read' | 'grep' | 'glob' | 'find',
      callId: input.call.callId,
      hasMore,
      continuation,
      ...(input.context.sourceResultBudgetTokens !== undefined
        ? { budgetTokens: input.context.sourceResultBudgetTokens }
        : {})
    })
  }

  private async ensureWorkspaceCheckpoint(input: ToolExecutionInput): Promise<void> {
    const requestId = input.context.workspaceCheckpointRequestId?.trim()
    if (
      !requestId ||
      !this.deps.awaitWorkspaceCheckpoint ||
      (input.call.toolKind !== 'file_change' && input.call.toolKind !== 'command_execution')
    ) return

    const key = `${input.turnId}:${requestId}`
    let gate = this.checkpointGates.get(key)
    if (!gate) {
      gate = (async () => {
        const checkpointId = await this.deps.awaitWorkspaceCheckpoint!(
          requestId,
          input.context.abortSignal
        )
        if (!checkpointId) return
        await this.deps.turns.updateTurnMetadata(input.threadId, input.turnId, {
          workspaceCheckpointId: checkpointId
        })
        await this.deps.turns.updateItem(
          input.threadId,
          `item_${input.turnId}_user`,
          { workspaceCheckpointId: checkpointId }
        )
      })()
      this.checkpointGates.set(key, gate)
      if (this.checkpointGates.size > 512) {
        const oldest = this.checkpointGates.keys().next().value
        if (oldest !== undefined) this.checkpointGates.delete(oldest)
      }
    }
    await gate
  }

  private async afterResultPersisted(
    threadId: string,
    turnId: string,
    call: ToolCallLike,
    result: ToolHostResult
  ): Promise<void> {
    if (call.toolName !== CREATE_PLAN_TOOL_NAME) return
    if (result.item.kind !== 'tool_result' || result.item.isError === true) return
    const output = result.item.output
    if (!output || typeof output !== 'object') return
    const record = output as Record<string, unknown>
    const planId = typeof record.plan_id === 'string' ? record.plan_id : ''
    const relativePath = typeof record.relative_path === 'string' ? record.relative_path : ''
    const markdown = typeof call.arguments.markdown === 'string' ? call.arguments.markdown : ''
    if (!planId || !relativePath || !markdown) return
    try {
      await this.deps.onPlanWritten?.({ threadId, turnId, planId, relativePath, markdown })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await this.deps.events.record({
        kind: 'error',
        threadId,
        turnId,
        message: `Failed to sync plan checklist to thread todos: ${message}`,
        code: 'todo_plan_sync_failed',
        severity: 'warning'
      })
    }
  }
}

function isRecoverableToolDispatchError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.startsWith('unknown tool:') ||
    message.includes(' is not provided by ') ||
    message.includes(' is not advertised') ||
    message.includes(' is disabled by policy')
}
