import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import type { GeminiCodeAssistCredential } from '../contracts/gemini-code-assist.js'
import {
  ApprovalPolicySchema,
  DEFAULT_APPROVAL_POLICY,
  DEFAULT_SANDBOX_MODE,
  SandboxModeSchema
} from '../contracts/policy.js'
import {
  AttachmentsCapabilityConfig,
  ComputerUseCapabilityConfig,
  DEFAULT_KUN_CAPABILITIES_CONFIG,
  ImageGenCapabilityConfig,
  InstructionsCapabilityConfig,
  KunCapabilitiesConfig,
  McpCapabilityConfig,
  MemoryCapabilityConfig,
  ModelCapabilityMetadata,
  ModelInputModality,
  ModelMessagePartSupport,
  ModelReasoningCapabilityMetadata,
  ModelReasoningEffort,
  MusicGenCapabilityConfig,
  SkillsCapabilityConfig,
  SpeechGenCapabilityConfig,
  SubagentsCapabilityConfig,
  VideoGenCapabilityConfig,
  WebCapabilityConfig
} from '../contracts/capabilities.js'
import {
  DEFAULT_MODEL_ENDPOINT_FORMAT,
  MODEL_ENDPOINT_FORMATS,
  normalizeModelEndpointFormat
} from '../contracts/model-endpoint-format.js'
import {
  DEFAULT_TOOL_OUTPUT_MAX_BYTES,
  DEFAULT_TOOL_OUTPUT_MAX_LINES
} from '../contracts/tool-output-limits.js'
import { HooksConfigSchema } from '../hooks/hook-config.js'
import { LocalModelGatewayConfigSchema, ModelRoutePoolConfigSchema } from '../contracts/model-route-pool.js'

export const KUN_CONFIG_FILENAME = 'config.json'
export const DEFAULT_KUN_MODEL = 'deepseek-v4-pro'

const PositiveInt = z.number().int().positive()
const PositiveRatio = z.number().positive().max(1)
const HttpUrl = z.string().url().refine((value) => {
  try {
    const protocol = new URL(value).protocol
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}, { message: 'URL must use http or https' })

export const DEFAULT_MODEL_REQUEST_RETRY_CONFIG = {
  maxAttempts: 0,
  initialDelayMs: 3_000,
  httpStatusCodes: [429, 503]
} as const

export const ModelRequestRetryConfigSchema = z
  .object({
    maxAttempts: z.number().int().min(0).max(10).default(DEFAULT_MODEL_REQUEST_RETRY_CONFIG.maxAttempts).optional(),
    initialDelayMs: z.number().int().min(0).max(600_000).default(DEFAULT_MODEL_REQUEST_RETRY_CONFIG.initialDelayMs).optional(),
    httpStatusCodes: z.array(z.number().int().min(400).max(599)).max(64).default([...DEFAULT_MODEL_REQUEST_RETRY_CONFIG.httpStatusCodes]).optional()
  })
  .strict()
export type ModelRequestRetryConfig = z.infer<typeof ModelRequestRetryConfigSchema>

export const ModelContextCompactionProfileConfigSchema = z
  .object({
    softRatio: PositiveRatio.optional(),
    hardRatio: PositiveRatio.optional(),
    softThreshold: PositiveInt.optional(),
    hardThreshold: PositiveInt.optional()
  })
  .strict()
  .superRefine((profile, ctx) => {
    if (
      profile.softThreshold !== undefined &&
      profile.hardThreshold !== undefined &&
      profile.hardThreshold < profile.softThreshold
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'hardThreshold must be greater than or equal to softThreshold'
      })
    }
  })

