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

const ChildRunUsage = z.object({
  promptTokens: z.number().int().nonnegative().default(0),
  completionTokens: z.number().int().nonnegative().default(0),
  totalTokens: z.number().int().nonnegative().default(0),
  cachedTokens: z.number().int().nonnegative().optional(),
  cacheHitTokens: z.number().int().nonnegative().optional(),
  cacheMissTokens: z.number().int().nonnegative().optional(),
  cacheHitRate: z.number().min(0).max(1).nullable().optional(),
  turns: z.number().int().nonnegative().optional(),
  costUsd: z.number().nonnegative().optional(),
  costCny: z.number().nonnegative().optional(),
  cacheSavingsUsd: z.number().nonnegative().optional(),
  cacheSavingsCny: z.number().nonnegative().optional(),
  tokenEconomySavingsTokens: z.number().int().nonnegative().optional(),
  tokenEconomySavingsUsd: z.number().nonnegative().optional(),
  tokenEconomySavingsCny: z.number().nonnegative().optional()
})

const ChildReturnFormat = z.enum(['summary', 'evidence'])
export type ChildReturnFormat = z.infer<typeof ChildReturnFormat>

const ChildSecuritySnapshot = z.object({
  /** Immutable parent workspace boundary; also used as the child working directory. */
  sandboxRoot: z.string().min(1),
  allowedModelProviderIds: z.array(z.string().min(1)).optional(),
  allowedModelIds: z.array(z.string().min(1)).optional(),
  allowedProviderIds: z.array(z.string().min(1)).optional(),
  allowedToolNames: z.array(z.string().min(1)).optional(),
  allowedSkillIds: z.array(z.string().min(1)).optional(),
  allowedReadPaths: z.array(z.string().min(1)).optional(),
  allowedWritePaths: z.array(z.string().min(1)).optional(),
  allowedArtifactIds: z.array(z.string().min(1)).optional(),
  blockedProviderIds: z.array(z.string().min(1)).optional(),
  blockedToolNames: z.array(z.string().min(1)).optional(),
  blockedSkillIds: z.array(z.string().min(1)).optional(),
  memoryEnabled: z.boolean().default(false)
}).strict()
export type ChildSecuritySnapshot = z.infer<typeof ChildSecuritySnapshot>

const ChildRoutingMetadata = z.object({
  method: z.enum([
    'explicit-profile',
    'explicit-skill',
    'explicit-custom',
    'explicit-generated',
    'bm25-llm-profile',
    'bm25-llm-skill',
    'bm25-llm-custom',
    'bm25-llm-generated',
    'bm25-fallback-profile',
    'bm25-fallback-skill',
    'bm25-fallback-custom',
    'bm25-fallback-generated'
  ]),
  selectedKind: z.enum(['profile', 'skill', 'custom', 'generated']),
  selectedId: z.string().min(1),
  agentSurface: z.enum(['code', 'write', 'design']).optional(),
  reason: z.string().max(2_000).optional(),
  confidence: z.number().min(0).max(1).optional(),
  candidates: z.array(z.object({
    kind: z.enum(['profile', 'skill']),
    targetId: z.string().min(1),
    name: z.string().min(1).max(256),
    description: z.string().max(2_000).optional(),
    toolPolicy: SubagentToolPolicy.optional(),
    source: z.enum(['builtin', 'configured', 'workspace', 'skill']),
    score: z.number().nonnegative()
  }).strict()).max(5).default([]),
  /** Snapshot of a one-shot custom role. It is never merged into persistent config. */
  customAgent: SubagentProfileConfig.optional(),
  generation: z.object({
    method: z.enum(['llm-exemplars', 'deterministic-fallback']),
    referenceAgentIds: z.array(z.string().min(1)).max(3),
    reason: z.string().max(2_000)
  }).strict().optional()
}).strict()
export type ChildRoutingMetadata = z.infer<typeof ChildRoutingMetadata>

export function profileAvailableOnSurface(
  profile: Pick<SubagentProfileConfig, 'surfaces'>,
  surface: 'code' | 'write' | 'design'
): boolean {
  const surfaces = profile.surfaces ?? ['shared']
  return surfaces.includes('shared') || surfaces.includes(surface)
}

export const ChildRunRecord = z.object({
  id: z.string().min(1),
  parentThreadId: z.string().min(1),
  parentTurnId: z.string().min(1),
  agentSurface: z.enum(['code', 'write', 'design']).optional(),
  label: z.string().optional(),
  prompt: z.string().min(1),
  workspace: z.string().optional(),
  model: z.string().optional(),
  /** Resolved provider id the child routed through, when one was selected. */
  providerId: z.string().optional(),
  /** Opaque account id inherited only with the same selected provider route. */
  accountId: z.string().optional(),
  /** Effective reasoning strength used by the child model request. */
  reasoningEffort: ModelReasoningEffort.optional(),
  /** Effective Codex service tier used by the child model request ('fast' = priority). */
  serviceTier: z.literal('priority').optional(),
  /** Resolved subagent profile name, when one was selected. */
  profile: z.string().optional(),
  /** Legacy read compatibility; new child runs never write skillId. */
  skillId: z.string().optional(),
  /** Retrieval/judge decision captured for diagnostics and reproducibility. */
  routing: ChildRoutingMetadata.optional(),
  /** Exact role definition executed by this child, including fixed/workspace profiles. */
  profileSnapshot: SubagentProfileConfig.optional(),
  profileSource: z.enum(['builtin', 'configured', 'workspace', 'custom', 'generated']).optional(),
  profileFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  /** Immutable parent capability boundary captured before the child is queued. */
  security: ChildSecuritySnapshot.optional(),
  /** Effective tool policy applied to the child (read-only vs inherited). */
  toolPolicy: SubagentToolPolicy.optional(),
  /** Parent policy captured when the child was created. */
  approvalPolicy: ApprovalPolicySchema.optional(),
  sandboxMode: SandboxModeSchema.optional(),
  approvalReviewer: ApprovalReviewerSchema.default(DEFAULT_APPROVAL_REVIEWER),
  /** True when this child is detached from the parent turn lifecycle. */
  detached: z.boolean().optional(),
  status: z.enum(['queued', 'running', 'completed', 'failed', 'aborted']),
  summary: z.string().optional(),
  /** Structured PPT review result captured from the child tool stream. */
  reviewBundle: z.unknown().optional(),
  evidence: z.array(z.string().min(1).max(2_000)).max(32).optional(),
  tokenBudget: z.number().int().positive().optional(),
  /** Legacy persisted field. New child runs do not use wall-clock budgets. */
  timeBudgetMs: z.number().int().positive().optional(),
  returnFormat: ChildReturnFormat.default('summary'),
  budgetExceeded: z.enum(['token', 'time']).optional(),
  error: z.string().optional(),
  usage: ChildRunUsage.default({ promptTokens: 0, completionTokens: 0, totalTokens: 0 }),
  /** True when the child reused the main agent's cached stable prefix. */
  prefixReused: z.boolean().optional(),
  /** Parent history items seeded into the child (0 = prefix-only). */
  inheritedHistoryItems: z.number().int().nonnegative().optional(),
  /** Tool calls the child executed during its run. */
  toolInvocations: z.number().int().nonnegative().optional(),
  /** Latest safe activity label mirrored from the child thread. */
  activity: ChildRunActivity.optional(),
  /** Wall-clock spent running (after leaving the queue). */
  durationMs: z.number().int().nonnegative().optional(),
  /** Wall-clock spent waiting for a parallel slot before starting. */
  queuedMs: z.number().int().nonnegative().optional(),
  /** Stable display order for this child inside its parent turn. */
  childSeq: z.number().int().nonnegative().optional(),
  /** Number of follow-up turns appended to this same persistent child session. */
  resumeCount: z.number().int().nonnegative().optional(),
  lastResumeAt: z.string().optional(),
  createdAt: z.string(),
  /** When the child left the queue and began running. */
  startedAt: z.string().optional(),
  updatedAt: z.string()
}).strict()
export type ChildRunRecord = z.infer<typeof ChildRunRecord>

