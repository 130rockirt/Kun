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
import { runGit } from '../services/git-service'
import {
  PlanWorktreeCoordinator,
  PlanWorktreeCoordinatorError
} from '../services/plan-worktree-coordinator'
import { PlanWorktreeIntegration } from '../services/plan-worktree-integration'
import { createPlanWorktreeRuntimeCompletionVerifier } from '../services/plan-worktree-runtime-completion'
import { createPlanWorktreeRuntimeLinkResolver } from '../services/plan-worktree-runtime-link'
import { currentExecutionWorkspace } from '../services/plan-worktree-admission-fence'
import {
  matchesPlanWorktreeAdmission,
  matchesPlanWorktreeAdmissionBinding,
  planWorktreeForkRequest,
  planWorktreeStartTurnFingerprint,
  planWorktreeStartTurnRequest
} from '../services/plan-worktree-runtime-admission'
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
  const requirePlanBuildAdmissionBindingSupport = async (): Promise<void> => {
    const response = await options.runtimeRequest('/v1/runtime/info', 'GET')
    if (!response.ok) {
      throw new PlanWorktreeCoordinatorError(
        'runtime_unsupported',
        'Kun runtime is unavailable; cannot verify plan-build admission binding support.'
      )
    }
    let capabilities: { planBuildAdmissionBindingV1?: unknown } | undefined
    try {
      capabilities = (JSON.parse(response.body) as {
        capabilities?: { planBuildAdmissionBindingV1?: unknown }
      }).capabilities
    } catch {
      throw new PlanWorktreeCoordinatorError(
        'runtime_unsupported',
        'Kun runtime returned an invalid capability manifest.'
      )
    }
    if (capabilities?.planBuildAdmissionBindingV1 !== true) {
      throw new PlanWorktreeCoordinatorError(
        'runtime_unsupported',
        'Kun runtime does not support durable plan-build admission binding. Restart Kun to load the current runtime build.'
      )
    }
  }
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
  /**
   * Main owns the fork that carries the opaque admission capability. Keeping
   * this in the same host process as durable preparation prevents a renderer,
   * queued message, or external local client from claiming the deterministic
   * first post-fork turn before Main can submit its exact origin.
   */
  const ensureExecutionThread = async (
    input: PlanWorktreeRunRecord
  ): Promise<PlanWorktreeRunRecord> => locks.withLock(
    `execution-thread:${input.runId}`,
    async () => {
      const record = await coordinator.get(input.runId)
      if (!record) throw new Error(`Unknown plan worktree run: ${input.runId}`)
      if (record.status === 'completed' || record.status === 'cancelled') return record
      if (record.executionThreadId) return record
      if (record.status === 'needs_attention'
        && record.attentionReason !== 'thread_attach_failed'
        && record.attentionReason !== 'turn_admission_failed') {
        return record
      }
      const fork = planWorktreeForkRequest(record, currentExecutionWorkspace(record))
      if (!fork) {
        const message = 'This legacy run has no durable opaque admission capability.'
        await store.save({
          ...record,
          status: 'needs_attention',
          attentionReason: 'thread_attach_failed',
          attentionMessage: message,
          updatedAt: new Date().toISOString()
        })
        throw new PlanWorktreeCoordinatorError('thread_attach_failed', message)
      }
      try {
        const forked = await requireRuntimeJson(
          options.runtimeRequest,
          `/v1/threads/${encodeURIComponent(record.sourceThreadId)}/fork`,
          fork,
          ExecutionThreadIdentitySchema
        )
        if (!matchesPlanWorktreeAdmissionBinding(record, forked)) {
          throw new PlanWorktreeCoordinatorError(
            'thread_attach_failed',
            'Kun did not persist the durable plan-build admission binding.'
          )
        }
        return coordinator.attachThread({
          runId: record.runId,
          executionThreadId: forked.id
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        await store.save({
          ...record,
          status: 'needs_attention',
          attentionReason: 'thread_attach_failed',
          attentionMessage: message,
          updatedAt: new Date().toISOString()
        })
        throw new PlanWorktreeCoordinatorError('thread_attach_failed', message)
      }
    }
  )
  const prepareExecutionThread = async (
    request: Parameters<PlanWorktreeCoordinator['prepare']>[0]
  ): Promise<PlanWorktreeRunRecord> => {
    await requirePlanBuildAdmissionBindingSupport()
    const prepared = await coordinator.prepare(request)
    try {
      return await ensureExecutionThread(prepared)
    } catch {
      // Preserve the just-created worktree record for visible recovery rather
      // than making the renderer retry a raw, unauthenticated fork itself.
      return (await coordinator.get(prepared.runId)) ?? prepared
    }
  }

  ipcMain.handle('plan-worktree:preflight', async (_, payload: unknown) => {
    await requirePlanBuildAdmissionBindingSupport()
    return coordinator.preflight(parseIpcPayload(
      'plan-worktree:preflight',
      PlanWorktreePreflightRequestSchema,
      payload
    ))
  })
  ipcMain.handle('plan-worktree:prepare', async (_, payload: unknown) =>
    afterStartupRecovery(async () => publicRun(await prepareExecutionThread(parseIpcPayload(
      'plan-worktree:prepare', PlanWorktreePrepareRequestSchema, payload
    )))))
  ipcMain.handle('plan-worktree:attach-thread', async (_, payload: unknown) =>
    afterStartupRecovery(async () => publicRun(await coordinator.attachThread(parseIpcPayload(
      'plan-worktree:attach-thread', PlanWorktreeAttachThreadRequestSchema, payload
    )))))
  ipcMain.handle('plan-worktree:list', async (_, payload: unknown) =>
    afterStartupRecovery(async () => (await coordinator.list(parseIpcPayload(
      'plan-worktree:list', PlanWorktreeListRequestSchema, payload ?? {}
    ))).map(publicRun)))
  ipcMain.handle('plan-worktree:diagnostics', async () =>
    afterStartupRecovery(() => store.diagnostics()))
  ipcMain.handle('plan-worktree:get', async (_, payload: unknown) => {
    const request = parseIpcPayload(
      'plan-worktree:get',
      PlanWorktreeRunIdRequestSchema,
      payload
    )
    return afterStartupRecovery(async () => publicNullableRun(await coordinator.get(request.runId)))
  })
  ipcMain.handle('plan-worktree:reconcile', async (_, payload: unknown) => {
    const request = runIdRequest('plan-worktree:reconcile', payload)
    return afterStartupRecovery(async () => {
      let linked = await recoverExecutionLink(request.runId)
      if (!linked.executionThreadId) linked = await ensureExecutionThread(linked)
      const reconciled = linked.executionThreadId && linked.executionTurnId
        ? integration.reconcileExecution(request.runId)
        : linked
      return publicRun(await reconciled)
    })
  })
  ipcMain.handle('plan-worktree:backfill-admission-binding', async (_, payload: unknown) => {
    const request = runIdRequest('plan-worktree:backfill-admission-binding', payload)
    return afterStartupRecovery(() => locks.withLock(`admission:${request.runId}`, async () => {
      const record = await coordinator.get(request.runId)
      if (!record) {
        throw new PlanWorktreeCoordinatorError('thread_attach_failed', 'Unknown plan worktree run.')
      }
      if (!record.executionThreadId) {
        throw new PlanWorktreeCoordinatorError(
          'thread_attach_failed',
          'No execution thread exists to backfill.'
        )
      }
      if (!record.admissionCapability) {
        throw new PlanWorktreeCoordinatorError(
          'thread_attach_failed',
          'This legacy run has no durable opaque admission identity to backfill.'
        )
      }
      const fingerprint = planWorktreeStartTurnFingerprint(record)
      if (!fingerprint) {
        throw new PlanWorktreeCoordinatorError(
          'thread_attach_failed',
          'Cannot recompute the durable admission fingerprint for backfill.'
        )
      }
      await requireBackfillGitState(record)
      const response = await options.runtimeRequest(
        `/v1/threads/${encodeURIComponent(record.executionThreadId)}/plan-build-admission-binding`,
        'POST',
        JSON.stringify({
          planBuildRunId: record.runId,
          expectedWorkspace: currentExecutionWorkspace(record),
          planBuildAdmissionFingerprint: fingerprint,
          planBuildAdmissionCapability: record.admissionCapability
        })
      )
      if (!response.ok) {
        throw new PlanWorktreeCoordinatorError(
          'thread_attach_failed',
          typeof response.body === 'string' && response.body
            ? response.body
            : `Kun rejected the admission binding backfill (${response.status}).`
        )
      }
      return publicRun(record)
    }))
  })
  ipcMain.handle('plan-worktree:resume-admission', async (_, payload: unknown) => {
    const request = runIdRequest('plan-worktree:resume-admission', payload)
    return afterStartupRecovery(() => locks.withLock(`admission:${request.runId}`, async () => {
      let record = await recoverExecutionLink(request.runId)
      if (!record.executionThreadId) record = await ensureExecutionThread(record)
      if (record.executionTurnId) return publicRun(record)
      if (!record.executionThreadId) {
        throw new PlanWorktreeCoordinatorError(
          'thread_attach_failed',
          'The execution thread must be committed before admission can resume.'
        )
      }
      const start = planWorktreeStartTurnRequest(record)
      if (!start || !record.admissionCapability) {
        throw new PlanWorktreeCoordinatorError(
          'turn_admission_failed',
          'This legacy run has no durable opaque admission identity.'
        )
      }
      const lease = await options.acquireRuntimeRequestLease()
      await requireRuntimeOk(lease.request, `/v1/threads/${encodeURIComponent(record.executionThreadId)}/goal`, {
        objective: record.goalObjective,
        status: 'active'
      })
      const admitted = await requireRuntimeJson(
        lease.request,
        `/v1/threads/${encodeURIComponent(record.executionThreadId)}/turns`,
        start,
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
      return publicRun(record)
    }))
  })
  ipcMain.handle('plan-worktree:finalize', async (_, payload: unknown) => {
    const request = parseIpcPayload(
      'plan-worktree:finalize', PlanWorktreeFinalizeRequestSchema, payload
    )
    return afterStartupRecovery(async () => {
      await recoverExecutionLink(request.runId)
      return publicRun(await integration.finalize(request))
    })
  })
  ipcMain.handle('plan-worktree:retry-integration', async (_, payload: unknown) => {
    const request = runIdRequest('plan-worktree:retry-integration', payload)
    return afterStartupRecovery(async () => {
      await recoverExecutionLink(request.runId)
      return publicRun(await integration.retryIntegration(request.runId))
    })
  })
  ipcMain.handle('plan-worktree:continue-rebase', async (_, payload: unknown) => {
    const request = runIdRequest('plan-worktree:continue-rebase', payload)
    return afterStartupRecovery(async () => publicRun(await integration.continueRebase(request.runId)))
  })
  ipcMain.handle('plan-worktree:abort-rebase', async (_, payload: unknown) => {
    const request = runIdRequest('plan-worktree:abort-rebase', payload)
    return afterStartupRecovery(async () => publicRun(await integration.abortRebase(request.runId)))
  })
  ipcMain.handle('plan-worktree:safe-cancel', async (_, payload: unknown) => {
    const request = parseIpcPayload(
      'plan-worktree:safe-cancel', PlanWorktreeSafeCancelRequestSchema, payload
    )
    return afterStartupRecovery(async () => {
      await recoverDestructiveOwnership(request.runId, true)
      return publicRun(await integration.safeCancel(request))
    })
  })
  ipcMain.handle('plan-worktree:cleanup', async (_, payload: unknown) => {
    const request = runIdRequest('plan-worktree:cleanup', payload)
    return afterStartupRecovery(async () => {
      await recoverDestructiveOwnership(request.runId, false)
      return publicRun(await integration.cleanup(request.runId))
    })
  })
  ipcMain.handle('plan-worktree:discard', async (_, payload: unknown) => {
    const request = parseIpcPayload(
      'plan-worktree:discard', PlanWorktreeDiscardRequestSchema, payload
    )
    return afterStartupRecovery(async () => {
      await recoverDestructiveOwnership(request.runId, true)
      return publicRun(await integration.discard(request))
    })
  })
}

/** Do not expose Main's raw plan-build admission capability through IPC. */
function publicRun(record: PlanWorktreeRunRecord): PlanWorktreeRunRecord {
  const { admissionCapability: _admissionCapability, ...visible } = record
  return visible
}

function publicNullableRun(
  record: PlanWorktreeRunRecord | null
): PlanWorktreeRunRecord | null {
  return record ? publicRun(record) : null
}

/**
 * CAS pre-condition for backfill: the worktree must still be pristine so the
 * durable first turn has not started. Any divergence means the run must be
 * cancelled instead of silently repairing an already-executed build.
 */
async function requireBackfillGitState(record: PlanWorktreeRunRecord): Promise<void> {
  try {
    const status = (await runGit(record.worktreePath, ['status', '--porcelain'])).stdout.trim()
    if (status) {
      throw new PlanWorktreeCoordinatorError(
        'thread_attach_failed',
        'The plan worktree is not clean; cancel the run instead of backfilling admission.'
      )
    }
    const head = (await runGit(record.worktreePath, ['rev-parse', 'HEAD'])).stdout.trim()
    if (!head || head !== record.baseCommit) {
      throw new PlanWorktreeCoordinatorError(
        'thread_attach_failed',
        'The plan worktree HEAD moved from its base commit; cancel the run instead of backfilling admission.'
      )
    }
    const ahead = (await runGit(record.worktreePath, ['rev-list', '--count', `${record.baseCommit}..HEAD`])).stdout.trim()
    if (ahead !== '0') {
      throw new PlanWorktreeCoordinatorError(
        'thread_attach_failed',
        'The plan worktree contains commits ahead of its base; cancel the run instead of backfilling admission.'
      )
    }
  } catch (error) {
    if (error instanceof PlanWorktreeCoordinatorError) throw error
    throw new PlanWorktreeCoordinatorError(
      'thread_attach_failed',
      `Could not verify the plan worktree git state: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  }
}

async function requireRuntimeOk(
  request: RegisterAppIpcHandlersOptions['runtimeRequest'],
  path: string,
  body: unknown
): Promise<void> {
  const response = await request(path, 'POST', JSON.stringify(body))
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
  request: RegisterAppIpcHandlersOptions['runtimeRequest'],
  path: string,
  body: unknown,
  schema: z.ZodType<T>
): Promise<T> {
  const response = await request(path, 'POST', JSON.stringify(body))
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
  planBuildAdmissionFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  planBuildAdmissionCapabilityHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  forkedFromTurnCount: z.number().int().nonnegative().optional(),
  turns: z.array(z.object({
    id: z.string().min(1),
    clientRequestId: z.string().optional(),
    clientRequestFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
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
      || thread.workspace !== currentExecutionWorkspace(record)
      || thread.relation !== 'side'
      || thread.parentThreadId !== record.sourceThreadId
      || thread.planBuildRunId !== record.runId) {
      throw new PlanWorktreeCoordinatorError(
        'thread_attach_failed',
        'The execution thread does not match the durable plan-worktree identity.'
      )
    }
    if (!matchesPlanWorktreeAdmissionBinding(record, thread)) {
      throw new PlanWorktreeCoordinatorError(
        'thread_attach_failed',
        'The execution thread does not match the durable plan-build admission binding.'
      )
    }
    if (request.executionTurnId) {
      const boundary = thread.forkedFromTurnCount
      const origin = boundary === undefined ? undefined : thread.turns[boundary]
      const matchesAdmission = origin && matchesPlanWorktreeAdmission(record, origin)
      if (!matchesAdmission || request.executionTurnId !== origin.id) {
        throw new PlanWorktreeCoordinatorError(
          'thread_attach_failed',
          'The attached turn is not the first admitted turn after the fork boundary.'
        )
      }
    }
  }
}