export const ModelContextProfileConfigSchema = z
  .object({
    aliases: z.array(z.string().min(1)).optional(),
    contextWindowTokens: PositiveInt.optional(),
    maxOutputTokens: PositiveInt.optional(),
    contextCompaction: ModelContextCompactionProfileConfigSchema.optional(),
    softRatio: PositiveRatio.optional(),
    hardRatio: PositiveRatio.optional(),
    softThreshold: PositiveInt.optional(),
    hardThreshold: PositiveInt.optional(),
    inputModalities: z.array(ModelInputModality).optional(),
    outputModalities: z.array(ModelInputModality).optional(),
    supportsToolCalling: z.boolean().optional(),
    messageParts: z.array(ModelMessagePartSupport).optional(),
    reasoning: ModelReasoningCapabilityMetadata.optional(),
    // Per-model wire-format override. Omitted means "inherit the
    // provider/runtime endpointFormat"; no default coercion here, otherwise
    // every model would be pinned to chat_completions.
    endpointFormat: z
      .preprocess(normalizeModelEndpointFormat, z.enum(MODEL_ENDPOINT_FORMATS))
      .optional(),
    responsesMode: z.literal('lite').optional()
  })
  .strict()
  .superRefine((profile, ctx) => {
    const hasRatio =
      profile.softRatio !== undefined ||
      profile.hardRatio !== undefined ||
      profile.contextCompaction?.softRatio !== undefined ||
      profile.contextCompaction?.hardRatio !== undefined
    if (hasRatio && profile.contextWindowTokens === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'softRatio and hardRatio require contextWindowTokens'
      })
    }
    const softThreshold = profile.contextCompaction?.softThreshold ?? profile.softThreshold
    const hardThreshold = profile.contextCompaction?.hardThreshold ?? profile.hardThreshold
    if (softThreshold !== undefined && hardThreshold !== undefined && hardThreshold < softThreshold) {
      ctx.addIssue({
        code: 'custom',
        message: 'hardThreshold must be greater than or equal to softThreshold'
      })
    }
  })

export const ModelConfigSchema = z
  .object({
    profiles: z.record(z.string().min(1), ModelContextProfileConfigSchema).optional()
  })
  .strict()

export const ContextCompactionConfigSchema = z
  .object({
    defaultSoftThreshold: PositiveInt.optional(),
    defaultHardThreshold: PositiveInt.optional(),
    summaryMode: z.enum(['heuristic', 'model']).optional(),
    summaryTimeoutMs: PositiveInt.optional(),
    summaryMaxTokens: PositiveInt.optional(),
    summaryInputMaxBytes: PositiveInt.optional(),
    summaryModel: z.string().min(1).optional(),
    summaryProviderId: z.string().min(1).optional(),
    modelProfiles: z.record(z.string().min(1), ModelContextProfileConfigSchema).optional()
  })
  .strict()
  .superRefine((config, ctx) => {
    if (
      config.defaultSoftThreshold !== undefined &&
      config.defaultHardThreshold !== undefined &&
      config.defaultHardThreshold < config.defaultSoftThreshold
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'defaultHardThreshold must be greater than or equal to defaultSoftThreshold'
      })
    }
  })

export const RuntimeTuningConfigSchema = z
  .object({
    // Max idle gap (ms) between streaming chunks before a turn fails with
    // `stream_idle_timeout`. Local LLM servers prefilling a huge prompt can
    // stay silent well past the 45s default; `0` disables the guard entirely.
    streamIdleTimeoutMs: z.number().int().min(0).optional(),
    toolStorm: z
      .object({
        enabled: z.boolean().optional(),
        windowSize: PositiveInt.optional(),
        threshold: z.number().int().min(2).optional()
      })
      .strict()
      .optional(),
    /** Hard runtime bounds for native and delegated Agent SDK turns. */
    turnLimits: z
      .object({
        maxSteps: PositiveInt.max(1_000).optional(),
        maxWallTimeMs: PositiveInt.max(86_400_000).optional(),
        maxToolCallsPerStep: PositiveInt.max(10_000).optional(),
        /** Global in-process admission cap for concurrently active turns. */
        maxConcurrentTurns: PositiveInt.max(256).optional()
      })
      .strict()
      .optional(),
    /** Sensitive local Agent Perspective capture; explicitly set false to disable. */
    llmDebug: z
      .object({
        enabled: z.boolean().default(true),
        defaultThreadCaptureEnabled: z.boolean().optional()
      })
      .strict()
      .optional(),
    toolArgumentRepair: z
      .object({
        maxStringBytes: PositiveInt.optional()
      })
      .strict()
      .optional()
  })
  .strict()

