import { InMemoryApprovalGate } from '../adapters/in-memory-approval-gate.js'
import { InMemoryEventBus } from '../adapters/in-memory-event-bus.js'
import { InMemorySessionStore } from '../adapters/in-memory-session-store.js'
import { InMemoryThreadStore } from '../adapters/in-memory-thread-store.js'
import { InMemoryUserInputGate } from '../adapters/in-memory-user-input-gate.js'
import { setSystemPrompt, type ImmutablePrefix } from '../cache/immutable-prefix.js'
import { SUBAGENT_READ_ONLY_TOOL_NAMES, type ModelCapabilityMetadata } from '../contracts/capabilities.js'
import type { TurnItem } from '../contracts/items.js'
import {
  DEFAULT_APPROVAL_REVIEWER,
  type ApprovalPolicy,
  type ApprovalReviewer,
  type SandboxMode
} from '../contracts/policy.js'
import type { RuntimeTuningConfig } from '../config/kun-config.js'
import { AgentLoop } from '../loop/agent-loop.js'
import { normalizeRoleReasoningEffort } from '../loop/reasoning-effort.js'
import type {
  ContextCompactionConfig,
  ModelConfig,
  ModelContextProfile
} from '../loop/model-context-profile.js'
import { ContextCompactor } from '../loop/context-compactor.js'
import { InflightTracker } from '../loop/inflight-tracker.js'
import { SteeringQueue } from '../loop/steering-queue.js'
import type { TokenEconomyConfig } from '../loop/token-economy.js'
import type { MemoryStore } from '../memory/memory-store.js'
import type { ArtifactStore } from '../artifacts/artifact-store.js'
import type { ModelClient } from '../ports/model-client.js'
import { RandomIdGenerator } from '../ports/id-generator.js'
import type { ApprovalGate } from '../ports/approval-gate.js'
import type { ApprovalReviewPort } from '../ports/approval-review.js'
import type { SessionStore } from '../ports/session-store.js'
import type { ThreadStore } from '../ports/thread-store.js'
import type { ToolHost } from '../ports/tool-host.js'
import type { DelegatedTurnRuntime } from '../runtime/delegated-turn-runtime.js'
import type { SkillRuntime } from '../skills/skill-runtime.js'
import type { InstructionRuntime } from '../instructions/instruction-runtime.js'
import { RuntimeEventRecorder } from '../services/runtime-event-recorder.js'
import { ThreadService } from '../services/thread-service.js'
import { TurnService } from '../services/turn-service.js'
import { UsageService } from '../services/usage-service.js'
import type { ChildRunExecutor } from './delegation-runtime.js'

export type ChildDelegatedRuntimeFactory = (input: {
  threads: ThreadService
  turns: TurnService
  sessionStore: SessionStore
  threadStore: ThreadStore
  events: RuntimeEventRecorder
  ids: { next(prefix: string): string }
  prefix: ImmutablePrefix
  toolPolicy: 'readOnly' | 'inherit'
  allowedToolNames?: readonly string[]
  allowedProviderIds?: readonly string[]
  allowedSkillIds?: readonly string[]
  allowedReadPaths?: readonly string[]
  allowedWritePaths?: readonly string[]
  allowedArtifactIds?: readonly string[]
  blockedToolNames?: readonly string[]
  blockedProviderIds?: readonly string[]
  blockedSkillIds?: readonly string[]
  skillsEnabled: boolean
  memoryEnabled: boolean
}) => DelegatedTurnRuntime | undefined

