import { join } from 'node:path'
import { buildGraphModeLocalTools } from '../adapters/tool/graph-mode-tool-provider.js'
import type { ArtifactStore } from '../artifacts/artifact-store.js'
import type { GraphRuntimeConfig } from '../config/kun-config.js'
import type { GraphRunV1 } from '../contracts/graph.js'
import type { ThreadStatus } from '../contracts/threads.js'
import type { DelegationRuntime } from '../delegation/delegation-runtime.js'
import {
  FileGraphRunStore,
  FileGraphThreadReferenceStore,
  FileGraphWriteCoordinator,
  FileProjectAgentRegistry,
  GraphAssignmentResolver,
  GraphControlService,
  GraphLearningService,
  GraphMailbox,
  GraphRecoveryService,
  GraphRetentionService,
  GraphRunConflictError,
  GraphScheduler,
  GraphSupervisor,
  GraphWorkerSessionRegistry,
  graphPhysicalPathsEqual,
  type GraphParentAuthority
} from '../graph/index.js'
import type { IdGenerator } from '../ports/id-generator.js'
import type { SessionStore } from '../ports/session-store.js'
import type { ThreadStore } from '../ports/thread-store.js'
import type { RuntimeEventRecorder } from '../services/runtime-event-recorder.js'
import { createGraphCheckVerifier } from '../graph/graph-check-verifier.js'

export type GraphRuntimeStartOptions = {
  delegation: () => DelegationRuntime | undefined
  steerTurn?: (input: {
    threadId: string
    turnId: string
    text: string
    displayText?: string
    messageSource?: 'graph_runtime'
  }) => Promise<void>
  leadTurn: (input: {
    run: GraphRunV1
    reasons: string[]
    nodeIds: string[]
    digest: string
  }) => Promise<void>
  authorityForRun: (run: GraphRunV1) => Promise<GraphParentAuthority> | GraphParentAuthority
}

export class GraphRuntimeComposition {
  readonly store: FileGraphRunStore
  readonly writes: FileGraphWriteCoordinator
  readonly control: GraphControlService
  readonly references: FileGraphThreadReferenceStore
  readonly registry: FileProjectAgentRegistry
  readonly mailbox: GraphMailbox
  readonly assignments: GraphAssignmentResolver
  readonly workerSessions = new GraphWorkerSessionRegistry()
  readonly learning: GraphLearningService
  readonly retention: GraphRetentionService
  readonly toolsProvider
  scheduler!: GraphScheduler
  supervisor!: GraphSupervisor
  recovery!: GraphRecoveryService
  private readonly backgroundTasks = new Set<Promise<unknown>>()
  private delegation?: GraphRuntimeStartOptions['delegation']
  private steerChildTurn?: GraphRuntimeStartOptions['steerTurn']
  private retentionTimer?: NodeJS.Timeout

