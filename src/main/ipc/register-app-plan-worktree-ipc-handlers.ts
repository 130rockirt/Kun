import { createHash } from 'node:crypto'
import { ipcMain } from 'electron'
import { z } from 'zod'
import {
  PlanWorktreeAttachThreadRequestSchema,
  PlanWorktreeDiscardRequestSchema,
  PlanWorktreeFinalizeRequestSchema,
  PlanWorktreeListRequestSchema,
  PlanWorktreePreflightRequestSchema,
  PlanWorktreePrepareRequestSchema,
  PlanWorktreeRunIdRequestSchema,
  PlanWorktreeSafeCancelRequestSchema
} from '../../shared/plan-worktree'
import type {
  PlanWorktreeAttachThreadRequest,
  PlanWorktreeRunRecord
} from '../../shared/plan-worktree'
import type { RegisterAppIpcHandlersOptions } from './app-ipc-handler-options'
import { parseIpcPayload } from './app-ipc-handler-utils'
import {
  PlanWorktreeCoordinator,
  PlanWorktreeCoordinatorError
} from '../services/plan-worktree-coordinator'
import { PlanWorktreeIntegration } from '../services/plan-worktree-integration'
import { createPlanWorktreeRuntimeCompletionVerifier } from '../services/plan-worktree-runtime-completion'
import { createPlanWorktreeRuntimeLinkResolver } from '../services/plan-worktree-runtime-link'
import {
  PlanWorktreeLockManager,
  PlanWorktreeRunStore
} from '../services/plan-worktree-run-store'