export type ChildRunLifecycleMetadata = {
  model?: string
  providerId?: string
  accountId?: string
  reasoningEffort?: string
  profile?: string
  profileName?: string
}

export type ChildRunExecutor = (input: {
  /** Continue the persisted child thread instead of creating it again. */
  resumeChild?: boolean
  childId: string
  parentThreadId: string
  parentTurnId: string
  label?: string
  /** Resolved subagent profile id (e.g. `general`, `explore`); used for the child thread title. */
  profile?: string
  prompt: string
  workspace?: string
  model?: string
  providerId?: string
  accountId?: string
  clientSurface?: TurnClientSurface
  systemPrompt?: string
  /** When true with a non-empty systemPrompt, skip prepending the Kun base prefix. */
  omitBasePrompt?: boolean
  allowedTools?: string[]
  /** Parent tool/provider/memory boundary; profile permissions may only narrow it. */
  security?: ChildSecuritySnapshot
  /** Built-in tool names blocked for this child (deny-list layered on inherit). */
  blockedTools?: string[]
  /** MCP server ids blocked for this child (deny-list; whole server toolset hidden). */
  blockedMcpServers?: string[]
  /** Skill ids blocked for this child (deny-list; catalog + activation + load_skill). */
  blockedSkills?: string[]
  /** Disable skill discovery and load_skill for standalone profile agents. */
  skillsEnabled?: boolean
  toolPolicy: SubagentToolPolicy
  /** Parent security snapshot; it takes precedence over executor defaults. */
  approvalPolicy?: ApprovalPolicy
  sandboxMode?: SandboxMode
  approvalReviewer?: ApprovalReviewer
  promptPreamble?: string
  /** True when the parent turn is a GUI design-canvas turn. */
  guiDesignCanvas?: boolean
  /** Reasoning depth for this profile's child model requests (default 'off'). */
  reasoningEffort?: string
  /** Effective Codex service tier for this child's model requests ('fast' = priority). */
  serviceTier?: 'priority'
  returnFormat?: ChildReturnFormat
  signal: AbortSignal
}) => Promise<{
  summary: string
  usage?: ChildRunRecord['usage']
  toolInvocations?: number
  prefixReused?: boolean
  inheritedHistoryItems?: number
  reviewBundle?: unknown
  evidence?: string[]
}>

export type ChildRunAggregate = {
  key: string
  label?: string
  model?: string
  runs: number
  completed: number
  failed: number
  aborted: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
  costUsd?: number
  costCny?: number
  averageTotalTokens: number
  averageCostUsd?: number
  averageCostCny?: number
}

export class FileDelegationStore {
  constructor(private readonly rootDir: string) {}

  async upsert(record: ChildRunRecord): Promise<void> {
    await this.ensureRoot()
    const path = join(this.rootDir, `${record.id}.json`)
    await withManagerDataMutex(`delegation-run:${record.id}`, () =>
      isManagerAtomicJsonPath(path)
        ? new AtomicJsonFile(
            path,
            (value) => ChildRunRecord.parse(value)
          ).write(record)
        : writeFile(path, JSON.stringify(record, null, 2), {
            encoding: 'utf8',
            mode: 0o600
          }))
  }

  async get(childId: string): Promise<ChildRunRecord | undefined> {
    await this.ensureRoot()
    try {
      return ChildRunRecord.parse(JSON.parse(await readFile(join(this.rootDir, `${childId}.json`), 'utf8')))
    } catch (error) {
      if (isNotFound(error)) return undefined
      throw error
    }
  }

  async list(parentThreadId?: string): Promise<ChildRunRecord[]> {
    await this.ensureRoot()
    const entries = await readdir(this.rootDir).catch(() => [])
    const records = await Promise.all(entries
      .filter((entry) => entry.endsWith('.json'))
      .map((entry) => readFile(join(this.rootDir, entry), 'utf8')
        .then((text) => ChildRunRecord.parse(JSON.parse(text)))
        .catch(() => null)))
    return records
      .filter((record): record is ChildRunRecord => Boolean(record))
      .filter((record) => !parentThreadId || record.parentThreadId === parentThreadId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  private async ensureRoot(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true, mode: 0o700 })
    await chmod(this.rootDir, 0o700)
  }
}

type SlotWaiter = {
  resolve: () => void
  reject: (error: unknown) => void
  signal: AbortSignal
  onAbort: () => void
}

type RunTurnFn = (threadId: string, turnId: string) => Promise<unknown>

type ChildExecutionState = {
  record: ChildRunRecord
  commits: Promise<void>
}

type ForegroundChildControl = {
  state: ChildExecutionState
  controller: AbortController
  parentThreadId: string
  unlinkParent: () => void
  resolveDetached: () => void
  detachedSettlement: Promise<void>
  resolveDetachedSettlement: () => void
}

export class DelegationRuntime {
  private active = 0
  private childSeq = 0
  private readonly childSeqById = new Map<string, number>()
  /** Children waiting for a parallel slot, in FIFO order. */
  private readonly slotWaiters: SlotWaiter[] = []
  /** Per-thread child counts (persisted + in-flight) for the scheduler limit. */
  private readonly threadCounts = new Map<string, number>()
  /** Cached per-thread seed reads so concurrent first-spawns don't double-count. */
  private readonly threadSeeds = new Map<string, Promise<void>>()
  /**
   * Background (detached) child runs keyed by childId, exposing an
   * AbortController so the user can cancel a long-running task from the
   * GUI even after the parent turn finished.
   */
  private readonly detachedAborts = new Map<string, AbortController>()
  /** Parent thread for each live detached child, used by thread deletion. */
  private readonly detachedParentThreads = new Map<string, string>()
  /** Completion of each detached execution, including persistence and parent notification. */
  private readonly detachedSettlements = new Map<string, Promise<void>>()
  /**
   * Foreground children are executed through an independently-owned signal
   * that is linked to the parent until the user presses Ctrl+B. Keeping this
   * bridge in the runtime (rather than the TUI) makes dynamic backgrounding
   * safe for every client and lets the pending delegate_task return.
   */
  private readonly foregroundChildren = new Map<string, ForegroundChildControl>()
  /** A persistent child thread accepts at most one appended follow-up turn at a time. */
  private readonly resumingChildren = new Set<string>()
  private runTurn: RunTurnFn | null = null

  constructor(private options: {
    config: SubagentsCapabilityConfig
    store: FileDelegationStore
    events?: RuntimeEventRecorder
    eventBus?: EventBus
    threadStore?: ThreadStore
    turns?: TurnService
    nowIso?: () => string
    idGenerator?: () => string
    executor?: ChildRunExecutor
    recordExternalUsage?: (threadId: string, usage: UsageSnapshot) => void
  }) {}

  bindAgentLoop(input: { runTurn: RunTurnFn }): void {
    this.runTurn = input.runTurn
  }

  replaceConfig(config: SubagentsCapabilityConfig): void {
    this.options = {
      ...this.options,
      config
    }
  }

  enabled(): boolean {
    return this.options.config.enabled
  }