  constructor(private readonly options: {
    dataDir: string
    config: () => GraphRuntimeConfig
    artifactStore: ArtifactStore
    runtimeEvents: Pick<RuntimeEventRecorder, 'record'>
    threadStore: Pick<ThreadStore, 'get'>
    sessionStore?: Pick<SessionStore, 'loadItems'>
    ids: IdGenerator
    nowIso: () => string
  }) {
    const nextId = (prefix: string): string => options.ids.next(prefix)
    this.store = new FileGraphRunStore({
      rootDir: join(options.dataDir, 'graphs'),
      config: options.config,
      artifactStore: options.artifactStore,
      runtimeEvents: options.runtimeEvents,
      nowIso: options.nowIso,
      nextId
    })
    this.writes = new FileGraphWriteCoordinator({
      rootDir: join(options.dataDir, 'graph-resources'),
      config: options.config,
      artifactStore: options.artifactStore,
      nowIso: options.nowIso,
      nextId
    })
    this.control = new GraphControlService({
      store: this.store,
      config: options.config,
      authorizeCreate: async (input) => {
        const thread = await options.threadStore.get(input.threadId)
        if (!thread || thread.status === 'deleted') {
          throw new GraphRunConflictError(
            `GraphRun parent thread is unavailable: ${input.threadId}`
          )
        }
        if (thread.status === 'archived') {
          throw new GraphRunConflictError(
            `cannot create a GraphRun for archived thread ${input.threadId}`
          )
        }
        const sourceTurn = thread.turns.find((turn) => turn.id === input.sourceTurnId)
        if (!sourceTurn) {
          throw new GraphRunConflictError(
            `GraphRun source turn does not belong to thread ${input.threadId}`
          )
        }
        if (sourceTurn.orchestration !== 'graph') {
          throw new GraphRunConflictError(
            `GraphRun source turn is not authorized for Graph orchestration`
          )
        }
        const [threadIdentity, planIdentity] = await Promise.all([
          this.registry.identify(thread.workspace),
          this.registry.identify(input.plan.workspaceRoot)
        ])
        if (
          !graphPhysicalPathsEqual(
            threadIdentity.canonicalWorkspaceRoot,
            planIdentity.canonicalWorkspaceRoot
          ) ||
          threadIdentity.projectId !== planIdentity.projectId
        ) {
          throw new GraphRunConflictError(
            'GraphRun plan workspace must match the parent thread workspace'
          )
        }
        if (input.projectId !== threadIdentity.projectId) {
          throw new GraphRunConflictError(
            'GraphRun project id does not match the canonical parent workspace'
          )
        }
      },
      pauseActive: async (run) => {
        await this.scheduler?.cancelRun(run.id, 'pause')
      },
      cancelActive: async (run) => {
        await this.scheduler?.cancelRun(run.id, 'cancel')
      },
      resumeActive: (run) => {
        this.scheduler?.resumeRun(run.id)
      },
      onSteering: (run, steering) => this.supervisor?.signal({
        runId: run.id,
        reason: 'user_steering',
        nodeIds:
          steering.target.kind === 'node' || steering.target.kind === 'attempt'
            ? [steering.target.nodeId]
            : [],
        digest: steering.text
      }),
      onCancelled: (run, reason) => this.supervisor?.signal({
        runId: run.id,
        reason: 'completion',
        nodeIds: [],
        digest: reason
          ? `GraphRun was cancelled: ${reason}`
          : 'GraphRun was cancelled.'
      }),
      cleanupResources: (run) => this.writes.cleanupRun(run.id),
      nowIso: options.nowIso,
      nextId
    })
    this.references = new FileGraphThreadReferenceStore({
      path: join(options.dataDir, 'graphs', 'thread-references.json'),
      runs: this.store,
      nowIso: options.nowIso,
      nextId
    })
    this.registry = new FileProjectAgentRegistry({
      rootDir: join(options.dataDir, 'project-agents'),
      config: options.config,
      nowIso: options.nowIso,
      nextId
    })
    this.mailbox = new GraphMailbox({
      store: this.store,
      config: options.config,
      nowIso: options.nowIso
    })
    this.assignments = new GraphAssignmentResolver({
      registry: this.registry,
      nowIso: options.nowIso
    })
    this.learning = new GraphLearningService({
      rootDir: join(options.dataDir, 'graph-learning'),
      config: options.config,
      registry: this.registry,
      nowIso: options.nowIso,
      nextId
    })
    this.retention = new GraphRetentionService({
      runs: this.store,
      references: this.references,
      registry: this.registry,
      learning: this.learning,
      artifacts: options.artifactStore,
      config: options.config,
      nowIso: options.nowIso
    })
    this.toolsProvider = {
      id: 'graph-mode',
      kind: 'built-in' as const,
      enabled: true,
      available: true,
      effects: {
        network: false,
        externalWrite: false,
        processExecution: false,
        guiAutomation: false
      },
      tools: buildGraphModeLocalTools({
        control: this.control,
        store: this.store,
        mailbox: this.mailbox,
        registry: this.registry,
        artifactStore: options.artifactStore,
        workerSessions: this.workerSessions,
        threads: options.threadStore,
        sessions: options.sessionStore,
        steerChildTurn: () => this.steerChildTurn,
        childActivity: async (parentThreadId, childThreadId) => {
          const runtime = this.delegation?.()
          if (!runtime) return undefined
          const record = (await runtime.diagnostics(parentThreadId)).childRuns
            .find((child) => child.id === childThreadId)
          return record
            ? {
                status: record.status,
                ...(record.activity ? { activity: record.activity } : {}),
                updatedAt: record.updatedAt
              }
            : undefined
        },
        config: options.config,
        enabled: () => options.config().enabled,
        signalSupervision: (input) => this.supervisor?.signal(input),
        nowIso: options.nowIso,
        nextId
      })
    }
  }