export function registerAppPlanWorktreeIpcHandlers(
  options: RegisterAppIpcHandlersOptions
): void {
  // Production registration always supplies this host-owned path. Lightweight
  // unit harnesses that register the legacy IPC surface without app identity
  // intentionally skip durable plan-worktree handlers.
  if (!options.userDataPath) return
  const userDataPath = options.userDataPath
  const store = new PlanWorktreeRunStore(userDataPath)
  const locks = new PlanWorktreeLockManager()
  const coordinator = new PlanWorktreeCoordinator({
    store,
    locks,
    verifyExecutionThread: createExecutionThreadIdentityVerifier(options),
    recoverExecutionLink: createPlanWorktreeRuntimeLinkResolver(options.runtimeRequest)
  })
  const integration = new PlanWorktreeIntegration({
    store,
    locks,
    verifyCompletion: createPlanWorktreeRuntimeCompletionVerifier(options.runtimeRequest),
    setAdmissionFence: async (request) => {
      const response = await options.runtimeRequest(
        `/v1/threads/${encodeURIComponent(request.threadId)}/plan-build-admission-fence`,
        'POST',
        JSON.stringify({
          planBuildRunId: request.planBuildRunId,
          expectedWorkspace: request.expectedWorkspace,
          frozen: request.frozen,
          ...(request.workspace ? { workspace: request.workspace } : {})
        })
      )
      if (!response.ok) {
        throw new Error(
          typeof response.body === 'string' && response.body
            ? response.body
            : `Kun rejected the plan-build admission fence (${response.status}).`
        )
      }
    },
    rebindThreadWorkspace: async (threadId, workspaceRoot) => {
      const response = await options.runtimeRequest(
        `/v1/threads/${encodeURIComponent(threadId)}`,
        'PATCH',
        JSON.stringify({ workspace: workspaceRoot })
      )
      if (!response.ok) {
        throw new Error(
          typeof response.body === 'string'
            ? response.body
            : 'Failed to rebind the execution thread workspace.'
        )
      }
    }
  })

  const startupRecovery = coordinator.reconcileStartup()
    .then(() => ({ error: undefined }))
    .catch((error: unknown) => {
      options.logError(
        'plan-worktree-recovery',
        'Failed to reconcile unfinished plan worktree preparation records.',
        error
      )
      return { error }
    })
  const afterStartupRecovery = async <T>(operation: () => Promise<T>): Promise<T> => {
    const recovery = await startupRecovery
    if (recovery.error) throw recovery.error
    return operation()
  }
  const recoverExecutionLink = async (runId: string): Promise<PlanWorktreeRunRecord> =>
    coordinator.reconcileExecutionLink(runId)
  const requireRecoveredThread = async (runId: string): Promise<PlanWorktreeRunRecord> => {
    const record = await recoverExecutionLink(runId)
    if (!record.executionThreadId || (record.status === 'needs_attention'
      && (record.attentionReason === 'thread_attach_failed'
        || record.attentionReason === 'external_state_changed'))) {
      throw new PlanWorktreeCoordinatorError(
        'thread_attach_failed',
        'Kun could not prove whether this run owns an execution thread.'
      )
    }
    // Re-query the concrete thread even when discovery did not mutate the
    // record, so destructive actions cannot proceed while Kun is offline.
    return coordinator.attachThread({
      runId: record.runId,
      executionThreadId: record.executionThreadId,
      ...(record.executionTurnId ? { executionTurnId: record.executionTurnId } : {}),
      ...(record.graphRunId ? { graphRunId: record.graphRunId } : {})
    })
  }
  const recoverDestructiveOwnership = async (
    runId: string,
    allowProvenAbsent: boolean
  ): Promise<PlanWorktreeRunRecord> => {
    const ownership = await coordinator.reconcileExecutionOwnership(runId)
    if (ownership.record.executionThreadId) return requireRecoveredThread(runId)
    if (allowProvenAbsent && ownership.threadAbsent) return ownership.record
    throw new PlanWorktreeCoordinatorError(
      'thread_attach_failed',
      'Kun could not prove whether this run owns an execution thread.'
    )
  }

  ipcMain.handle('plan-worktree:preflight', async (_, payload: unknown) =>
    coordinator.preflight(parseIpcPayload(
      'plan-worktree:preflight',
      PlanWorktreePreflightRequestSchema,
      payload
    )))
  ipcMain.handle('plan-worktree:prepare', async (_, payload: unknown) =>
    afterStartupRecovery(() => coordinator.prepare(parseIpcPayload(
      'plan-worktree:prepare', PlanWorktreePrepareRequestSchema, payload
    ))))
  ipcMain.handle('plan-worktree:attach-thread', async (_, payload: unknown) =>
    afterStartupRecovery(() => coordinator.attachThread(parseIpcPayload(
      'plan-worktree:attach-thread', PlanWorktreeAttachThreadRequestSchema, payload
    ))))
  ipcMain.handle('plan-worktree:list', async (_, payload: unknown) =>
    afterStartupRecovery(() => coordinator.list(parseIpcPayload(
      'plan-worktree:list', PlanWorktreeListRequestSchema, payload ?? {}
    ))))
  ipcMain.handle('plan-worktree:diagnostics', async () =>
    afterStartupRecovery(() => store.diagnostics()))
  ipcMain.handle('plan-worktree:get', async (_, payload: unknown) => {
    const request = parseIpcPayload(
      'plan-worktree:get',
      PlanWorktreeRunIdRequestSchema,
      payload
    )
    return afterStartupRecovery(() => coordinator.get(request.runId))
  })
  ipcMain.handle('plan-worktree:reconcile', async (_, payload: unknown) => {
    const request = runIdRequest('plan-worktree:reconcile', payload)
    return afterStartupRecovery(async () => {
      const linked = await recoverExecutionLink(request.runId)
      return linked.executionThreadId && linked.executionTurnId
        ? integration.reconcileExecution(request.runId)
        : linked
    })
  })
  ipcMain.handle('plan-worktree:resume-admission', async (_, payload: unknown) => {
    const request = runIdRequest('plan-worktree:resume-admission', payload)
    return afterStartupRecovery(async () => {
      let record = await recoverExecutionLink(request.runId)
      if (record.executionTurnId) return record
      if (!record.executionThreadId) {
        throw new PlanWorktreeCoordinatorError(
          'thread_attach_failed',
          'The execution thread must be committed before admission can resume.'
        )
      }
      if (!record.executionPrompt || !record.executionDisplayText
        || !record.admissionClientRequestId) {
        throw new PlanWorktreeCoordinatorError(
          'turn_admission_failed',
          'This legacy run has no durable execution prompt or admission identity.'
        )
      }
      await requireRuntimeOk(options, `/v1/threads/${encodeURIComponent(record.executionThreadId)}/goal`, {
        objective: record.goalObjective,
        status: 'active'
      })
      const admitted = await requireRuntimeJson(
        options,
        `/v1/threads/${encodeURIComponent(record.executionThreadId)}/turns`,
        {
          prompt: record.executionPrompt,
          displayText: record.executionDisplayText,
          clientRequestId: record.admissionClientRequestId,
          mode: 'agent',
          orchestration: record.orchestration,
          clientSurface: 'gui',
          agentSurface: 'code'
        },
        z.object({
          threadId: z.string().min(1),
          turnId: z.string().min(1)
        }).passthrough()
      )
      if (admitted.threadId !== record.executionThreadId) {
        throw new PlanWorktreeCoordinatorError(
          'turn_admission_failed',
          'Kun admitted the durable plan prompt on a different thread.'
        )
      }
      record = await coordinator.attachThread({
        runId: record.runId,
        executionThreadId: record.executionThreadId,
        executionTurnId: admitted.turnId
      })
      return record
    })
  })
  ipcMain.handle('plan-worktree:finalize', async (_, payload: unknown) => {
    const request = parseIpcPayload(
      'plan-worktree:finalize', PlanWorktreeFinalizeRequestSchema, payload
    )
    return afterStartupRecovery(async () => {
      await recoverExecutionLink(request.runId)
      return integration.finalize(request)
    })
  })
  ipcMain.handle('plan-worktree:retry-integration', async (_, payload: unknown) => {
    const request = runIdRequest('plan-worktree:retry-integration', payload)
    return afterStartupRecovery(async () => {
      await recoverExecutionLink(request.runId)
      return integration.retryIntegration(request.runId)
    })
  })
  ipcMain.handle('plan-worktree:continue-rebase', async (_, payload: unknown) => {
    const request = runIdRequest('plan-worktree:continue-rebase', payload)
    return afterStartupRecovery(() => integration.continueRebase(request.runId))
  })
  ipcMain.handle('plan-worktree:abort-rebase', async (_, payload: unknown) => {
    const request = runIdRequest('plan-worktree:abort-rebase', payload)
    return afterStartupRecovery(() => integration.abortRebase(request.runId))
  })
  ipcMain.handle('plan-worktree:safe-cancel', async (_, payload: unknown) => {
    const request = parseIpcPayload(
      'plan-worktree:safe-cancel', PlanWorktreeSafeCancelRequestSchema, payload
    )
    return afterStartupRecovery(async () => {
      await recoverDestructiveOwnership(request.runId, true)
      return integration.safeCancel(request)
    })
  })
  ipcMain.handle('plan-worktree:cleanup', async (_, payload: unknown) => {
    const request = runIdRequest('plan-worktree:cleanup', payload)
    return afterStartupRecovery(async () => {
      await recoverDestructiveOwnership(request.runId, false)
      return integration.cleanup(request.runId)
    })
  })
  ipcMain.handle('plan-worktree:discard', async (_, payload: unknown) => {
    const request = parseIpcPayload(
      'plan-worktree:discard', PlanWorktreeDiscardRequestSchema, payload
    )
    return afterStartupRecovery(async () => {
      await recoverDestructiveOwnership(request.runId, true)
      return integration.discard(request)
    })
  })
}