const GraphSchedulerRuntimeConfigSchema = z.object({
  maxNodes: PositiveInt.max(10_000).default(128),
  maxEdges: PositiveInt.max(50_000).default(512),
  maxConcurrentRuns: PositiveInt.max(256).default(4),
  maxConcurrentNodes: PositiveInt.max(256).default(8),
  maxConcurrentNodesPerRun: PositiveInt.max(256).default(4),
  maxAttemptsPerNode: PositiveInt.max(20).default(3),
  maxRevisions: PositiveInt.max(128).default(16),
  maxLoopIterations: z.number().int().min(0).max(128).default(5),
  maxRunWallTimeMs: PositiveInt.max(30 * 24 * 60 * 60 * 1_000).default(6 * 60 * 60 * 1_000),
  maxNodeWallTimeMs: PositiveInt.max(24 * 60 * 60 * 1_000).default(60 * 60 * 1_000),
  maxTotalTokens: PositiveInt.max(1_000_000_000).optional(),
  maxArtifactBytes: z.number().int().min(0).max(100_000_000_000).default(1024 * 1024 * 1024),
  budgetWarningRatio: z.number().positive().max(1).default(0.8)
}).strict().transform((scheduler) => {
  const { maxTotalTokens, ...activeConfig } = scheduler
  void maxTotalTokens
  return activeConfig
})

export const GraphRuntimeConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    defaultStrategy: z.enum(['direct', 'graph']).default('direct'),
    rolloutStage: z.enum([
      'experimental',
      'alpha',
      'beta',
      'learning-preview',
      'stable'
    ]).default('experimental'),
    scheduler: GraphSchedulerRuntimeConfigSchema,
    context: z.object({
      maxWorkerContextBytes: PositiveInt.max(16 * 1024 * 1024).default(256 * 1024),
      maxDependencySummaryBytes: PositiveInt.max(1024 * 1024).default(32 * 1024),
      maxInputArtifacts: PositiveInt.max(1_000).default(64),
      maxInputMessages: PositiveInt.max(1_000).default(64),
      maxInlineEventBytes: PositiveInt.max(1024 * 1024).default(16 * 1024)
    }).strict(),
    mailbox: z.object({
      maxMessagesPerNode: z.number().int().min(0).max(10_000).default(128),
      maxMessagesPerRun: z.number().int().min(0).max(100_000).default(2_048),
      maxMessageBytes: PositiveInt.max(1024 * 1024).default(16 * 1024),
      maxArtifactRefsPerMessage: z.number().int().min(0).max(1_000).default(32),
      maxMessagesPerMinute: z.number().int().min(0).max(10_000).default(60),
      defaultTtlMs: PositiveInt.max(30 * 24 * 60 * 60 * 1_000).default(24 * 60 * 60 * 1_000),
      blockingReplyTimeoutMs: PositiveInt.max(30 * 24 * 60 * 60 * 1_000).default(30 * 60 * 1_000)
    }).strict(),
    supervision: z.object({
      enabled: z.boolean().default(true),
      autoStart: z.boolean().default(true),
      coalesceWindowMs: z.number().int().min(0).max(60_000).default(1_000),
      stallTimeoutMs: PositiveInt.max(24 * 60 * 60 * 1_000).default(15 * 60 * 1_000),
      repeatedFailureThreshold: z.number().int().min(2).max(20).default(2),
      requireFinalReview: z.boolean().default(true),
      requireHumanForCriticalRisk: z.boolean().default(true)
    }).strict(),
    writeIsolation: z.object({
      mode: z.enum(['serialize', 'lease', 'worktree']).default('serialize'),
      allowWorktrees: z.boolean().default(false),
      leaseTtlMs: PositiveInt.max(24 * 60 * 60 * 1_000).default(30 * 60 * 1_000),
      preserveFailedWorktrees: z.boolean().default(true)
    }).strict(),
    routing: z.object({
      recallLimit: PositiveInt.max(100).default(12),
      minTaskFit: z.number().min(0).max(1).default(0.25),
      minConfidence: z.number().min(0).max(1).default(0.2),
      explorationRatio: z.number().min(0).max(1).default(0),
      dormantMissedOpportunityThreshold: PositiveInt.max(10_000).default(20)
    }).strict(),
    learning: z.object({
      mode: z.enum(['off', 'suggest', 'auto_candidate']).default('off'),
      minimumDistinctSessions: z.number().int().min(2).max(1_000).default(3),
      minimumVerifiedEpisodes: z.number().int().min(2).max(10_000).default(3),
      consolidationIntervalMs: PositiveInt.max(365 * 24 * 60 * 60 * 1_000).default(24 * 60 * 60 * 1_000),
      maxEpisodesPerJob: PositiveInt.max(100_000).default(500),
      probationMinimumRuns: PositiveInt.max(1_000).default(5),
      allowReadOnlyExploration: z.boolean().default(false)
    }).strict(),
    retention: z.object({
      graphDays: PositiveInt.max(3_650).default(90),
      artifactDays: PositiveInt.max(3_650).default(30),
      episodeDays: PositiveInt.max(3_650).default(180),
      auditDays: PositiveInt.max(36_500).default(365),
      snapshotEveryEvents: PositiveInt.max(100_000).default(100),
      compactAfterEvents: PositiveInt.max(10_000_000).default(5_000)
    }).strict()
  })
  .strict()
  .superRefine((graph, ctx) => {
    if (!graph.enabled && graph.defaultStrategy === 'graph') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['defaultStrategy'],
        message: 'defaultStrategy cannot be graph while Graph Mode is disabled'
      })
    }
    if (graph.scheduler.maxConcurrentNodesPerRun > graph.scheduler.maxConcurrentNodes) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['scheduler', 'maxConcurrentNodesPerRun'],
        message: 'maxConcurrentNodesPerRun must not exceed maxConcurrentNodes'
      })
    }
    if (graph.learning.mode === 'off' && graph.learning.allowReadOnlyExploration) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['learning', 'allowReadOnlyExploration'],
        message: 'read-only exploration requires learning to be enabled'
      })
    }
  })