  async runChild(input: {
    parentThreadId: string
    parentTurnId: string
    label?: string
    prompt: string
    workspace?: string
    model?: string
    providerId?: string
    accountId?: string
    clientSurface?: TurnClientSurface
    /** Effective parent turn/thread model inherited together with inheritedProviderId. */
    inheritedModel?: string
    /** Parent turn/thread provider id inherited by delegate_task when no profile overrides it. */
    inheritedProviderId?: string
    /** Parent account id paired with inheritedProviderId; never credential material. */
    inheritedAccountId?: string
    /** Effective parent-turn reasoning strength inherited by custom one-run agents. */
    inheritedReasoningEffort?: string
    /** Effective parent-turn Codex service tier ('fast'). Inherited by default-inherit tools unless overridden. */
    inheritedServiceTier?: 'priority'
    /**
     * When true, the child falls back to the parent session's model route,
     * reasoning effort, and service tier wherever the profile does not
     * configure an explicit override (explicit tool overrides still win).
     * Used by first-class tools such as `explore_agent`; delegate_task
     * keeps its existing precedence semantics when this is unset.
     */
    inheritSessionDefaults?: boolean
    /** Explicit Codex service tier override for this child ('fast' = priority). */
    serviceTier?: 'priority'
    /** Effective parent policy captured by the delegating tool call. */
    approvalPolicy?: ApprovalPolicy
    sandboxMode?: SandboxMode
    approvalReviewer?: ApprovalReviewer
    profile?: string
    /** Trusted, one-run-only profile designed by the parent/router; never persisted as config. */
    inlineProfile?: {
      id: string
      profile: SubagentProfileConfig
      source?: 'builtin' | 'configured' | 'workspace' | 'custom' | 'generated'
    }
    routing?: ChildRoutingMetadata
    agentSurface?: 'code' | 'write' | 'design'
    /** Optional task-level maximum applied after profile resolution. */
    toolPolicyCeiling?: 'readOnly'
    /** Immutable parent capability boundary captured by delegate_task. */
    security?: ChildSecuritySnapshot
    /** Forward GUI design-canvas scope into the child turn when present. */
    guiDesignCanvas?: boolean
    returnFormat?: ChildReturnFormat
    /**
     * When true, runChild returns the queued ChildRunRecord immediately and
     * continues execution in the background. The detached run gets its own
     * AbortController so the user can cancel it via `abortChild(id)` even
     * after the parent turn finishes. Default: false (synchronous).
     */
    detach?: boolean
    /**
     * Invoked once, as soon as the child id is allocated (before the child
     * finishes), so the caller can surface the id while the child is still
     * running — e.g. the delegate_task tool emits a partial result so the GUI
     * can offer "open session" mid-run. Carries the resolved profile id so the
     * caller can keep showing the subagent type while it runs.
     */
    onStart?: (childId: string, profile?: string, metadata?: ChildRunLifecycleMetadata) => void
    /** Queued and running are distinct states; callbacks are awaited in order. */
    onQueued?: (childId: string, profile?: string, metadata?: ChildRunLifecycleMetadata) => Promise<void> | void
    onRunning?: (childId: string, profile?: string, metadata?: ChildRunLifecycleMetadata) => Promise<void> | void
    signal: AbortSignal
  }): Promise<ChildRunRecord> {
    const config = this.options.config
    if (!config.enabled) throw new Error('delegation is disabled by config')
    if (input.signal.aborted) throw new Error('child run aborted before routing completed')
    const security = input.security ? ChildSecuritySnapshot.parse(input.security) : undefined
    // The parent boundary is authoritative. A model/profile cannot replace the
    // workspace-write root by supplying another child working directory.
    const workspace = security?.sandboxRoot ?? input.workspace

    // Resolve the profile up front so model/preamble/tool-policy are
    // captured on the record even if the child later fails.
    if (input.profile?.trim() && input.inlineProfile) {
      throw new Error('profile and inlineProfile are mutually exclusive')
    }
    const inlineProfile = input.inlineProfile
      ? {
          id: input.inlineProfile.id.trim(),
          profile: SubagentProfileConfig.parse(input.inlineProfile.profile),
          source: input.inlineProfile.source
        }
      : undefined
    if (inlineProfile && !inlineProfile.id) throw new Error('inlineProfile.id is required')
    const explicitProfileName = input.profile?.trim() || undefined
    const profileName = inlineProfile?.id ?? explicitProfileName ?? config.defaultProfile
    // Workspace overlay: `.kun/agents/*.md` in the call's workspace wins
    // over the static `config.profiles` map. Loaded fresh per call so the
    // user can edit overlays without restarting the runtime.
    const configuredProfile = profileName && Object.prototype.hasOwnProperty.call(config.profiles, profileName)
      ? config.profiles[profileName]
      : undefined
    let profile: SubagentProfileConfig | undefined = inlineProfile?.profile ?? configuredProfile
    let profileSource = inlineProfile?.source ?? (configuredProfile
      ? BUILTIN_SUBAGENT_PROFILES[profileName ?? ''] === configuredProfile ? 'builtin' as const : 'configured' as const
      : undefined)
    if (!inlineProfile && profileName && workspace) {
      const overlay = await loadWorkspaceAgentProfiles(workspace)
      const hit = overlay.find((entry) => entry.id === profileName)
      if (hit) {
        profile = hit.profile
        profileSource = 'workspace'
      }
    }
    if (profileName && !profile) {
      throw new Error(`unknown subagent profile: ${profileName}`)
    }
    if (profile?.mode === 'primary') {
      throw new Error(`subagent profile "${profileName}" is primary-session-only`)
    }
    const agentSurface = input.agentSurface ?? 'code'
    if (!inlineProfile && profile && !profileAvailableOnSurface(profile, agentSurface)) {
      throw new Error(`subagent profile "${profileName}" is unavailable on the ${agentSurface} surface`)
    }
    const toolPolicy = input.toolPolicyCeiling === 'readOnly'
      ? 'readOnly'
      : profile?.toolPolicy ?? config.defaultToolPolicy
    // One-run custom/generated roles follow the user's effective session
    // model, provider, and reasoning selection. Model-authored role content
    // must not silently change how the child runs. Reusable profiles keep
    // their trusted configured precedence.
    const ephemeralAgentInheritsSessionSelection =
      profileSource === 'custom' || profileSource === 'generated'
    const selection = resolveChildModelSelection({
      explicitModel: ephemeralAgentInheritsSessionSelection ? undefined : input.model,
      explicitProviderId: ephemeralAgentInheritsSessionSelection ? undefined : input.providerId,
      profileModel: ephemeralAgentInheritsSessionSelection ? undefined : profile?.model,
      profileProviderId: ephemeralAgentInheritsSessionSelection ? undefined : profile?.providerId,
      inheritedModel: input.inheritedModel,
      inheritedProviderId: input.inheritedProviderId
    })
    const resolvedModel = selection.model
    const resolvedProviderId = selection.providerId
    const resolvedAccountId = sameModelRoute(
      selection,
      input.inheritedModel,
      input.inheritedProviderId
    )
      ? input.inheritedAccountId?.trim()
      : undefined
    const approvalReviewer = input.approvalReviewer ?? DEFAULT_APPROVAL_REVIEWER
    if (
      resolvedProviderId &&
      security?.allowedModelProviderIds &&
      !security.allowedModelProviderIds.includes(resolvedProviderId)
    ) {
      throw new Error(`child model provider ${resolvedProviderId} expands parent authority`)
    }
    if (
      resolvedModel &&
      security?.allowedModelIds &&
      !security.allowedModelIds.includes(resolvedModel)
    ) {
      throw new Error(`child model ${resolvedModel} expands parent authority`)
    }
    const resolvedSystemPrompt = profile?.systemPrompt
    const resolvedOmitBasePrompt = profile?.omitBasePrompt === true
    const resolvedAllowedTools = profile?.allowedTools
    // Delegation is intentionally one level deep. Enforce this in the host,
    // including for user/workspace profiles that forgot to declare a deny-list.
    const resolvedBlockedTools = [...new Set([
      'delegate_task',
      'generate_subagent',
      ...(profile?.blockedTools ?? [])
    ])]
    const resolvedBlockedMcpServers = profile?.blockedMcpServers
    const resolvedBlockedSkills = profile?.blockedSkills
    const resolvedSkillsEnabled = profile?.skillsEnabled ?? true
    const promptPreamble = profile?.promptPreamble
    // Default-inherit tools (e.g. explore_agent) follow the parent session's
    // reasoning strength unless the profile configures an explicit depth;
    // reusable delegate_task profiles keep their existing 'off'-style default.
    const resolvedReasoningEffort = ephemeralAgentInheritsSessionSelection
      ? normalizeInheritedReasoningEffort(input.inheritedReasoningEffort)
      : input.inheritSessionDefaults === true
        ? profile?.reasoningEffort ?? normalizeInheritedReasoningEffort(input.inheritedReasoningEffort)
        : profile?.reasoningEffort
    // Explicit tool override wins; otherwise default-inherit tools adopt the
    // parent turn's Codex service tier ('fast'). The child model request is
    // still capability-gated downstream (Codex + priority-capable only).
    const resolvedServiceTier =
      input.serviceTier ??
      (input.inheritSessionDefaults === true ? input.inheritedServiceTier : undefined)
    const returnFormat = input.returnFormat ?? 'summary'

    // Reserve against the per-thread child-count limit before persisting anything.
    await this.ensureSeeded(input.parentThreadId)
    if (!this.reserveChild(input.parentThreadId)) {
      throw new Error('delegation child-run limit exhausted')
    }

    const queuedAt = this.now()
    const id = this.options.idGenerator?.() ?? `child_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    let record = ChildRunRecord.parse({
      id,
      parentThreadId: input.parentThreadId,
      parentTurnId: input.parentTurnId,
      agentSurface,
      label: input.label,
      prompt: input.prompt,
      workspace,
      model: resolvedModel,
      providerId: resolvedProviderId,
      accountId: resolvedAccountId,
      reasoningEffort: resolvedReasoningEffort,
      ...(resolvedServiceTier ? { serviceTier: resolvedServiceTier } : {}),
      profile: profileName,
      ...(input.routing ? { routing: ChildRoutingMetadata.parse(input.routing) } : {}),
      ...(profile ? { profileSnapshot: profile } : {}),
      ...(profileSource ? { profileSource } : {}),
      ...(profile ? { profileFingerprint: fingerprintProfile(profile) } : {}),
      ...(security ? { security } : {}),
      toolPolicy,
      ...(input.approvalPolicy ? { approvalPolicy: input.approvalPolicy } : {}),
      ...(input.sandboxMode ? { sandboxMode: input.sandboxMode } : {}),
      approvalReviewer,
      returnFormat,
      ...(input.detach ? { detached: true } : {}),
      status: 'queued',
      childSeq: this.nextChildSeq(id),
      createdAt: queuedAt,
      updatedAt: queuedAt
    })
    await this.options.store.upsert(record)
    await this.recordChildEvent(record)
    // Surface allocation as queued. Running is emitted only after a scheduler
    // slot has actually been acquired.
    await notifyLifecycle(input.onQueued, record)
    try {
      input.onStart?.(record.id, profileName, childLifecycleMetadata(record))
    } catch {
      // UI observers cannot prevent or strand an already-persisted child.
    }

    if (input.detach) {
      if (input.signal.aborted) {
        record = ChildRunRecord.parse({
          ...record,
          status: 'aborted',
          error: 'child run aborted before detached execution started',
          updatedAt: this.now()
        })
        await this.options.store.upsert(record)
        await this.recordChildEvent(record)
        return record
      }
      // Spawn an independent signal so the parent turn's signal aborting
      // doesn't reach into the background run. The user can still cancel
      // via abortChild(id).
      const detachedController = new AbortController()
      this.detachedAborts.set(record.id, detachedController)
      this.detachedParentThreads.set(record.id, input.parentThreadId)
      const logIgnoredParentAbort = (): void => {
        console.warn(`[kun] detached subagent ignored parent abort child=${record.id} parentThread=${input.parentThreadId} parentTurn=${input.parentTurnId}`)
      }
      if (input.signal.aborted) logIgnoredParentAbort()
      else input.signal.addEventListener('abort', logIgnoredParentAbort, { once: true })
      console.warn(`[kun] detached subagent started with independent abort signal child=${record.id} parentThread=${input.parentThreadId} parentTurn=${input.parentTurnId}`)
      const state: ChildExecutionState = { record, commits: Promise.resolve() }
      // Surface ChildRunExecutor's resolved fields via the closure shared with
      // the synchronous path. The same executor block runs inside executeChild.
      const completion = this.executeChild({
        state,
        queuedAt,
        profileName,
        toolPolicy,
        resolvedModel,
        resolvedProviderId,
        resolvedAccountId,
        resolvedSystemPrompt,
        resolvedOmitBasePrompt,
        resolvedAllowedTools,
        resolvedBlockedTools,
        resolvedBlockedMcpServers,
        resolvedBlockedSkills,
        skillsEnabled: resolvedSkillsEnabled,
        promptPreamble,
        approvalPolicy: input.approvalPolicy,
        sandboxMode: input.sandboxMode,
        approvalReviewer,
        clientSurface: input.clientSurface,
        guiDesignCanvas: input.guiDesignCanvas === true,
        resolvedReasoningEffort,
        resolvedServiceTier,
        returnFormat,
        workspace,
        security,
        onRunning: input.onRunning,
        label: input.label,
        parentThreadId: input.parentThreadId,
        parentTurnId: input.parentTurnId,
        prompt: input.prompt,
        signal: detachedController.signal
      })
        .then((settled) => this.notifyDetachedChild(settled))
        .catch(() => undefined)
        .finally(() => {
          input.signal.removeEventListener('abort', logIgnoredParentAbort)
          this.detachedAborts.delete(record.id)
          this.detachedParentThreads.delete(record.id)
          this.detachedSettlements.delete(record.id)
          console.warn(`[kun] detached subagent finished background tracking child=${record.id}`)
        })
      this.detachedSettlements.set(record.id, completion)
      return record
    }

    const state: ChildExecutionState = { record, commits: Promise.resolve() }
    const controller = new AbortController()
    const abortFromParent = (): void => controller.abort()
    if (input.signal.aborted) controller.abort()
    else input.signal.addEventListener('abort', abortFromParent, { once: true })
    let resolveDetached = (): void => undefined
    const detached = new Promise<void>((resolve) => { resolveDetached = resolve })
    let resolveDetachedSettlement = (): void => undefined
    const detachedSettlement = new Promise<void>((resolve) => { resolveDetachedSettlement = resolve })
    const control: ForegroundChildControl = {
      state,
      controller,
      parentThreadId: input.parentThreadId,
      unlinkParent: () => input.signal.removeEventListener('abort', abortFromParent),
      resolveDetached,
      detachedSettlement,
      resolveDetachedSettlement
    }
    this.foregroundChildren.set(record.id, control)
    const execution = this.executeChild({
      state,
      queuedAt,
      profileName,
      toolPolicy,
      resolvedModel,
      resolvedProviderId,
      resolvedAccountId,
      resolvedSystemPrompt,
      resolvedOmitBasePrompt,
      resolvedAllowedTools,
      resolvedBlockedTools,
      resolvedBlockedMcpServers,
      resolvedBlockedSkills,
      skillsEnabled: resolvedSkillsEnabled,
      promptPreamble,
      approvalPolicy: input.approvalPolicy,
      sandboxMode: input.sandboxMode,
      approvalReviewer,
      clientSurface: input.clientSurface,
      guiDesignCanvas: input.guiDesignCanvas === true,
      resolvedReasoningEffort,
      resolvedServiceTier,
      returnFormat,
      workspace,
      security,
      onRunning: input.onRunning,
      label: input.label,
      parentThreadId: input.parentThreadId,
      parentTurnId: input.parentTurnId,
      prompt: input.prompt,
      signal: controller.signal
    })
    const first = await Promise.race([
      execution.then((settled) => ({ kind: 'settled' as const, settled })),
      detached.then(() => ({ kind: 'detached' as const }))
    ])
    if (first.kind === 'settled') {
      control.unlinkParent()
      this.foregroundChildren.delete(record.id)
      return first.settled
    }

    // The tool call is released immediately, while the same child execution
    // continues under the detached controller and reports back on completion.
    control.unlinkParent()
    this.foregroundChildren.delete(record.id)
    void execution
      .then((settled) => this.notifyDetachedChild(settled))
      .catch(() => undefined)
      .finally(() => {
        this.detachedAborts.delete(record.id)
        this.detachedParentThreads.delete(record.id)
        this.detachedSettlements.delete(record.id)
        control.resolveDetachedSettlement()
      })
    return state.record
  }

  async resumeChild(input: {
    childId: string
    parentThreadId: string
    parentTurnId: string
    prompt: string
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
    const profileSnapshot = previous.profileSnapshot
    const security = previous.security
    const workspace = previous.workspace
    if (!profileSnapshot || !security || !workspace) {
      throw new Error(`child run ${input.childId} lacks a resumable security/profile snapshot`)
    }
    if (input.signal.aborted) throw new Error('child resume aborted before start')

    const queuedAt = this.now()
    const record = ChildRunRecord.parse({
      ...previous,
      prompt: input.prompt,
      parentTurnId: input.parentTurnId,
      status: 'queued',
      summary: undefined,
      reviewBundle: undefined,
      evidence: undefined,
      error: undefined,
      activity: undefined,
      detached: undefined,
      queuedMs: undefined,
      durationMs: undefined,
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
  private async executeChild(args: {
    state: ChildExecutionState
    queuedAt: string
    profileName: string | undefined
    toolPolicy: SubagentToolPolicy
    resolvedModel: string | undefined
    resolvedProviderId: string | undefined
    resolvedAccountId: string | undefined
    resolvedSystemPrompt: string | undefined
    resolvedOmitBasePrompt: boolean
    resolvedAllowedTools: string[] | undefined
    resolvedBlockedTools: string[] | undefined
    resolvedBlockedMcpServers: string[] | undefined
    resolvedBlockedSkills: string[] | undefined
    skillsEnabled: boolean
    promptPreamble: string | undefined
    approvalPolicy: ApprovalPolicy | undefined
    sandboxMode: SandboxMode | undefined
    approvalReviewer: ApprovalReviewer
    clientSurface: TurnClientSurface | undefined
    guiDesignCanvas: boolean
    resolvedReasoningEffort: string | undefined
    resolvedServiceTier: 'priority' | undefined
    returnFormat: ChildReturnFormat
    workspace: string | undefined
    security: ChildSecuritySnapshot | undefined
    onRunning: ((childId: string, profile?: string, metadata?: ChildRunLifecycleMetadata) => Promise<void> | void) | undefined
    label: string | undefined
    parentThreadId: string
    parentTurnId: string
    prompt: string
    resumeChild?: boolean
    signal: AbortSignal
  }): Promise<ChildRunRecord> {
    let record = args.state.record
    try {
      await this.acquireSlot(args.signal)
    } catch (error) {
      record = await this.commitChildState(args.state, (current) => ChildRunRecord.parse({
        ...current,
        status: 'aborted',
        error: errorMessage(error),
        updatedAt: this.now()
      }))
      return record
    }

    const startedAt = this.now()
    const queuedMs = elapsedMs(args.queuedAt, startedAt)
    record = await this.commitChildState(args.state, (current) => ChildRunRecord.parse({
      ...current,
      status: 'running',
      startedAt,
      queuedMs,
      updatedAt: startedAt
    }))
    await notifyLifecycle(args.onRunning, record)
    const unsubscribeActivity = this.options.eventBus?.subscribe(record.id, (event) => {
      void this.projectChildActivity(args.state, event)
    })
    try {
      const executor: ChildRunExecutor = this.options.executor ?? defaultExecutor
      const result = await executeWithParentSignal(args.signal, (signal) => executor({
        ...(args.resumeChild ? { resumeChild: true } : {}),
        childId: record.id,
        parentThreadId: args.parentThreadId,
        parentTurnId: args.parentTurnId,
        ...(args.label ? { label: args.label } : {}),
        ...(args.profileName ? { profile: args.profileName } : {}),
        prompt: args.prompt,
        workspace: args.workspace,
        model: args.resolvedModel,
        ...(args.resolvedProviderId ? { providerId: args.resolvedProviderId } : {}),
        ...(args.resolvedAccountId ? { accountId: args.resolvedAccountId } : {}),
        ...(args.resolvedSystemPrompt ? { systemPrompt: args.resolvedSystemPrompt } : {}),
        ...(args.resolvedOmitBasePrompt ? { omitBasePrompt: true } : {}),
        ...(args.resolvedAllowedTools ? { allowedTools: args.resolvedAllowedTools } : {}),
        ...(args.security ? { security: args.security } : {}),
        ...(args.resolvedBlockedTools ? { blockedTools: args.resolvedBlockedTools } : {}),
        ...(args.resolvedBlockedMcpServers ? { blockedMcpServers: args.resolvedBlockedMcpServers } : {}),
        ...(args.resolvedBlockedSkills ? { blockedSkills: args.resolvedBlockedSkills } : {}),
        skillsEnabled: args.skillsEnabled,
        toolPolicy: args.toolPolicy,
        ...(args.approvalPolicy ? { approvalPolicy: args.approvalPolicy } : {}),
        ...(args.sandboxMode ? { sandboxMode: args.sandboxMode } : {}),
        approvalReviewer: args.approvalReviewer,
        ...(args.clientSurface ? { clientSurface: args.clientSurface } : {}),
        ...(args.promptPreamble ? { promptPreamble: args.promptPreamble } : {}),
        ...(args.guiDesignCanvas ? { guiDesignCanvas: true } : {}),
        ...(args.resolvedReasoningEffort ? { reasoningEffort: args.resolvedReasoningEffort } : {}),
        ...(args.resolvedServiceTier ? { serviceTier: args.resolvedServiceTier } : {}),
        returnFormat: args.returnFormat,
        signal
      }))
      const finishedAt = this.now()
      const contractError = childContractError(args.returnFormat, result.evidence)
      record = await this.commitChildState(args.state, (current) => ChildRunRecord.parse({
        ...current,
        status: contractError ? 'failed' : 'completed',
        summary: result.summary,
        reviewBundle: result.reviewBundle,
        evidence: result.evidence,
        usage: addChildUsage(current.usage, result.usage),
        toolInvocations: result.toolInvocations,
        prefixReused: result.prefixReused,
        inheritedHistoryItems: result.inheritedHistoryItems,
        ...(contractError ? { error: contractError } : {}),
        durationMs: elapsedMs(startedAt, finishedAt),
        updatedAt: finishedAt
      }))
      this.recordExternalUsage(record)
      return record
    } catch (error) {
      const finishedAt = this.now()
      record = await this.commitChildState(args.state, (current) => ChildRunRecord.parse({
        ...current,
        status: args.signal.aborted ? 'aborted' : 'failed',
        error: errorMessage(error),
        durationMs: elapsedMs(startedAt, finishedAt),
        updatedAt: finishedAt
      }))
      return record
    } finally {
      unsubscribeActivity?.()
      this.releaseSlot()
    }
  }

  private async projectChildActivity(state: ChildExecutionState, event: RuntimeEvent): Promise<void> {
    const nextActivity = childActivityFromEvent(event, state.record.activity)
    if (!nextActivity) return
    await this.commitChildState(state, (current) => {
      if (current.status !== 'running') return undefined
      if (sameChildActivity(current.activity, nextActivity)) return undefined
      return ChildRunRecord.parse({
        ...current,
        activity: nextActivity,
        updatedAt: nextActivity.updatedAt
      })
    })
  }

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
   * Serialize mutations for one child so a completion racing a Ctrl+B
   * background request cannot be overwritten by an older running snapshot.
   */
  private async commitChildState(
    state: ChildExecutionState,
    mutate: (current: ChildRunRecord) => ChildRunRecord | undefined
  ): Promise<ChildRunRecord> {
    let committed = state.record
    const operation = state.commits.catch(() => undefined).then(async () => {
      const next = mutate(state.record)
      if (!next) {
        committed = state.record
        return
      }
      state.record = next
      committed = next
      await this.options.store.upsert(next)
      await this.recordChildEvent(next)
    })
    state.commits = operation
    await operation
    return committed
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

  /** Concurrency ceiling; clamps to at least 1 so an enabled runtime never deadlocks. */
  private get parallelLimit(): number {
    return Math.max(1, this.options.config.maxParallel)
  }

  /** Acquire a parallel slot, queueing (FIFO) when the runtime is saturated. */
  private acquireSlot(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(new Error('aborted while queued'))
    if (this.active < this.parallelLimit) {
      this.active += 1
      return Promise.resolve()
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: SlotWaiter = {
        resolve,
        reject,
        signal,
        onAbort: () => {
          const index = this.slotWaiters.indexOf(waiter)
          if (index >= 0) this.slotWaiters.splice(index, 1)
          reject(new Error('aborted while queued'))
        }
      }
      signal.addEventListener('abort', waiter.onAbort, { once: true })
      this.slotWaiters.push(waiter)
    })
  }

  /** Hand the freed slot to the next waiter, or shrink the active count. */
  private releaseSlot(): void {
    const next = this.slotWaiters.shift()
    if (next) {
      next.signal.removeEventListener('abort', next.onAbort)
      next.resolve() // slot is handed over directly; `active` stays the same
    } else {
      this.active = Math.max(0, this.active - 1)
    }
  }

  /** Seed the per-thread budget counter from persisted records exactly once. */
  private ensureSeeded(threadId: string): Promise<void> {
    let seed = this.threadSeeds.get(threadId)
    if (!seed) {
      seed = this.options.store
        .list(threadId)
        .then((runs) => {
          if (!this.threadCounts.has(threadId)) this.threadCounts.set(threadId, runs.length)
        })
        .catch(() => {
          if (!this.threadCounts.has(threadId)) this.threadCounts.set(threadId, 0)
        })
      this.threadSeeds.set(threadId, seed)
    }
    return seed
  }

  /** Atomically reserve a budget slot; returns false when the cap is reached. */
  private reserveChild(threadId: string): boolean {
    const used = this.threadCounts.get(threadId) ?? 0
    if (used >= this.options.config.maxChildRuns) return false
    this.threadCounts.set(threadId, used + 1)
    return true
  }

  /** Configured profiles, surfaced to the delegate_task tool schema/UI. */
  listProfiles(): { name: string; mode: SubagentMode; toolPolicy: SubagentToolPolicy; model?: string; providerId?: string; description?: string }[] {
    return Object.entries(this.options.config.profiles).map(([name, profile]) => ({
      name,
      mode: profile.mode,
      toolPolicy: profile.toolPolicy,
      ...(profile.model ? { model: profile.model } : {}),
      ...(profile.providerId ? { providerId: profile.providerId } : {}),
      ...(profile.description ? { description: profile.description } : {})
    }))
  }

  /**
   * Workspace `.kun/agents/*.md` overlays for the GUI roster.
   * Returned separately from `listProfiles()` so Settings/Sidebar can merge
   * them without rewriting persistent GUI settings.
   */
  async listWorkspaceProfiles(workspace: string): Promise<Array<{
    id: string
    source: 'workspace'
    filePath: string
    name?: string
    description?: string
    mode: SubagentMode
    toolPolicy: SubagentToolPolicy
    color?: string
    systemPrompt?: string
    promptPreamble?: string
    allowedTools?: string[]
    blockedTools?: string[]
    omitBasePrompt?: boolean
  }>> {
    const overlay = await loadWorkspaceAgentProfiles(workspace)
    return overlay.map((entry) => ({
      id: entry.id,
      source: 'workspace' as const,
      filePath: entry.filePath,
      ...(entry.profile.name ? { name: entry.profile.name } : {}),
      ...(entry.profile.description ? { description: entry.profile.description } : {}),
      mode: entry.profile.mode,
      toolPolicy: entry.profile.toolPolicy,
      ...(entry.profile.color ? { color: entry.profile.color } : {}),
      ...(entry.profile.systemPrompt ? { systemPrompt: entry.profile.systemPrompt } : {}),
      ...(entry.profile.promptPreamble ? { promptPreamble: entry.profile.promptPreamble } : {}),
      ...(entry.profile.allowedTools ? { allowedTools: entry.profile.allowedTools } : {}),
      ...(entry.profile.blockedTools ? { blockedTools: entry.profile.blockedTools } : {}),
      ...(entry.profile.omitBasePrompt ? { omitBasePrompt: true } : {})
    }))
  }

  /** Resolve one explicit profile once so routing and execution share a snapshot. */
  async resolveProfileSnapshot(
    profileId: string,
    workspace?: string,
    agentSurface: 'code' | 'write' | 'design' = 'code'
  ): Promise<{ id: string; source: 'builtin' | 'configured' | 'workspace'; profile: SubagentProfileConfig } | undefined> {
    const id = profileId.trim()
    if (!id) return undefined
    if (workspace) {
      const hit = (await loadWorkspaceAgentProfiles(workspace)).find((entry) => entry.id === id)
      if (hit) {
        return profileAvailableOnSurface(hit.profile, agentSurface)
          ? { id, source: 'workspace', profile: hit.profile }
          : undefined
      }
    }
    if (!Object.prototype.hasOwnProperty.call(this.options.config.profiles, id)) return undefined
    const profile = this.options.config.profiles[id]
    if (!profile) return undefined
    if (!profileAvailableOnSurface(profile, agentSurface)) return undefined
    return {
      id,
      source: BUILTIN_SUBAGENT_PROFILES[id] === profile ? 'builtin' : 'configured',
      profile
    }
  }

  /** Profiles visible to automatic routing, including workspace overlays. */
  async listRoutingProfiles(
    workspace?: string,
    agentSurface: 'code' | 'write' | 'design' = 'code'
  ): Promise<SubagentRoutingDocument[]> {
    const profiles = new Map<string, SubagentProfileConfig>(Object.entries(this.options.config.profiles))
    const sources = new Map<string, 'builtin' | 'configured' | 'workspace'>(
      Object.entries(this.options.config.profiles).map(([id, profile]) => [
        id,
        BUILTIN_SUBAGENT_PROFILES[id] === profile ? 'builtin' : 'configured'
      ])
    )
    if (workspace) {
      const overlay = await loadWorkspaceAgentProfiles(workspace)
      for (const entry of overlay) {
        profiles.set(entry.id, entry.profile)
        sources.set(entry.id, 'workspace')
      }
    }
    return [...profiles.entries()]
      .filter(([, profile]) => profile.mode !== 'primary' && profileAvailableOnSurface(profile, agentSurface))
      .map(([id, profile]) => ({
        kind: 'profile' as const,
        id,
        source: sources.get(id) ?? 'configured',
        profile,
        ...(BUILTIN_AGENT_CATALOG_BY_ID[id]?.routingTerms
          ? { routingTerms: BUILTIN_AGENT_CATALOG_BY_ID[id]!.routingTerms }
          : {})
      }))
      .sort((left, right) => left.id.localeCompare(right.id))
  }

  get defaultProfileName(): string | undefined {
    return this.options.config.defaultProfile
  }

  get useExistingAgents(): boolean {
    return this.options.config.useExistingAgents
  }

  get defaultToolPolicy(): SubagentToolPolicy {
    return this.options.config.defaultToolPolicy
  }

  async diagnostics(parentThreadId?: string): Promise<{
    enabled: boolean
    active: number
    childRuns: ChildRunRecord[]
    aggregates: ChildRunAggregate[]
  }> {
    const childRuns = await this.options.store.list(parentThreadId)
    return {
      enabled: this.options.config.enabled,
      active: this.active,
      childRuns,
      aggregates: aggregateChildRuns(childRuns)
    }
  }

  private async recordChildEvent(record: ChildRunRecord): Promise<void> {
    const usage = record.usage
    await this.options.events?.record({
      kind: record.status === 'completed' ? 'turn_completed' : record.status === 'failed' ? 'turn_failed' : record.status === 'aborted' ? 'turn_aborted' : 'turn_started',
      threadId: record.parentThreadId,
      turnId: record.parentTurnId,
      status: record.status,
      text: record.summary ?? record.error,
      child: {
        parentThreadId: record.parentThreadId,
        parentTurnId: record.parentTurnId,
        childId: record.id,
        childLabel: record.label,
        childStatus: record.status,
        childSeq: this.stableChildSeq(record),
        ...(record.detached ? { detached: true } : {}),
        ...(record.model ? { childModel: record.model } : {}),
        ...(record.providerId ? { childProviderId: record.providerId } : {}),
        ...(record.profile ? { childProfile: record.profile } : {}),
        ...(record.profileSnapshot?.name ? { childProfileName: record.profileSnapshot.name } : {}),
        ...(record.toolPolicy ? { childToolPolicy: record.toolPolicy } : {}),
        ...(record.prefixReused !== undefined ? { prefixReused: record.prefixReused } : {}),
        ...(record.inheritedHistoryItems !== undefined ? { inheritedHistoryItems: record.inheritedHistoryItems } : {}),
        ...(record.toolInvocations !== undefined ? { toolInvocations: record.toolInvocations } : {}),
        ...(record.durationMs !== undefined ? { durationMs: record.durationMs } : {}),
        ...(record.queuedMs !== undefined ? { queuedMs: record.queuedMs } : {}),
        ...(usage.totalTokens > 0 ? { totalTokens: usage.totalTokens } : {}),
        ...(usage.cacheHitRate !== undefined && usage.cacheHitRate !== null ? { cacheHitRate: usage.cacheHitRate } : {}),
        ...(usage.costUsd !== undefined ? { costUsd: usage.costUsd } : {}),
        ...(usage.costCny !== undefined ? { costCny: usage.costCny } : {}),
        ...(record.activity ? { activity: record.activity } : {})
      }
    })
  }

  private nextChildSeq(childId: string): number {
    const existing = this.childSeqById.get(childId)
    if (existing !== undefined) return existing
    const next = ++this.childSeq
    this.childSeqById.set(childId, next)
    return next
  }

  private stableChildSeq(record: ChildRunRecord): number {
    if (record.childSeq !== undefined) {
      this.childSeqById.set(record.id, record.childSeq)
      this.childSeq = Math.max(this.childSeq, record.childSeq)
      return record.childSeq
    }
    return this.nextChildSeq(record.id)
  }

  private recordExternalUsage(record: ChildRunRecord): void {
    const usage = toUsageSnapshot(record.usage)
    if (usage.totalTokens <= 0 && usage.costUsd === undefined && usage.costCny === undefined) return
    this.options.recordExternalUsage?.(record.parentThreadId, usage)
  }

  private async notifyDetachedChild(record: ChildRunRecord): Promise<void> {
    if (record.status !== 'completed' && record.status !== 'failed') return
    if (!this.options.threadStore || !this.options.turns || !this.runTurn) return
    const thread = await this.options.threadStore.get(record.parentThreadId)
    if (!thread) return
    const notice = formatDetachedChildNotice(record)
    const displayText = formatDetachedChildDisplayText(record)
    if (thread.status === 'running') {
      const runningTurn = [...thread.turns].reverse().find((turn) => turn.status === 'running')
      if (runningTurn) {
        await this.options.turns.steerTurn({
          threadId: record.parentThreadId,
          turnId: runningTurn.id,
          text: notice,
          displayText,
          messageSource: 'background_subagent'
        })
        return
      }
    }
    const sourceTurn = thread.turns.find((turn) => turn.id === record.parentTurnId) ?? thread.turns.at(-1)
    const started = await this.options.turns.startTurn({
      threadId: record.parentThreadId,
      request: {
        prompt: notice,
        ...(sourceTurn ? { clientSurface: resolveTurnClientSurface(sourceTurn) } : {}),
        ...(sourceTurn?.disableUserInput ? { disableUserInput: true } : {}),
        displayText,
        messageSource: 'background_subagent'
      }
    })
    void this.runTurn(record.parentThreadId, started.turnId)
  }

  private now(): string {
    return this.options.nowIso?.() ?? new Date().toISOString()
  }
}

function resolveChildModelSelection(input: {
  explicitModel?: string
  explicitProviderId?: string
  profileModel?: string
  profileProviderId?: string
  inheritedModel?: string
  inheritedProviderId?: string
}): { model?: string; providerId?: string } {
  return (
    completeModelProviderPair('explicit child override', input.explicitModel, input.explicitProviderId) ??
    completeModelProviderPair('subagent profile', input.profileModel, input.profileProviderId) ??
    completeModelProviderPair(
      'inherited parent selection',
      input.inheritedModel,
      input.inheritedProviderId,
      { allowDefaultProvider: true }
    ) ??
    {}
  )
}

function sameModelRoute(
  selected: { model?: string; providerId?: string },
  inheritedModel: string | undefined,
  inheritedProviderId: string | undefined
): boolean {
  return (
    selected.model === inheritedModel?.trim() &&
    (selected.providerId ?? '') === (inheritedProviderId?.trim() ?? '')
  )
}

function completeModelProviderPair(
  source: string,
  rawModel: string | undefined,
  rawProviderId: string | undefined,
  options: { allowDefaultProvider?: boolean } = {}
): { model: string; providerId?: string } | undefined {
  const model = rawModel?.trim()
  const providerId = rawProviderId?.trim()
  if (!model && !providerId) return undefined
  // A normal parent turn on the runtime's default provider has an effective
  // model but no explicit providerId. Preserve that selection as one source;
  // absence here means "runtime default", not a field to fill from elsewhere.
  if (model && !providerId && options.allowDefaultProvider) return { model }
  if (!model || !providerId) {
    const missing = model ? 'providerId' : 'model'
    throw new Error(
      `${source} must configure model and providerId together; missing ${missing}`
    )
  }
  return { model, providerId }
}

function toUsageSnapshot(usage: ChildRunRecord['usage']): UsageSnapshot {
  return {
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    totalTokens: usage.totalTokens,
    cachedTokens: usage.cachedTokens,
    cacheHitTokens: usage.cacheHitTokens,
    cacheMissTokens: usage.cacheMissTokens,
    cacheHitRate: usage.cacheHitRate ?? null,
    turns: usage.turns ?? 0,
    costUsd: usage.costUsd,
    costCny: usage.costCny,
    cacheSavingsUsd: usage.cacheSavingsUsd,
    cacheSavingsCny: usage.cacheSavingsCny,
    tokenEconomySavingsTokens: usage.tokenEconomySavingsTokens,
    tokenEconomySavingsUsd: usage.tokenEconomySavingsUsd,
    tokenEconomySavingsCny: usage.tokenEconomySavingsCny
  }
}

export function aggregateChildRuns(records: readonly ChildRunRecord[]): ChildRunAggregate[] {
  const buckets = new Map<string, ChildRunAggregate>()
  for (const record of records) {
    const label = record.label?.trim() || undefined
    const model = record.model?.trim() || undefined
    const key = `${label ?? 'unlabeled'}:${model ?? 'default'}`
    const bucket = buckets.get(key) ?? {
      key,
      ...(label ? { label } : {}),
      ...(model ? { model } : {}),
      runs: 0,
      completed: 0,
      failed: 0,
      aborted: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      averageTotalTokens: 0
    }
    bucket.runs += 1
    if (record.status === 'completed') bucket.completed += 1
    else if (record.status === 'failed') bucket.failed += 1
    else if (record.status === 'aborted') bucket.aborted += 1
    bucket.promptTokens += record.usage.promptTokens
    bucket.completionTokens += record.usage.completionTokens
    bucket.totalTokens += record.usage.totalTokens
    if (record.usage.costUsd !== undefined) bucket.costUsd = (bucket.costUsd ?? 0) + record.usage.costUsd
    if (record.usage.costCny !== undefined) bucket.costCny = (bucket.costCny ?? 0) + record.usage.costCny
    bucket.averageTotalTokens = bucket.runs > 0 ? bucket.totalTokens / bucket.runs : 0
    bucket.averageCostUsd = bucket.costUsd !== undefined && bucket.runs > 0 ? bucket.costUsd / bucket.runs : undefined
    bucket.averageCostCny = bucket.costCny !== undefined && bucket.runs > 0 ? bucket.costCny / bucket.runs : undefined
    buckets.set(key, bucket)
  }
  return [...buckets.values()].sort((a, b) =>
    b.runs - a.runs ||
    b.totalTokens - a.totalTokens ||
    a.key.localeCompare(b.key)
  )
}

async function executeWithParentSignal<T>(
  parentSignal: AbortSignal,
  execute: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  if (parentSignal.aborted) throw new Error('child run aborted')
  return execute(parentSignal)
}

function childContractError(
  returnFormat: ChildReturnFormat,
  evidence: string[] | undefined
): string | undefined {
  if (returnFormat === 'evidence' && !evidence?.some((item) => item.trim().length > 0)) {
    return 'child contract requires evidence but none was returned'
  }
  return undefined
}

function fingerprintProfile(profile: SubagentProfileConfig): string {
  return createHash('sha256')
    .update(JSON.stringify(profile, Object.keys(profile).sort()))
    .digest('hex')
}

async function notifyLifecycle(
  callback: ((childId: string, profile?: string, metadata?: ChildRunLifecycleMetadata) => Promise<void> | void) | undefined,
  record: ChildRunRecord
): Promise<void> {
  try {
    await callback?.(record.id, record.profile, childLifecycleMetadata(record))
  } catch {
    // Lifecycle updates are observational; persisted child state remains the
    // authority and a renderer disconnect must not consume a scheduler slot.
  }
}

function childLifecycleMetadata(record: ChildRunRecord): ChildRunLifecycleMetadata {
  return {
    ...(record.model ? { model: record.model } : {}),
    ...(record.providerId ? { providerId: record.providerId } : {}),
    ...(record.accountId ? { accountId: record.accountId } : {}),
    ...(record.reasoningEffort ? { reasoningEffort: record.reasoningEffort } : {}),
    ...(record.profile ? { profile: record.profile } : {}),
    ...(record.profileSnapshot?.name ? { profileName: record.profileSnapshot.name } : {})
  }
}

function normalizeInheritedReasoningEffort(value: string | undefined): z.infer<typeof ModelReasoningEffort> {
  const parsed = ModelReasoningEffort.safeParse(value?.trim().toLowerCase())
  return parsed.success ? parsed.data : 'auto'
}

function formatDetachedChildDisplayText(record: ChildRunRecord): string {
  const label = record.label?.trim() || record.profile?.trim() || record.id
  return `Background subagent ${label} ${record.status}`
}

function formatDetachedChildNotice(record: ChildRunRecord): string {
  const label = record.label?.trim() || record.profile?.trim() || record.id
  const lines = [
    '<background_subagent_completed>',
    `<child_id>${escapeXml(record.id)}</child_id>`,
    `<label>${escapeXml(label)}</label>`,
    `<status>${record.status === 'failed' ? 'failed' : 'completed'}</status>`
  ]
  if (record.summary?.trim()) {
    lines.push(`<summary>${escapeXml(record.summary.trim())}</summary>`)
  }
  if (record.error?.trim()) {
    lines.push(`<error>${escapeXml(record.error.trim())}</error>`)
  }
  lines.push('</background_subagent_completed>')
  return lines.join('\n')
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function childActivityFromEvent(
  event: RuntimeEvent,
  previous?: ChildRunActivityValue
): ChildRunActivityValue | undefined {
  let phase: ChildRunActivityValue['phase'] | undefined
  let label: string | undefined
  let toolName: string | undefined
  switch (event.kind) {
    case 'turn_started':
      phase = 'starting'
      label = 'Waiting for model'
      break
    case 'assistant_reasoning_delta':
      phase = 'thinking'
      label = 'Thinking'
      break
    case 'assistant_text_delta':
      phase = 'responding'
      label = 'Writing response'
      break
    case 'tool_call_started':
      if (event.item.kind !== 'tool_call') break
      phase = 'tool'
      toolName = event.item.toolName
      label = event.item.summary?.trim() || `Running ${event.item.toolName}`
      break
    case 'tool_call_finished':
      phase = 'starting'
      label = 'Processing tool result'
      break
    case 'model_request_retry':
      phase = 'retrying'
      label = `Retrying model request ${event.attempt}/${event.maxAttempts}`
      break
    case 'tool_result_upload_wait':
      phase = 'waiting'
      label = 'Waiting for tool results'
      break
    case 'compaction_started':
      phase = 'compacting'
      label = event.summary?.trim() || 'Compacting context'
      break
    case 'compaction_completed':
      phase = 'starting'
      label = 'Continuing'
      break
    case 'approval_requested':
      phase = 'waiting'
      toolName = event.toolName
      label = 'Waiting for approval'
      break
    case 'pipeline_stage':
      if (event.stage !== 'pre_send') break
      phase = 'starting'
      label = event.label?.trim() || 'Calling model'
      break
    case 'item_created':
    case 'item_updated':
    case 'item_completed':
      if (event.item.kind === 'assistant_reasoning' && event.item.status === 'running') {
        phase = 'thinking'
        label = 'Thinking'
      } else if (event.item.kind === 'assistant_text' && event.item.status === 'running') {
        phase = 'responding'
        label = 'Writing response'
      } else if (event.item.kind === 'tool_call' && event.item.status === 'running') {
        phase = 'tool'
        toolName = event.item.toolName
        label = event.item.summary?.trim() || `Running ${event.item.toolName}`
      }
      break
    default:
      break
  }
  if (!phase || !label) return undefined
  const normalizedLabel = label.replace(/\s+/gu, ' ').trim().slice(0, 500)
  if (!normalizedLabel) return undefined
  if (
    previous?.phase === phase &&
    previous.label === normalizedLabel &&
    previous.toolName === toolName
  ) {
    return undefined
  }
  return ChildRunActivity.parse({
    phase,
    label: normalizedLabel,
    ...(toolName ? { toolName: toolName.slice(0, 256) } : {}),
    startedAt: event.timestamp,
    updatedAt: event.timestamp
  })
}

function sameChildActivity(
  left: ChildRunActivityValue | undefined,
  right: ChildRunActivityValue
): boolean {
  return left?.phase === right.phase &&
    left.label === right.label &&
    left.toolName === right.toolName &&
    left.startedAt === right.startedAt &&
    left.updatedAt === right.updatedAt
}

function addChildUsage(
  previous: ChildRunRecord['usage'],
  next: ChildRunRecord['usage'] | undefined
): ChildRunRecord['usage'] {
  if (!next) return previous
  const add = (key: keyof ChildRunRecord['usage']): number | undefined => {
    const left = previous[key]
    const right = next[key]
    return typeof left === 'number' || typeof right === 'number'
      ? (typeof left === 'number' ? left : 0) + (typeof right === 'number' ? right : 0)
      : undefined
  }
  return ChildRunRecord.shape.usage.parse({
    promptTokens: add('promptTokens') ?? 0,
    completionTokens: add('completionTokens') ?? 0,
    totalTokens: add('totalTokens') ?? 0,
    ...(add('cachedTokens') !== undefined ? { cachedTokens: add('cachedTokens') } : {}),
    ...(add('cacheHitTokens') !== undefined ? { cacheHitTokens: add('cacheHitTokens') } : {}),
    ...(add('cacheMissTokens') !== undefined ? { cacheMissTokens: add('cacheMissTokens') } : {}),
    ...(add('turns') !== undefined ? { turns: add('turns') } : {}),
    ...(add('costUsd') !== undefined ? { costUsd: add('costUsd') } : {}),
    ...(add('costCny') !== undefined ? { costCny: add('costCny') } : {}),
    ...(add('cacheSavingsUsd') !== undefined ? { cacheSavingsUsd: add('cacheSavingsUsd') } : {}),
    ...(add('cacheSavingsCny') !== undefined ? { cacheSavingsCny: add('cacheSavingsCny') } : {}),
    ...(add('tokenEconomySavingsTokens') !== undefined ? { tokenEconomySavingsTokens: add('tokenEconomySavingsTokens') } : {}),
    ...(add('tokenEconomySavingsUsd') !== undefined ? { tokenEconomySavingsUsd: add('tokenEconomySavingsUsd') } : {}),
    ...(add('tokenEconomySavingsCny') !== undefined ? { tokenEconomySavingsCny: add('tokenEconomySavingsCny') } : {}),
    cacheHitRate: next.cacheHitRate ?? previous.cacheHitRate
  })
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'ENOENT'
}

const defaultExecutor: ChildRunExecutor = async (input) => {
  return { summary: `Child result: ${input.prompt}` }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Non-negative millisecond delta between two ISO timestamps (0 when unparseable). */
function elapsedMs(fromIso: string, toIso: string): number {
  const from = Date.parse(fromIso)
  const to = Date.parse(toIso)
  if (Number.isNaN(from) || Number.isNaN(to)) return 0
  return Math.max(0, to - from)
}