export type ChildAgentExecutorOptions = {
  model: ModelClient
  toolHost: ToolHost
  prefix: ImmutablePrefix
  defaultModel: string
  models?: ModelConfig
  contextCompaction?: ContextCompactionConfig
  approvalPolicy?: ApprovalPolicy
  sandboxMode?: SandboxMode
  approvalReviewer?: ApprovalReviewer
  tokenEconomy?: TokenEconomyConfig
  runtime?: RuntimeTuningConfig
  nowIso?: () => string
  modelCapabilities?: (model: string, providerId?: string) => ModelCapabilityMetadata
  profilesForProvider?: (
    providerId: string | undefined
  ) => readonly ModelContextProfile[]
  skillRuntime?: SkillRuntime
  instructionRuntime?: InstructionRuntime
  memoryStore?: MemoryStore
  artifactStore?: ArtifactStore
  /** Runtime-owned approval channel shared with the HTTP decision endpoint. */
  approvalGate?: ApprovalGate
  /** Isolated automatic reviewer used when the inherited reviewer is `agent`. */
  approvalReview?: ApprovalReviewPort
  /**
   * Host-owned provider-native runtime composition. The callback receives the
   * already narrowed child capability envelope and child turn services.
   */
  createDelegatedRuntime?: ChildDelegatedRuntimeFactory
  /**
   * Persistence wiring. When the main runtime's stores + event recorder are
   * supplied, the child runs as a persisted `relation: 'side'` thread on the
   * shared event bus: its full session (reasoning, tool calls, results) is
   * queryable via `getThreadDetail(childId)` and streams live to UI
   * subscribers. The thread is hidden from the default thread list (the store
   * filters `side`). When omitted (e.g. in unit tests) the child falls back to
   * throwaway in-memory stores, preserving full isolation.
   */
  sessionStore?: SessionStore
  threadStore?: ThreadStore
  events?: RuntimeEventRecorder
}