export type GraphRuntimeConfig = z.infer<typeof GraphRuntimeConfigSchema>
export const DEFAULT_GRAPH_RUNTIME_CONFIG: GraphRuntimeConfig = GraphRuntimeConfigSchema.parse({
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
})

/** Detection aggressiveness for the design-quality linter. */
export const DESIGN_QUALITY_STRICTNESS = ['relaxed', 'standard', 'strict'] as const

/**
 * First-party design-quality linter. When enabled, a builtin PostToolUse
 * hook scans frontend files the agent writes/edits and folds findings back
 * into the tool result so the model self-corrects on the next turn.
 */
export const QualityConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    strictness: z.enum(DESIGN_QUALITY_STRICTNESS).default('standard'),
    /** Rule ids to suppress (see the quality detector registry). */
    ignoreRules: z.array(z.string().min(1)).default([]),
    /** Glob patterns (relative paths) to skip, e.g. `**\/vendor/**`. */
    ignoreFiles: z.array(z.string().min(1)).default([]),
    /** Hard cap on findings folded into a single tool result. */
    maxFindings: z.number().int().positive().max(100).default(12)
  })
  .strict()

export const RequestHistoryHygieneConfigSchema = z
  .object({
    maxToolResultLines: PositiveInt.optional(),
    maxToolResultBytes: PositiveInt.optional(),
    maxToolResultTokens: PositiveInt.optional(),
    maxToolArgumentStringBytes: PositiveInt.optional(),
    maxToolArgumentStringTokens: PositiveInt.optional(),
    maxArrayItems: PositiveInt.optional()
  })
  .strict()

export const TokenEconomyConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    compressToolDescriptions: z.boolean().optional(),
    compressToolResults: z.boolean().optional(),
    conciseResponses: z.boolean().optional(),
    historyHygiene: RequestHistoryHygieneConfigSchema.optional()
  })
  .strict()

export const ToolOutputLimitsConfigSchema = z
  .object({
    maxLines: PositiveInt.optional(),
    maxBytes: PositiveInt.optional()
  })
  .strict()

export const DEFAULT_TOOL_OUTPUT_LIMITS_CONFIG: Required<ToolOutputLimitsConfig> = {
  maxLines: DEFAULT_TOOL_OUTPUT_MAX_LINES,
  maxBytes: DEFAULT_TOOL_OUTPUT_MAX_BYTES
}

export const StorageConfigSchema = z
  .object({
    backend: z.enum(['hybrid', 'file']).default('hybrid'),
    sqlitePath: z.string().min(1).optional()
  })
  .strict()

export const DEFAULT_STORAGE_CONFIG: StorageConfig = {
  backend: 'hybrid'
}

