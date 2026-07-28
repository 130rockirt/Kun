import type { KunGraphSettingsV1 } from './app-settings-types'

export function defaultKunGraphSettings(): KunGraphSettingsV1 {
  return {
    enabled: false,
    defaultStrategy: 'direct',
    rolloutStage: 'experimental',
    scheduler: {
      maxNodes: 128,
      maxEdges: 512,
      maxConcurrentRuns: 4,
      maxConcurrentNodes: 8,
      maxConcurrentNodesPerRun: 4,
      maxAttemptsPerNode: 3,
      maxRevisions: 16,
      maxLoopIterations: 5,
      maxRunWallTimeMs: 6 * 60 * 60 * 1_000,
      maxNodeWallTimeMs: 60 * 60 * 1_000,
      maxArtifactBytes: 1024 * 1024 * 1024,
      budgetWarningRatio: 0.8
    },
    context: {
      maxWorkerContextBytes: 256 * 1024,
      maxDependencySummaryBytes: 32 * 1024,
      maxInputArtifacts: 64,
      maxInputMessages: 64,
      maxInlineEventBytes: 16 * 1024
    },
    mailbox: {
      maxMessagesPerNode: 128,
      maxMessagesPerRun: 2_048,
      maxMessageBytes: 16 * 1024,
      maxArtifactRefsPerMessage: 32,
      maxMessagesPerMinute: 60,
      defaultTtlMs: 24 * 60 * 60 * 1_000,
      blockingReplyTimeoutMs: 30 * 60 * 1_000
    },
    supervision: {
      enabled: true,
      autoStart: true,
      coalesceWindowMs: 1_000,
      stallTimeoutMs: 15 * 60 * 1_000,
      repeatedFailureThreshold: 2,
      requireFinalReview: true,
      requireHumanForCriticalRisk: true
    },
    writeIsolation: {
      mode: 'serialize',
      allowWorktrees: false,
      leaseTtlMs: 30 * 60 * 1_000,
      preserveFailedWorktrees: true
    },
    routing: {
      recallLimit: 12,
      minTaskFit: 0.25,
      minConfidence: 0.2,
      explorationRatio: 0,
      dormantMissedOpportunityThreshold: 20
    },
    learning: {
      mode: 'off',
      minimumDistinctSessions: 3,
      minimumVerifiedEpisodes: 3,
      consolidationIntervalMs: 24 * 60 * 60 * 1_000,
      maxEpisodesPerJob: 500,
      probationMinimumRuns: 5,
      allowReadOnlyExploration: false
    },
    retention: {
      graphDays: 90,
      artifactDays: 30,
      episodeDays: 180,
      auditDays: 365,
      snapshotEveryEvents: 100,
      compactAfterEvents: 5_000
    }
  }
}

