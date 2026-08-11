import { chmod, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import {
  ModelReasoningEffort,
  SubagentProfileConfig,
  SubagentToolPolicy,
  type SubagentMode,
  type SubagentsCapabilityConfig
} from '../contracts/capabilities.js'
import {
  ApprovalPolicySchema,
  ApprovalReviewerSchema,
  DEFAULT_APPROVAL_REVIEWER,
  SandboxModeSchema,
  type ApprovalPolicy,
  type ApprovalReviewer,
  type SandboxMode
} from '../contracts/policy.js'
import type { RuntimeEventRecorder } from '../services/runtime-event-recorder.js'
import type { UsageSnapshot } from '../contracts/usage.js'
import type { TurnClientSurface } from '../contracts/turns.js'
import {
  ChildRunActivity,
  type ChildRunActivity as ChildRunActivityValue,
  type RuntimeEvent
} from '../contracts/events.js'
import type { EventBus } from '../ports/event-bus.js'
import type { ThreadStore } from '../ports/thread-store.js'
import type { TurnService } from '../services/turn-service.js'
import { loadWorkspaceAgentProfiles } from './workspace-agents.js'
import type { SubagentRoutingDocument } from './subagent-router.js'
import { BUILTIN_SUBAGENT_PROFILES } from './builtin-profiles.js'
import { BUILTIN_AGENT_CATALOG_BY_ID } from './builtin-agent-catalog.js'
import { resolveTurnClientSurface } from '../loop/turn-context-resolver.js'
import { AtomicJsonFile, isManagerAtomicJsonPath } from '../extensions/atomic-json.js'
import { withManagerDataMutex } from '../manager/data-mutex.js'
import {
  ChildRunRecord,
  ChildSecuritySnapshot,
  type ChildReturnFormat,
  type ChildRunExecutor,
  type ChildRunLifecycleMetadata
} from './delegation-runtime-contracts.js'
import { DelegationRuntimeRun } from './delegation-runtime-run.js'
import type { ChildExecutionState } from './delegation-runtime-base.js'
import { childResultOwnerIds } from './child-result-materializer.js'
import {
  addChildUsage,
  childActivityFromEvent,
  childContractError,
  childLifecycleMetadata,
  completeModelProviderPair,
  defaultExecutor,
  elapsedMs,
  errorMessage,
  executeWithParentSignal,
  fingerprintProfile,
  intersectChildSecurity,
  isNotFound,
  normalizeInheritedReasoningEffort,
  notifyLifecycle,
  persistedReviewIdentityError,
  resolveChildModelSelection,
  sameChildActivity,
  sameModelRoute
} from './delegation-runtime-support.js'

export class DelegationRuntime extends DelegationRuntimeRun {
  /**
   * Reclaim child-run projections and linked result artifacts for a deleted
   * parent or side thread. Every operation is idempotent so nested side-thread
   * deletion and a partially completed prior attempt are safe.
   */
  async cleanupThreadDeletion(
    threadId: string,
    deleteSideThread?: (childId: string) => Promise<boolean>
  ): Promise<number> {
    const children = await this.options.store.list(threadId)
    await this.releaseArtifactOwner(`thread:${threadId}`)
    await this.releaseArtifactOwner(`child:${threadId}`)
    await this.options.store.delete(threadId).catch(() => undefined)
    for (const child of children) {
      if (child.id !== threadId) {
        await deleteSideThread?.(child.id).catch(() => false)
      }
      for (const ownerId of childResultOwnerIds(threadId, child.id)) {
        await this.releaseArtifactOwner(ownerId)
      }
      await this.options.store.delete(child.id).catch(() => undefined)
    }
    return children.length
  }

  private async releaseArtifactOwner(ownerId: string): Promise<void> {
    try {
      await this.options.artifactStore?.releaseOwner?.(ownerId)
    } catch (error) {
      console.warn(
        `[kun] linked child artifact cleanup failed owner=${ownerId}: ${errorMessage(error)}`
      )
    }
  }

  async resumeChild(input: {
    childId: string
    parentThreadId: string
    parentTurnId: string
    prompt: string
    expectedProfile?: string
    expectedWorkflowId?: string
    /** Current parent boundary; the resumed child receives its intersection with the stored snapshot. */
    security?: ChildSecuritySnapshot
    signal: AbortSignal
    onQueued?: (childId: string, profile?: string, metadata?: ChildRunLifecycleMetadata) => Promise<void> | void
    onRunning?: (childId: string, profile?: string, metadata?: ChildRunLifecycleMetadata) => Promise<void> | void
  }): Promise<ChildRunRecord> {
    if (this.resumingChildren.has(input.childId)) {
      throw new Error(`child run ${input.childId} is still running`)
    }
    this.resumingChildren.add(input.childId)
    try {
      return await this.resumeChildExclusive(input)
    } finally {
      this.resumingChildren.delete(input.childId)
    }
  }

  private async resumeChildExclusive(input: {
    childId: string
    parentThreadId: string
    parentTurnId: string
    prompt: string
    expectedProfile?: string
    expectedWorkflowId?: string
    security?: ChildSecuritySnapshot
    signal: AbortSignal
    onQueued?: (childId: string, profile?: string, metadata?: ChildRunLifecycleMetadata) => Promise<void> | void
    onRunning?: (childId: string, profile?: string, metadata?: ChildRunLifecycleMetadata) => Promise<void> | void
  }): Promise<ChildRunRecord> {
    const previous = await this.options.store.get(input.childId)
    if (!previous) throw new Error(`child run ${input.childId} was not found`)
    if (previous.parentThreadId !== input.parentThreadId) {
      throw new Error(`child run ${input.childId} does not belong to this parent thread`)
    }
    if (previous.status === 'queued' || previous.status === 'running') {
      throw new Error(`child run ${input.childId} is still running`)
    }
    if (input.expectedProfile && previous.profile !== input.expectedProfile) {
      throw new Error(`child run ${input.childId} is not a ${input.expectedProfile} child`)
    }
    if (input.expectedWorkflowId) {
      const reviewIdentityError = persistedReviewIdentityError(
        previous.reviewBundle,
        previous.id,
        input.expectedWorkflowId
      )
      if (reviewIdentityError) throw new Error(reviewIdentityError)
    }
    const profileSnapshot = previous.profileSnapshot
    const storedSecurity = previous.security
    if (!profileSnapshot || !storedSecurity || !previous.workspace) {
      throw new Error(`child run ${input.childId} lacks a resumable security/profile snapshot`)
    }
    const security = input.security
      ? intersectChildSecurity(storedSecurity, ChildSecuritySnapshot.parse(input.security))
      : storedSecurity
    const workspace = security.sandboxRoot
    if (input.signal.aborted) throw new Error('child resume aborted before start')

    const queuedAt = this.now()
    const record = ChildRunRecord.parse({
      ...previous,
      prompt: input.prompt,
      parentTurnId: input.parentTurnId,
      status: 'queued',
      summary: undefined,
      evidence: undefined,
      error: undefined,
      activity: undefined,
      detached: undefined,
      queuedMs: undefined,
      startedAt: undefined,
      resumeCount: (previous.resumeCount ?? 0) + 1,
      lastResumeAt: queuedAt,
      updatedAt: queuedAt
    })
    await this.options.store.upsert(record)
    await this.recordChildEvent(record)
    await notifyLifecycle(input.onQueued, record)

    const state: ChildExecutionState = { record, commits: Promise.resolve() }
    const controller = new AbortController()
    const abortFromParent = (): void => controller.abort()
    if (input.signal.aborted) controller.abort()
    else input.signal.addEventListener('abort', abortFromParent, { once: true })
    try {
      return await this.executeChild({
        state,
        queuedAt,
        profileName: record.profile,
        toolPolicy: record.toolPolicy ?? this.options.config.defaultToolPolicy,
        resolvedModel: record.model,
        resolvedProviderId: record.providerId,
        resolvedAccountId: record.accountId,
        resolvedSystemPrompt: profileSnapshot.systemPrompt,
        resolvedOmitBasePrompt: profileSnapshot.omitBasePrompt === true,
        resolvedAllowedTools: profileSnapshot.allowedTools,
        resolvedBlockedTools: [...new Set(['delegate_task', 'generate_subagent', ...(profileSnapshot.blockedTools ?? [])])],
        resolvedBlockedMcpServers: profileSnapshot.blockedMcpServers,
        resolvedBlockedSkills: profileSnapshot.blockedSkills,
        skillsEnabled: profileSnapshot.skillsEnabled !== false,
        promptPreamble: profileSnapshot.promptPreamble,
        approvalPolicy: record.approvalPolicy,
        sandboxMode: record.sandboxMode,
        approvalReviewer: record.approvalReviewer,
        clientSurface: undefined,
        guiDesignCanvas: false,
        resolvedReasoningEffort: record.reasoningEffort,
        resolvedServiceTier: record.serviceTier,
        returnFormat: record.returnFormat,
        workspace,
        security,
        onRunning: input.onRunning,
        label: record.label,
        parentThreadId: record.parentThreadId,
        parentTurnId: input.parentTurnId,
        prompt: input.prompt,
        resumeChild: true,
        signal: controller.signal
      })
    } finally {
      input.signal.removeEventListener('abort', abortFromParent)
    }
  }

  /**
   * Run the queue-acquire + execute + result-recording block for a child
   * that was already persisted with status='queued'. Shared by the
   * synchronous path (via inline code in runChild) and the detached path.
   * Failures are recorded on the record rather than re-thrown — for
   * detached runs nobody is awaiting them anyway.
   */
  /**
   * Move a queued/running foreground child into the background. The child
   * keeps its current process, thread, and event stream; only the parent abort
   * bridge is removed and the waiting delegate_task is released.
   */
  async detachChild(childId: string): Promise<boolean> {
    const control = this.foregroundChildren.get(childId)
    if (!control || control.controller.signal.aborted) return false
    let changed = false
    await this.commitChildState(control.state, (current) => {
      if (current.detached || (current.status !== 'queued' && current.status !== 'running')) return undefined
      changed = true
      return ChildRunRecord.parse({
        ...current,
        detached: true,
        updatedAt: this.now()
      })
    })
    if (!changed) return false
    control.unlinkParent()
    this.detachedParentThreads.set(childId, control.parentThreadId)
    this.detachedSettlements.set(childId, control.detachedSettlement)
    this.detachedAborts.set(childId, control.controller)
    control.resolveDetached()
    return true
  }

  /**
   * Abort a detached child by id. Returns `true` when a running detached
   * job was signalled, `false` otherwise. Synchronous (in-flight) runs
   * are unaffected — the caller can abort their own parent signal instead.
   */
  abortChild(childId: string): boolean {
    const controller = this.detachedAborts.get(childId)
    if (!controller) {
      console.warn(`[kun] detached subagent abort requested but no running child found child=${childId}`)
      return false
    }
    console.warn(`[kun] detached subagent abort requested child=${childId}`)
    controller.abort()
    console.warn(`[kun] detached subagent abort signal fired child=${childId}`)
    return true
  }

  /**
   * Abort all live detached children launched from a parent thread. Foreground
   * children already inherit the parent turn signal; detached children do not,
   * so deletion must cancel their independent controllers explicitly.
   */
  async abortDetachedChildrenForThread(parentThreadId: string): Promise<number> {
    const settlements: Promise<void>[] = []
    let aborted = 0
    for (const [childId, controller] of this.detachedAborts) {
      if (this.detachedParentThreads.get(childId) !== parentThreadId) continue
      const settlement = this.detachedSettlements.get(childId)
      if (settlement) settlements.push(settlement)
      controller.abort()
      aborted += 1
    }
    await Promise.allSettled(settlements)
    return aborted
  }

  /**
   * Mark child runs left 'queued'/'running' by a previous process as failed, so
   * a runtime restart doesn't leave subagent records stuck "running" forever —
   * the GUI subagent cards and delegation diagnostics would otherwise show them
   * in-flight indefinitely, and the parent thread stays wedged (KunAgent/Kun#621).
   * Mirrors TurnService.reconcileOrphanedTurns; run once at startup before any
   * new child spawns. Detached runs owned by this process are skipped defensively.
   * Returns the number of records reconciled.
   */
  async reconcileOrphanedChildRuns(): Promise<number> {
    const records = await this.options.store.list()
    let reconciled = 0
    for (const record of records) {
      if (record.status !== 'queued' && record.status !== 'running') continue
      if (this.detachedAborts.has(record.id)) continue
      const updated = ChildRunRecord.parse({
        ...record,
        status: 'failed',
        error: record.error ?? 'Subagent run was interrupted by a runtime restart.',
        updatedAt: this.now()
      })
      try {
        await this.options.store.upsert(updated)
        await this.recordChildEvent(updated)
        reconciled += 1
      } catch {
        // Best-effort sweep; one unwritable record must not stop the rest.
      }
    }
    return reconciled
  }
}