export const ObservabilityConfigSchema = z
  .object({
    enabled: z.boolean().default(false).optional(),
    outputPath: z.string().min(1).optional(),
    exporter: z.enum(['jsonl', 'otlp-http-json']).optional(),
    endpoint: HttpUrl.optional(),
    headers: z.record(z.string(), z.string()).optional(),
    timeoutMs: z.number().int().min(1).max(300_000).optional(),
    batchSize: z.number().int().min(1).max(512).optional(),
    maxQueueSize: z.number().int().min(1).max(16_384).optional(),
    // Prompt/tool payloads remain excluded unless this explicit opt-in is set.
    includeSensitiveContent: z.boolean().default(false).optional()
  })
  .strict()

/**
 * Per-`providerId` HTTP credentials. Lets the runtime route a thread's turns
 * to a non-default provider without restart — the workflow / scheduled task
 * UI picks a provider per request, the loop puts the id on `ModelRequest`,
 * and `MultiProviderModelClient` resolves it against this map.
 */
export const ServeProviderConfigSchema = z
  .object({
    /**
     * Transport kind. `http` (default) routes turns through a CompatModelClient
     * over `baseUrl`. `agent-sdk` delegates whole turns to the embedded Claude
     * Agent SDK (Claude Pro/Max subscription billing): `baseUrl` is unused and
     * `apiKey` carries the CLAUDE_CODE_OAUTH_TOKEN (empty => rely on the host's
     * existing Claude Code login). `antigravity-cli` delegates whole turns to
     * Google's official Antigravity CLI and uses its existing subscription login.
     * `cursor-sdk` delegates whole turns to the official Cursor SDK and requires
     * the provider's Cursor API key. `gemini-cli-api` reuses the official
     * Gemini CLI OAuth login and calls Code Assist directly through Kun's
     * model loop.
     */
    kind: z.enum([
      'http',
      'agent-sdk',
      'antigravity-cli',
      'gemini-cli-api',
      'gemini-code-assist',
      'cursor-sdk'
    ]).default('http').optional(),
    apiKey: z.string().default(''),
    /** Opaque binding key resolved through the protected account store. */
    credentialSourceId: z.string().min(1).max(256).optional(),
    baseUrl: z.string().min(1).optional(),
    endpointFormat: z
      .preprocess(normalizeModelEndpointFormat, z.enum(MODEL_ENDPOINT_FORMATS))
      .default(DEFAULT_MODEL_ENDPOINT_FORMAT)
      .optional(),
    retry: ModelRequestRetryConfigSchema.optional(),
    modelProxyUrl: z.string().optional(),
    modelProfiles: z.record(z.string().min(1), ModelContextProfileConfigSchema).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    /** Secret-free catalog metadata used to seed the shared model registry. */
    models: z.array(z.string().min(1).max(512)).max(500).optional(),
    /** Provider-scoped, secret-free capability metadata for the model catalog. */
    modelCapabilities: z.record(z.string().min(1).max(512), ModelCapabilityMetadata).optional(),
    selectedModel: z.string().min(1).max(512).optional()
  })
  .strict()
  .superRefine((cfg, ctx) => {
    if ((cfg.kind ?? 'http') === 'http' && !cfg.baseUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['baseUrl'],
        message: 'baseUrl is required for http providers'
      })
    }
  })
export type ServeProviderConfig = z.infer<typeof ServeProviderConfigSchema> & {
  /** Legacy protected Code Assist material retained for forward migration. */
  geminiAuth?: GeminiCodeAssistCredential
}