export function normalizeKunGraphSettings(
  input: Partial<KunGraphSettingsV1> | undefined
): KunGraphSettingsV1 {
  const defaults = defaultKunGraphSettings()
  const scheduler = input?.scheduler ?? defaults.scheduler
  const context = input?.context ?? defaults.context
  const mailbox = input?.mailbox ?? defaults.mailbox
  const supervision = input?.supervision ?? defaults.supervision
  const writeIsolation = input?.writeIsolation ?? defaults.writeIsolation
  const routing = input?.routing ?? defaults.routing
  const learning = input?.learning ?? defaults.learning
  const retention = input?.retention ?? defaults.retention
  const maxConcurrentNodes = boundedPositiveInt(
    scheduler.maxConcurrentNodes,
    defaults.scheduler.maxConcurrentNodes,
    256
  )
  return {
    enabled: input?.enabled === true,
    defaultStrategy: input?.defaultStrategy === 'graph' && input?.enabled === true
      ? 'graph'
      : 'direct',
    rolloutStage:
      input?.rolloutStage === 'alpha' ||
      input?.rolloutStage === 'beta' ||
      input?.rolloutStage === 'learning-preview' ||
      input?.rolloutStage === 'stable'
        ? input.rolloutStage
        : 'experimental',
    scheduler: {
      maxNodes: boundedPositiveInt(scheduler.maxNodes, defaults.scheduler.maxNodes, 10_000),
      maxEdges: boundedPositiveInt(scheduler.maxEdges, defaults.scheduler.maxEdges, 50_000),
      maxConcurrentRuns: boundedPositiveInt(
        scheduler.maxConcurrentRuns,
        defaults.scheduler.maxConcurrentRuns,
        256
      ),
      maxConcurrentNodes,
      maxConcurrentNodesPerRun: Math.min(
        maxConcurrentNodes,
        boundedPositiveInt(
          scheduler.maxConcurrentNodesPerRun,
          defaults.scheduler.maxConcurrentNodesPerRun,
          256
        )
      ),
      maxAttemptsPerNode: boundedPositiveInt(
        scheduler.maxAttemptsPerNode,
        defaults.scheduler.maxAttemptsPerNode,
        20
      ),
      maxRevisions: boundedPositiveInt(
        scheduler.maxRevisions,
        defaults.scheduler.maxRevisions,
        128
      ),
      maxLoopIterations: boundedNonNegativeInt(
        scheduler.maxLoopIterations,
        defaults.scheduler.maxLoopIterations,
        128
      ),
      maxRunWallTimeMs: boundedPositiveInt(
        scheduler.maxRunWallTimeMs,
        defaults.scheduler.maxRunWallTimeMs,
        30 * 24 * 60 * 60 * 1_000
      ),
      maxNodeWallTimeMs: boundedPositiveInt(
        scheduler.maxNodeWallTimeMs,
        defaults.scheduler.maxNodeWallTimeMs,
        24 * 60 * 60 * 1_000
      ),
      maxArtifactBytes: boundedNonNegativeInt(
        scheduler.maxArtifactBytes,
        defaults.scheduler.maxArtifactBytes,
        100_000_000_000
      ),
      budgetWarningRatio: boundedRatio(
        scheduler.budgetWarningRatio,
        defaults.scheduler.budgetWarningRatio
      )
    },
    context: {
      maxWorkerContextBytes: boundedPositiveInt(
        context.maxWorkerContextBytes,
        defaults.context.maxWorkerContextBytes,
        16 * 1024 * 1024
      ),
      maxDependencySummaryBytes: boundedPositiveInt(
        context.maxDependencySummaryBytes,
        defaults.context.maxDependencySummaryBytes,
        1024 * 1024
      ),
      maxInputArtifacts: boundedPositiveInt(
        context.maxInputArtifacts,
        defaults.context.maxInputArtifacts,
        1_000
      ),
      maxInputMessages: boundedPositiveInt(
        context.maxInputMessages,
        defaults.context.maxInputMessages,
        1_000
      ),
      maxInlineEventBytes: boundedPositiveInt(
        context.maxInlineEventBytes,
        defaults.context.maxInlineEventBytes,
        1024 * 1024
      )
    },
    mailbox: {
      maxMessagesPerNode: boundedNonNegativeInt(
        mailbox.maxMessagesPerNode,
        defaults.mailbox.maxMessagesPerNode,
        10_000
      ),
      maxMessagesPerRun: boundedNonNegativeInt(
        mailbox.maxMessagesPerRun,
        defaults.mailbox.maxMessagesPerRun,
        100_000
      ),
      maxMessageBytes: boundedPositiveInt(
        mailbox.maxMessageBytes,
        defaults.mailbox.maxMessageBytes,
        1024 * 1024
      ),
      maxArtifactRefsPerMessage: boundedNonNegativeInt(
        mailbox.maxArtifactRefsPerMessage,
        defaults.mailbox.maxArtifactRefsPerMessage,
        1_000
      ),
      maxMessagesPerMinute: boundedNonNegativeInt(
        mailbox.maxMessagesPerMinute,
        defaults.mailbox.maxMessagesPerMinute,
        10_000
      ),
      defaultTtlMs: boundedPositiveInt(
        mailbox.defaultTtlMs,
        defaults.mailbox.defaultTtlMs,
        30 * 24 * 60 * 60 * 1_000
      ),
      blockingReplyTimeoutMs: boundedPositiveInt(
        mailbox.blockingReplyTimeoutMs,
        defaults.mailbox.blockingReplyTimeoutMs,
        30 * 24 * 60 * 60 * 1_000
      )
    },
    supervision: {
      enabled: supervision.enabled !== false,
      autoStart: supervision.autoStart !== false,
      coalesceWindowMs: boundedNonNegativeInt(
        supervision.coalesceWindowMs,
        defaults.supervision.coalesceWindowMs,
        60_000
      ),
      stallTimeoutMs: boundedPositiveInt(
        supervision.stallTimeoutMs,
        defaults.supervision.stallTimeoutMs,
        24 * 60 * 60 * 1_000
      ),
      repeatedFailureThreshold: Math.max(2, boundedPositiveInt(
        supervision.repeatedFailureThreshold,
        defaults.supervision.repeatedFailureThreshold,
        20
      )),
      requireFinalReview: supervision.requireFinalReview !== false,
      requireHumanForCriticalRisk: supervision.requireHumanForCriticalRisk !== false
    },
    writeIsolation: {
      mode:
        writeIsolation.mode === 'lease' || writeIsolation.mode === 'worktree'
          ? writeIsolation.mode
          : 'serialize',
      allowWorktrees: writeIsolation.allowWorktrees === true,
      leaseTtlMs: boundedPositiveInt(
        writeIsolation.leaseTtlMs,
        defaults.writeIsolation.leaseTtlMs,
        24 * 60 * 60 * 1_000
      ),
      preserveFailedWorktrees: writeIsolation.preserveFailedWorktrees !== false
    },
    routing: {
      recallLimit: boundedPositiveInt(
        routing.recallLimit,
        defaults.routing.recallLimit,
        100
      ),
      minTaskFit: boundedRatio(routing.minTaskFit, defaults.routing.minTaskFit),
      minConfidence: boundedRatio(routing.minConfidence, defaults.routing.minConfidence),
      explorationRatio: boundedRatio(routing.explorationRatio, defaults.routing.explorationRatio),
      dormantMissedOpportunityThreshold: boundedPositiveInt(
        routing.dormantMissedOpportunityThreshold,
        defaults.routing.dormantMissedOpportunityThreshold,
        10_000
      )
    },
    learning: {
      mode:
        learning.mode === 'suggest' || learning.mode === 'auto_candidate'
          ? learning.mode
          : 'off',
      minimumDistinctSessions: Math.max(2, boundedPositiveInt(
        learning.minimumDistinctSessions,
        defaults.learning.minimumDistinctSessions,
        1_000
      )),
      minimumVerifiedEpisodes: Math.max(2, boundedPositiveInt(
        learning.minimumVerifiedEpisodes,
        defaults.learning.minimumVerifiedEpisodes,
        10_000
      )),
      consolidationIntervalMs: boundedPositiveInt(
        learning.consolidationIntervalMs,
        defaults.learning.consolidationIntervalMs,
        365 * 24 * 60 * 60 * 1_000
      ),
      maxEpisodesPerJob: boundedPositiveInt(
        learning.maxEpisodesPerJob,
        defaults.learning.maxEpisodesPerJob,
        100_000
      ),
      probationMinimumRuns: boundedPositiveInt(
        learning.probationMinimumRuns,
        defaults.learning.probationMinimumRuns,
        1_000
      ),
      allowReadOnlyExploration:
        input?.enabled === true &&
        learning.mode !== 'off' &&
        learning.allowReadOnlyExploration === true
    },
    retention: {
      graphDays: boundedPositiveInt(retention.graphDays, defaults.retention.graphDays, 3_650),
      artifactDays: boundedPositiveInt(
        retention.artifactDays,
        defaults.retention.artifactDays,
        3_650
      ),
      episodeDays: boundedPositiveInt(
        retention.episodeDays,
        defaults.retention.episodeDays,
        3_650
      ),
      auditDays: boundedPositiveInt(retention.auditDays, defaults.retention.auditDays, 36_500),
      snapshotEveryEvents: boundedPositiveInt(
        retention.snapshotEveryEvents,
        defaults.retention.snapshotEveryEvents,
        100_000
      ),
      compactAfterEvents: boundedPositiveInt(
        retention.compactAfterEvents,
        defaults.retention.compactAfterEvents,
        10_000_000
      )
    }
  }
}

function boundedPositiveInt(
  value: unknown,
  fallback: number,
  max = Number.MAX_SAFE_INTEGER
): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback
  return Math.min(Math.floor(value), max)
}

function boundedNonNegativeInt(
  value: unknown,
  fallback: number,
  max = Number.MAX_SAFE_INTEGER
): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return fallback
  return Math.min(Math.floor(value), max)
}

function boundedRatio(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : fallback
}