export function createChildAgentExecutor(options: ChildAgentExecutorOptions): ChildRunExecutor {
  return async (input) => {
    const blockedSkillIds = unique([
      ...(input.security?.blockedSkillIds ?? []),
      ...(input.blockedSkills ?? [])
    ])
    const nowIso = options.nowIso ?? (() => new Date().toISOString())
    // Persist into the main runtime's stores + event bus when supplied, so the
    // child session is queryable and streams live; otherwise stay isolated in
    // throwaway in-memory stores (preserves test behavior). The recorder is
    // shared too — events persist-before-publish to the same bus, and seq
    // allocation is per-thread (childId), so child events never bleed into the
    // parent thread's stream.
    const sessionStore: SessionStore = options.sessionStore ?? new InMemorySessionStore()
    const threadStore: ThreadStore = options.threadStore ?? new InMemoryThreadStore()
    const events =
      options.events ??
      (() => {
        const eventBus = new InMemoryEventBus()
        return new RuntimeEventRecorder({
          eventBus,
          sessionStore,
          allocateSeq: (threadId) => eventBus.allocateSeq(threadId),
          nowIso
        })
      })()
    const usage = new UsageService()
    const ids = new RandomIdGenerator()
    const inflight = new InflightTracker()
    const steering = new SteeringQueue()
    const compactor = new ContextCompactor({
      contextCompaction: options.contextCompaction,
      models: options.models,
      profilesForProvider: options.profilesForProvider
    })
    const turns = new TurnService({
      threadStore,
      sessionStore,
      events,
      inflight,
      steering,
      compactor,
      ids,
      nowIso
    })
    const threads = new ThreadService({
      threadStore,
      sessionStore,
      events,
      ids,
      nowIso
    })
    // Every allow-list is an upper bound. readOnly is host-defined and cannot
    // be widened by a profile's allowedTools; the parent turn's allow-list is
    // intersected last, so a child can only lose capabilities.
    const forcedAllowedToolNames = intersectDefinedLists(
      input.toolPolicy === 'readOnly' ? SUBAGENT_READ_ONLY_TOOL_NAMES : undefined,
      input.allowedTools,
      input.security?.allowedToolNames
    )
    const blockedToolNames = unique([
      ...(input.security?.blockedToolNames ?? []),
      ...(input.blockedTools ?? [])
    ])
    const blockedProviderIds = unique([
      ...(input.security?.blockedProviderIds ?? []),
      ...(input.blockedMcpServers ?? []).map((serverId) => `mcp:${serverId}`)
    ])
    // A custom system prompt augments the base prefix (kun tool/safety
    // conventions stay) on a distinct fingerprint, so same-agent calls still
    // hit the prompt cache; cross-agent reuse is intentionally given up.
    // omitBasePrompt replaces the base with the role prompt when present.
    const rolePrompt = input.systemPrompt?.trim()
    const childPrefix = rolePrompt
      ? setSystemPrompt(
        options.prefix,
        input.omitBasePrompt === true
          ? rolePrompt
          : `${options.prefix.systemPrompt}\n\n${rolePrompt}`.trim()
      )
      : options.prefix
    const model = input.model?.trim() || options.defaultModel
    const approvalPolicy = input.approvalPolicy ?? options.approvalPolicy ?? 'auto'
    const sandboxMode = input.sandboxMode ?? options.sandboxMode
    const approvalReviewer =
      input.approvalReviewer ?? options.approvalReviewer ?? DEFAULT_APPROVAL_REVIEWER
    const delegatedRuntime = options.createDelegatedRuntime?.({
      threads,
      turns,
      sessionStore,
      threadStore,
      events,
      ids,
      prefix: childPrefix,
      toolPolicy: input.toolPolicy,
      ...(forcedAllowedToolNames ? { allowedToolNames: forcedAllowedToolNames } : {}),
      ...(input.security?.allowedProviderIds
        ? { allowedProviderIds: input.security.allowedProviderIds }
        : {}),
      ...(input.security?.allowedSkillIds
        ? { allowedSkillIds: input.security.allowedSkillIds }
        : {}),
      ...(input.security?.allowedReadPaths
        ? { allowedReadPaths: input.security.allowedReadPaths }
        : {}),
      ...(input.security?.allowedWritePaths
        ? { allowedWritePaths: input.security.allowedWritePaths }
        : {}),
      ...(input.security?.allowedArtifactIds
        ? { allowedArtifactIds: input.security.allowedArtifactIds }
        : {}),
      ...(blockedToolNames.length ? { blockedToolNames } : {}),
      ...(blockedProviderIds.length ? { blockedProviderIds } : {}),
      ...(blockedSkillIds.length ? { blockedSkillIds } : {}),
      skillsEnabled: input.skillsEnabled !== false,
      memoryEnabled: input.security?.memoryEnabled !== false
    })
    const loop = new AgentLoop({
      threadStore,
      sessionStore,
      approvalGate: options.approvalGate ?? new InMemoryApprovalGate(),
      ...(options.approvalReview ? { approvalReview: options.approvalReview } : {}),
      userInputGate: new InMemoryUserInputGate(),
      model: options.model,
      toolHost: options.toolHost,
      ...(delegatedRuntime ? { sdkRuntime: delegatedRuntime } : {}),
      usage,
      events,
      turns,
      inflight,
      steering,
      compactor,
      prefix: childPrefix,
      ids,
      nowIso,
      ...(forcedAllowedToolNames ? { forcedAllowedToolNames } : {}),
      ...(input.security?.allowedProviderIds ? { allowedProviderIds: input.security.allowedProviderIds } : {}),
      ...(input.security?.allowedSkillIds ? { allowedSkillIds: input.security.allowedSkillIds } : {}),
      ...(input.security?.allowedReadPaths
        ? { allowedReadPaths: input.security.allowedReadPaths }
        : {}),
      ...(input.security?.allowedWritePaths
        ? { allowedWritePaths: input.security.allowedWritePaths }
        : {}),
      ...(input.security?.allowedArtifactIds
        ? { allowedArtifactIds: input.security.allowedArtifactIds }
        : {}),
      ...(blockedToolNames.length ? { blockedToolNames } : {}),
      ...(blockedProviderIds.length ? { blockedProviderIds } : {}),
      ...(blockedSkillIds.length ? { blockedSkillIds } : {}),
      ...(options.modelCapabilities ? { modelCapabilities: options.modelCapabilities } : {}),
      ...(input.skillsEnabled !== false && options.skillRuntime ? { skillRuntime: options.skillRuntime } : {}),
      ...(options.instructionRuntime ? { instructionRuntime: options.instructionRuntime } : {}),
      ...(options.memoryStore && input.security?.memoryEnabled !== false ? { memoryStore: options.memoryStore } : {}),
      ...(options.artifactStore ? { artifactStore: options.artifactStore } : {}),
      ...(options.contextCompaction ? { contextCompaction: options.contextCompaction } : {}),
      ...(options.tokenEconomy ? { tokenEconomy: options.tokenEconomy } : {}),
      // A delegated child settles only when it completes or an explicit
      // parent/user cancellation reaches its signal. Do not inherit the
      // generic AgentLoop wall-clock deadline.
      disableWallTimeLimit: true,
      ...(options.runtime?.toolStorm ? { toolStorm: options.runtime.toolStorm } : {}),
      ...(options.runtime?.toolArgumentRepair ? { toolArgumentRepair: options.runtime.toolArgumentRepair } : {})
    })

    const title = childThreadTitle(input.childId, input.label, input.profile)
    const thread = await threads.create({
      title,
      workspace: input.workspace?.trim() || '~',
      model,
      mode: 'agent',
      approvalPolicy,
      ...(sandboxMode ? { sandboxMode } : {}),
      approvalReviewer,
      // Route the child to the profile's provider. ThreadService threads
      // providerId into every ModelRequest, and the executor's model is the
      // MultiProviderModelClient, so this single field is all routing needs.
      ...(input.providerId ? { providerId: input.providerId } : {}),
      ...(input.accountId ? { accountId: input.accountId } : {}),
      // Persist the resolved profile id so the GUI can label explore/side
      // sessions (e.g. return-bar "viewing explore process").
      ...(input.profile?.trim() ? { agentId: input.profile.trim() } : {})
    }, {
      id: input.childId,
      title,
      // Persist as a side branch of the parent: hidden from the default thread
      // list, but loadable on demand so the user can open the subagent's own
      // session from the parent's delegate_task card.
      relation: 'side',
      parentThreadId: input.parentThreadId
    })
    // A profile preamble rides in the prompt body (not the system prompt) so
    // the cached stable prefix stays byte-identical to the main agent's.
    const promptBase = input.promptPreamble?.trim()
      ? `${input.promptPreamble.trim()}\n\n${input.prompt}`
      : input.prompt
    const prompt = input.returnFormat === 'evidence'
      ? `${promptBase}\n\nReturn a concise evidence-based conclusion. Inspect the task with tools so the parent can verify the result.`
      : promptBase
    if (input.serviceTier === 'priority') {
      // Mirror the main loop's service-tier gating so users are not silently
      // charged for a "fast" request the routed model cannot honor.
      const capabilityProviderId = input.providerId?.trim().toLowerCase() === 'default'
        ? undefined
        : input.providerId
      const capabilities = options.modelCapabilities?.(model, capabilityProviderId)
      if (!capabilities?.serviceTiers?.includes('priority')) {
        console.warn(`[kun] fast (serviceTier=priority) requested but unsupported for child model=${model}${input.providerId ? ` provider=${input.providerId}` : ''}`)
      }
    }
    const started = await turns.startTurn({
      threadId: thread.id,
      request: {
        prompt,
        model,
        clientSurface: input.guiDesignCanvas ? 'gui' : input.clientSurface ?? 'api',
        ...(input.providerId ? { providerId: input.providerId } : {}),
        ...(input.accountId ? { accountId: input.accountId } : {}),
        approvalPolicy,
        ...(sandboxMode ? { sandboxMode } : {}),
        approvalReviewer,
        mode: 'agent',
        reasoningEffort: normalizeRoleReasoningEffort(input.reasoningEffort),
        ...(input.serviceTier ? { serviceTier: input.serviceTier } : {}),
        ...(input.guiDesignCanvas ? { guiDesignCanvas: true } : {}),
        // Child runs have no independent interactive surface for structured prompts.
        disableUserInput: true
      }
    })
    const abortChild = (): void => {
      console.warn(`[kun] foreground subagent parent abort received child=${thread.id} turn=${started.turnId} parentThread=${input.parentThreadId} parentTurn=${input.parentTurnId}`)
      void turns.interruptTurn({
        threadId: thread.id,
        turnId: started.turnId
      }).catch(() => undefined)
    }
    if (input.signal.aborted) {
      console.warn(`[kun] foreground subagent started with aborted parent signal child=${thread.id} turn=${started.turnId}`)
      abortChild()
    } else {
      console.warn(`[kun] foreground subagent abort bridge armed child=${thread.id} turn=${started.turnId} parentThread=${input.parentThreadId} parentTurn=${input.parentTurnId}`)
      input.signal.addEventListener('abort', abortChild, { once: true })
    }
    let status: 'completed' | 'failed' | 'aborted'
    try {
      const outcome = await loop.runTurn(thread.id, started.turnId)
      if (
        outcome === 'suspended' ||
        outcome === 'suspended_pending_supervision'
      ) {
        throw new Error(`non-Graph child turn suspended unexpectedly: ${started.turnId}`)
      }
      status = outcome
    } finally {
      input.signal.removeEventListener('abort', abortChild)
    }
    console.warn(`[kun] foreground subagent turn settled child=${thread.id} turn=${started.turnId} status=${status}`)
    // Only a FATAL error fails the child. Recoverable tool errors — a tool
    // rejected by the child's read-only policy, or a tool that crashed — are
    // recorded as `severity: 'warning'` error events but the loop hands the
    // model an error tool-result it adapts to and the turn still completes.
    // Treating those as fatal wrongly marked the whole subagent "failed" for a
    // single denied `bash` call. Genuine failures are caught by the `status`
    // check below; here we only honor non-warning (fatal) error events.
    const runtimeError = (await sessionStore.loadEventsSince(thread.id, 0))
      .find(
        (event) =>
          event.kind === 'error' &&
          event.turnId === started.turnId &&
          event.severity !== 'warning' &&
          event.severity !== 'info'
      )
    if (runtimeError?.kind === 'error') {
      throw new Error(runtimeError.message)
    }
    const items = await sessionStore.loadItems(thread.id)
    const summary = summarizeChildTurn(items, started.turnId, status)
    const toolInvocations = items.filter(
      (item) => item.turnId === started.turnId && item.kind === 'tool_call'
    ).length
    const evidence = input.returnFormat === 'evidence'
      ? childToolEvidence(items, started.turnId)
      : undefined
    if (status !== 'completed') {
      throw new Error(summary || `child agent ${status}`)
    }
    return {
      summary,
      ...(evidence ? { evidence } : {}),
      usage: usage.forThread(thread.id),
      toolInvocations,
      // A role system prompt changes the immutable prefix fingerprint. Only a
      // child with no role prompt can report exact main-prefix reuse.
      prefixReused: !input.systemPrompt?.trim(),
      inheritedHistoryItems: 0
    }
  }
}