export const KunServeConfigSchema = z
  .object({
    host: z.string().optional(),
    port: z.number().int().min(0).max(65_535).optional(),
    dataDir: z.string().min(1).optional(),
    runtimeToken: z.string().optional(),
    apiKey: z.string().optional(),
    /** Opaque binding key resolved through the protected account store. */
    credentialSourceId: z.string().min(1).max(256).optional(),
    baseUrl: z.string().optional(),
    modelProxyUrl: z.string().optional(),
    endpointFormat: z.preprocess(
      normalizeModelEndpointFormat,
      z.enum(MODEL_ENDPOINT_FORMATS)
    ).default(DEFAULT_MODEL_ENDPOINT_FORMAT).optional(),
    retry: ModelRequestRetryConfigSchema.optional(),
    model: z.string().min(1).optional(),
    approvalPolicy: ApprovalPolicySchema.default(DEFAULT_APPROVAL_POLICY).optional(),
    sandboxMode: SandboxModeSchema.default(DEFAULT_SANDBOX_MODE).optional(),
    tokenEconomyMode: z.boolean().optional(),
    tokenEconomy: TokenEconomyConfigSchema.optional(),
    toolOutputLimits: ToolOutputLimitsConfigSchema.optional(),
    insecure: z.boolean().optional(),
    storage: StorageConfigSchema.optional(),
    observability: ObservabilityConfigSchema.optional(),
    /**
     * Extra HTTP headers merged into every default-client model request
     * (last, so they win). Used for providers that authenticate with more
     * than a Bearer key — e.g. Codex needs `ChatGPT-Account-Id` and a
     * Codex-CLI `User-Agent` alongside the OAuth access token.
     */
    headers: z.record(z.string(), z.string()).optional(),
    /**
     * Extra providers the runtime can route to per request. Keys are
     * provider ids (matched against `ModelRequest.providerId`); values
     * hold the same HTTP credentials shape as the runtime defaults. When
     * empty/absent, the runtime stays single-provider.
     */
    providers: z.record(z.string().min(1), ServeProviderConfigSchema).optional(),
    routePools: z.array(ModelRoutePoolConfigSchema).max(100).optional(),
    localModelGateway: LocalModelGatewayConfigSchema.optional()
  })
  .strict()

/**
 * Internal-LLM role model routing. The global `smallModel` slot is the default
 * for cheap internal one-shot calls (thread title, whole-session summary). Each
 * role can override with its own model/provider. Empty/absent => fall back to
 * smallModel, then the main conversation model. Compaction is intentionally NOT
 * here: it reuses the main conversation model for prompt-cache reasons and only
 * exposes its heuristic/model toggle via contextCompaction.summaryMode.
 */
export const RolesConfigSchema = z
  .object({
    smallModel: z.string().min(1).optional(),
    smallModelProviderId: z.string().min(1).optional(),
    smallModelAccountId: z.string().min(1).optional(),
    titleModel: z.string().min(1).optional(),
    titleProviderId: z.string().min(1).optional(),
    titleAccountId: z.string().min(1).optional(),
    summaryModel: z.string().min(1).optional(),
    summaryProviderId: z.string().min(1).optional(),
    summaryAccountId: z.string().min(1).optional(),
    codeReviewModel: z.string().min(1).optional(),
    codeReviewProviderId: z.string().min(1).optional(),
    codeReviewAccountId: z.string().min(1).optional(),
    // Per-role reasoning depth. Default 'off' (the GUI omits it entirely).
    titleReasoningEffort: ModelReasoningEffort.optional(),
    summaryReasoningEffort: ModelReasoningEffort.optional(),
    codeReviewReasoningEffort: ModelReasoningEffort.optional()
  })
  .strict()
export type RolesConfig = z.infer<typeof RolesConfigSchema>

export const KunConfigSchema = z
  .object({
    serve: KunServeConfigSchema.optional(),
    models: ModelConfigSchema.optional(),
    contextCompaction: ContextCompactionConfigSchema.optional(),
    runtime: RuntimeTuningConfigSchema.optional(),
    graph: GraphRuntimeConfigSchema.optional(),
    roles: RolesConfigSchema.optional(),
    capabilities: KunCapabilitiesConfig.default(DEFAULT_KUN_CAPABILITIES_CONFIG),
    hooks: HooksConfigSchema.optional(),
    quality: QualityConfigSchema.optional()
  })
  .strict()

export type KunConfig = z.infer<typeof KunConfigSchema>
export type QualityConfig = z.infer<typeof QualityConfigSchema>
export const DEFAULT_QUALITY_CONFIG: QualityConfig = QualityConfigSchema.parse({})
export type KunServeConfig = z.infer<typeof KunServeConfigSchema>
export type ModelConfig = z.infer<typeof ModelConfigSchema>
export type ContextCompactionConfig = z.infer<typeof ContextCompactionConfigSchema>
export type RuntimeTuningConfig = z.infer<typeof RuntimeTuningConfigSchema>
export type TokenEconomyConfig = z.infer<typeof TokenEconomyConfigSchema>
export type ToolOutputLimitsConfig = z.infer<typeof ToolOutputLimitsConfigSchema>
export type StorageConfig = z.infer<typeof StorageConfigSchema>
export type ObservabilityConfig = z.infer<typeof ObservabilityConfigSchema>