async function requireRuntimeOk(
  options: RegisterAppIpcHandlersOptions,
  path: string,
  body: unknown
): Promise<void> {
  const response = await options.runtimeRequest(path, 'POST', JSON.stringify(body))
  if (!response.ok) {
    throw new PlanWorktreeCoordinatorError(
      'turn_admission_failed',
      typeof response.body === 'string' && response.body
        ? response.body
        : `Kun rejected durable admission (${response.status}).`
    )
  }
}

async function requireRuntimeJson<T>(
  options: RegisterAppIpcHandlersOptions,
  path: string,
  body: unknown,
  schema: z.ZodType<T>
): Promise<T> {
  const response = await options.runtimeRequest(path, 'POST', JSON.stringify(body))
  if (!response.ok) {
    throw new PlanWorktreeCoordinatorError(
      'turn_admission_failed',
      typeof response.body === 'string' && response.body
        ? response.body
        : `Kun rejected durable admission (${response.status}).`
    )
  }
  try {
    return schema.parse(JSON.parse(response.body))
  } catch {
    throw new PlanWorktreeCoordinatorError(
      'turn_admission_failed',
      'Kun returned an invalid durable admission response.'
    )
  }
}

function runIdRequest(channel: string, payload: unknown): { runId: string } {
  return parseIpcPayload(channel, PlanWorktreeRunIdRequestSchema, payload)
}