function childToolEvidence(items: readonly TurnItem[], turnId: string): string[] {
  const results = new Map(items
    .filter((item): item is Extract<TurnItem, { kind: 'tool_result' }> =>
      item.turnId === turnId && item.kind === 'tool_result')
    .map((item) => [item.callId, item]))
  return items
    .filter((item): item is Extract<TurnItem, { kind: 'tool_call' }> =>
      item.turnId === turnId && item.kind === 'tool_call')
    .filter((item) => {
      const result = results.get(item.callId)
      return Boolean(result && !result.isError && result.status === 'completed')
    })
    .slice(0, 32)
    .map((item) => {
      const result = results.get(item.callId)!
      const target = toolEvidenceTarget(item.arguments)
      const digest = evidenceDigest(result.output)
      return `${item.toolName}${target ? ` ${target}` : ''}: completed${digest ? ` — ${digest}` : ''}`
    })
}

function evidenceDigest(output: unknown): string {
  const serialized = typeof output === 'string' ? output : safeJson(output)
  return serialized.replace(/\s+/g, ' ').trim().slice(0, 500)
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function intersectDefinedLists(...lists: Array<readonly string[] | undefined>): string[] | undefined {
  const defined = lists.filter((list): list is readonly string[] => Boolean(list))
  if (!defined.length) return undefined
  let result = unique(defined[0] ?? [])
  for (const list of defined.slice(1)) {
    const allowed = new Set(list)
    result = result.filter((value) => allowed.has(value))
  }
  return result
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)]
}