export type LoadedKunConfig = {
  path: string
  config: KunConfig
}

export function readKunConfigFile(path: string): LoadedKunConfig {
  const resolvedPath = expandHomePath(path)
  const text = readFileSync(resolvedPath, 'utf8')
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to parse Kun config JSON at ${resolvedPath}: ${message}`)
  }
  const parsed = KunConfigSchema.safeParse(json)
  if (!parsed.success) {
    const compatible = parseForwardCompatibleKunConfig(json)
    if (compatible) {
      return { path: resolvedPath, config: compatible }
    }
    throw new Error(
      `Invalid Kun config at ${resolvedPath}: ${JSON.stringify(parsed.error.issues, null, 2)}`
    )
  }
  return { path: resolvedPath, config: parsed.data }
}

const FORWARD_COMPATIBLE_TOP_LEVEL_SECTIONS = [
  ['models', ModelConfigSchema],
  ['contextCompaction', ContextCompactionConfigSchema],
  ['runtime', RuntimeTuningConfigSchema],
  ['roles', RolesConfigSchema],
  ['hooks', HooksConfigSchema],
  ['quality', QualityConfigSchema]
] as const

const FORWARD_COMPATIBLE_CAPABILITY_SECTIONS = [
  ['mcp', McpCapabilityConfig],
  ['web', WebCapabilityConfig],
  ['instructions', InstructionsCapabilityConfig],
  ['skills', SkillsCapabilityConfig],
  ['subagents', SubagentsCapabilityConfig],
  ['attachments', AttachmentsCapabilityConfig],
  ['memory', MemoryCapabilityConfig],
  ['imageGen', ImageGenCapabilityConfig],
  ['speechGen', SpeechGenCapabilityConfig],
  ['musicGen', MusicGenCapabilityConfig],
  ['videoGen', VideoGenCapabilityConfig],
  ['computerUse', ComputerUseCapabilityConfig]
] as const

/**
 * A newer GUI may write capability metadata that an older bundled TUI does
 * not know yet. Keep startup fail-closed for the connection-critical `serve`
 * section, while preserving every independently valid section and falling
 * back to this runtime's defaults for only the newer capability fragments.
 */
function parseForwardCompatibleKunConfig(json: unknown): KunConfig | null {
  if (!isRecord(json)) return null

  const compatible: Record<string, unknown> = {}
  if (json.serve !== undefined) {
    const serve = KunServeConfigSchema.safeParse(json.serve)
    if (!serve.success) return null
    compatible.serve = serve.data
  }

  for (const [key, schema] of FORWARD_COMPATIBLE_TOP_LEVEL_SECTIONS) {
    if (json[key] === undefined) continue
    const section = schema.safeParse(json[key])
    // Known runtime sections are executable configuration, not display-only
    // metadata. Never hide a typo or unsupported override in one of them while
    // recovering from unrelated newer GUI fields.
    if (!section.success) return null
    compatible[key] = section.data
  }

  if (isRecord(json.capabilities)) {
    const capabilities: Record<string, unknown> = {}
    for (const [key, schema] of FORWARD_COMPATIBLE_CAPABILITY_SECTIONS) {
      if (json.capabilities[key] === undefined) continue
      const section = schema.safeParse(json.capabilities[key])
      if (section.success) capabilities[key] = section.data
    }
    compatible.capabilities = capabilities
  }

  const parsed = KunConfigSchema.safeParse(compatible)
  return parsed.success ? parsed.data : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function readOptionalKunConfigFile(path: string | undefined): LoadedKunConfig | null {
  if (!path) return null
  const resolvedPath = expandHomePath(path)
  if (!existsSync(resolvedPath)) return null
  return readKunConfigFile(resolvedPath)
}

export function kunConfigPathForDataDir(dataDir: string | undefined): string | undefined {
  const trimmed = dataDir?.trim()
  if (!trimmed) return undefined
  return join(expandHomePath(trimmed), KUN_CONFIG_FILENAME)
}

export function expandHomePath(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) {
    return join(homedir(), path.slice(2).replace(/\\/g, '/'))
  }
  return path
}