const ExecutionThreadIdentitySchema = z.object({
  id: z.string().min(1),
  workspace: z.string().min(1),
  relation: z.enum(['primary', 'fork', 'side']),
  parentThreadId: z.string().optional(),
  planBuildRunId: z.string().optional(),
  forkedFromTurnCount: z.number().int().nonnegative().optional(),
  turns: z.array(z.object({
    id: z.string().min(1),
    clientRequestId: z.string().optional(),
    prompt: z.string().optional(),
    orchestration: z.enum(['direct', 'graph']).default('direct'),
    agentSurface: z.enum(['code', 'write', 'design']).optional()
  }).passthrough()).default([])
}).passthrough()

function createExecutionThreadIdentityVerifier(options: RegisterAppIpcHandlersOptions) {
  return async (
    record: PlanWorktreeRunRecord,
    request: PlanWorktreeAttachThreadRequest
  ): Promise<void> => {
    const response = await options.runtimeRequest(
      `/v1/threads/${encodeURIComponent(request.executionThreadId)}`,
      'GET'
    )
    if (!response.ok) {
      throw new PlanWorktreeCoordinatorError(
        'thread_attach_failed',
        `Failed to verify the execution thread (${response.status}).`
      )
    }
    let raw: unknown
    try {
      raw = JSON.parse(response.body) as unknown
    } catch {
      throw new PlanWorktreeCoordinatorError(
        'thread_attach_failed',
        'Kun returned an invalid execution-thread identity response.'
      )
    }
    const parsed = ExecutionThreadIdentitySchema.safeParse(raw)
    if (!parsed.success) {
      throw new PlanWorktreeCoordinatorError(
        'thread_attach_failed',
        'Kun returned an invalid execution-thread identity response.'
      )
    }
    const thread = parsed.data
    if (thread.id !== request.executionThreadId
      || thread.workspace !== (record.cleanup.threadRebound
        ? record.sourceWorkspaceRoot
        : record.executionWorkspace ?? record.worktreePath)
      || thread.relation !== 'side'
      || thread.parentThreadId !== record.sourceThreadId
      || thread.planBuildRunId !== record.runId) {
      throw new PlanWorktreeCoordinatorError(
        'thread_attach_failed',
        'The execution thread does not match the durable plan-worktree identity.'
      )
    }
    if (request.executionTurnId) {
      const boundary = thread.forkedFromTurnCount
      const origin = boundary === undefined ? undefined : thread.turns[boundary]
      const matchesAdmission = origin && record.admissionClientRequestId
        && record.executionPromptSha256
        && origin.clientRequestId === record.admissionClientRequestId
        && origin.orchestration === record.orchestration
        && origin.agentSurface === 'code'
        && typeof origin.prompt === 'string'
        && createHash('sha256').update(origin.prompt).digest('hex')
          === record.executionPromptSha256
      if (!matchesAdmission || request.executionTurnId !== origin.id) {
        throw new PlanWorktreeCoordinatorError(
          'thread_attach_failed',
          'The attached turn is not the first admitted turn after the fork boundary.'
        )
      }
    }
  }
}