  async handleThreadFork(sourceThreadId: string, targetThreadId: string): Promise<void> {
    await this.references.fork(sourceThreadId, targetThreadId)
  }

  async handleThreadStatus(threadId: string, status: ThreadStatus): Promise<void> {
    if (status !== 'archived') return
    const runs = await this.store.list({ threadId })
    for (const run of runs) {
      if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
        continue
      }
      const paused = await this.control.pause(run.id, {
        commandId: this.options.ids.next('graph_archive'),
        idempotencyKey: `archive:${threadId}:${run.id}:${run.lastEventSeq}`
      })
      if (
        paused.status !== 'paused' &&
        paused.status !== 'completed' &&
        paused.status !== 'failed' &&
        paused.status !== 'cancelled'
      ) {
        throw new GraphRunConflictError(
          `archiving thread ${threadId} did not settle GraphRun ${run.id}`
        )
      }
    }
  }

  async cancelThreadRuns(threadId: string): Promise<void> {
    const runs = await this.store.list({ threadId })
    for (const run of runs) {
      if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
        continue
      }
      await this.control.cancel(run.id, {
        commandId: this.options.ids.next('graph_delete'),
        idempotencyKey: `delete:${threadId}:${run.id}:${run.lastEventSeq}`,
        reason: 'owning thread was deleted'
      })
    }
  }

  async handleSourceTurnTerminal(
    threadId: string,
    sourceTurnId: string,
    status: 'completed' | 'failed' | 'aborted'
  ): Promise<void> {
    const runs = await this.store.list({ threadId })
    for (const run of runs) {
      if (
        run.sourceTurnId !== sourceTurnId ||
        run.status === 'completed' ||
        run.status === 'failed' ||
        run.status === 'cancelled'
      ) {
        continue
      }
      await this.control.cancel(run.id, {
        commandId: this.options.ids.next('graph_source_turn_terminal'),
        idempotencyKey: `source-turn-terminal:${threadId}:${sourceTurnId}:${run.id}:${status}`,
        reason: `owning source turn ended with status ${status}`
      })
    }
  }

  async start(options: GraphRuntimeStartOptions): Promise<void> {
    const nextId = (prefix: string): string => this.options.ids.next(prefix)
    this.delegation = options.delegation
    this.steerChildTurn = options.steerTurn
    this.supervisor = new GraphSupervisor({
      store: this.store,
      config: this.options.config,
      delegation: options.delegation,
      leadTurn: options.leadTurn,
      nowIso: this.options.nowIso,
      nextId
    })
    this.scheduler = new GraphScheduler({
      store: this.store,
      config: this.options.config,
      delegation: options.delegation,
      registry: this.registry,
      assignments: this.assignments,
      mailbox: this.mailbox,
      writes: this.writes,
      workerSessions: this.workerSessions,
      authorityForRun: options.authorityForRun,
      artifactStore: this.options.artifactStore,
      verifyChecks: createGraphCheckVerifier(),
      supervision: () => this.supervisor,
      nowIso: this.options.nowIso,
      nextId,
      onTerminal: (run) => {
        this.trackBackground(
          `Graph learning capture failed for ${run.id}`,
          this.learning.capture(run)
        )
      }
    })
    this.recovery = new GraphRecoveryService({
      store: this.store,
      config: this.options.config,
      writes: this.writes,
      delegation: options.delegation,
      supervision: () => this.supervisor,
      nowIso: this.options.nowIso,
      nextId
    })
    await this.recovery.reconcile()
    this.supervisor.start()
    this.scheduler.start()
    await this.recoverLeadOwnership()
    this.learning.start()
    this.trackBackground('Graph retention failed', this.runRetention())
    this.retentionTimer = setInterval(() => {
      this.trackBackground('Graph retention failed', this.runRetention())
    }, 6 * 60 * 60 * 1_000)
    this.retentionTimer.unref?.()
  }

  async reconfigureBackgroundServices(): Promise<void> {
    this.supervisor?.reconfigure()
    if (!this.options.config().enabled) {
      const runs = await this.store.list()
      for (const run of runs) {
        if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
          continue
        }
        await this.control.pause(run.id, {
          commandId: this.options.ids.next('graph_disable'),
          idempotencyKey: `disable:${run.id}:${run.lastEventSeq}`
        })
      }
    }
    await this.learning.reconfigure()
  }

  async stop(): Promise<void> {
    if (this.retentionTimer) clearInterval(this.retentionTimer)
    this.retentionTimer = undefined
    await this.scheduler?.stop()
    await this.supervisor?.stop()
    await this.learning.stop()
    await Promise.allSettled([...this.backgroundTasks])
  }

  private async runRetention(): Promise<void> {
    await this.retention.run()
  }

  private async recoverLeadOwnership(): Promise<void> {
    const runs = await this.store.list()
    for (const run of runs) {
      const thread = await this.options.threadStore.get(run.threadId)
      const sourceTurn = thread?.turns.find((turn) => turn.id === run.sourceTurnId)
      if (!sourceTurn) continue
      const terminal =
        run.status === 'completed' ||
        run.status === 'failed' ||
        run.status === 'cancelled'
      if (sourceTurn.status !== 'running') {
        if (
          !terminal &&
          (sourceTurn.status === 'completed' ||
            sourceTurn.status === 'failed' ||
            sourceTurn.status === 'aborted')
        ) {
          await this.handleSourceTurnTerminal(
            run.threadId,
            run.sourceTurnId,
            sourceTurn.status
          )
        }
        continue
      }
      const lifecycle = sourceTurn.graphLeadLifecycle
      const lastDeliveredSeq =
        lifecycle?.runId === run.id
          ? lifecycle.lastDeliveredSeq
          : 0
      const unseenSignals = (await this.store.events(run.id, lastDeliveredSeq))
        .flatMap((event) => event.event.type === 'supervision_requested'
          ? [{
              reason: event.event.payload.reason,
              nodeIds: event.event.payload.nodeIds,
              digest: event.event.payload.digest
            }]
          : [])
      const resumedAt = lifecycle?.resumedAt ? Date.parse(lifecycle.resumedAt) : 0
      const suspendedAt = lifecycle?.suspendedAt ? Date.parse(lifecycle.suspendedAt) : 0
      const interruptedContinuation =
        lifecycle?.runId === run.id &&
        Number.isFinite(resumedAt) &&
        resumedAt > 0 &&
        (!Number.isFinite(suspendedAt) || resumedAt > suspendedAt)
      if (!terminal && unseenSignals.length === 0 && !interruptedContinuation) continue
      const latestSignals = unseenSignals.slice(-32)
      this.supervisor.redeliver({
        runId: run.id,
        reason: terminal
          ? 'completion'
          : latestSignals.at(-1)
            ? latestSignals.at(-1)!.reason
            : 'recovery',
        nodeIds: [...new Set(latestSignals.flatMap((signal) => signal.nodeIds))],
        digest: latestSignals.length > 0
          ? latestSignals.map((signal) => signal.digest)
              .filter(Boolean)
              .join('\n')
              .slice(0, 16_384)
          : terminal
            ? `Recovered terminal GraphRun ${run.id} with status ${run.status}.`
            : `Recovered interrupted Lead continuation for GraphRun ${run.id}.`
      })
    }
  }

  private trackBackground(label: string, operation: Promise<unknown>): void {
    const tracked = operation.catch((error) => {
      console.warn(`[kun] ${label}: ${
        error instanceof Error ? error.message : String(error)
      }`)
    }).finally(() => {
      this.backgroundTasks.delete(tracked)
    })
    this.backgroundTasks.add(tracked)
  }
}