function toolEvidenceTarget(args: Record<string, unknown>): string {
  for (const key of ['path', 'filePath', 'file_path', 'query', 'command']) {
    const value = args[key]
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 300)
  }
  return ''
}

function childThreadTitle(childId: string, label?: string, profile?: string): string {
  const suffix = label?.trim() || profile?.trim() || childId
  return `Child agent: ${suffix}`
}

function summarizeChildTurn(
  items: readonly TurnItem[],
  turnId: string,
  status: 'completed' | 'failed' | 'aborted'
): string {
  const turnItems = items.filter((item) => item.turnId === turnId)
  const assistantText = turnItems
    .filter((item): item is Extract<TurnItem, { kind: 'assistant_text' }> => item.kind === 'assistant_text')
    .map((item) => item.text.trim())
    .filter(Boolean)
    .join('\n\n')
    .trim()
  if (assistantText) return assistantText
  const errors = turnItems
    .filter((item): item is Extract<TurnItem, { kind: 'error' }> => item.kind === 'error')
    .map((item) => item.message.trim())
    .filter(Boolean)
    .join('\n')
    .trim()
  if (errors) return errors
  const toolResult = [...turnItems]
    .reverse()
    .find((item): item is Extract<TurnItem, { kind: 'tool_result' }> => item.kind === 'tool_result')
  if (toolResult) return stringifySummary(toolResult.output)
  return status === 'completed'
    ? 'Child agent completed without a text response.'
    : `Child agent ${status}.`
}

function stringifySummary(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (value == null) return ''
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
