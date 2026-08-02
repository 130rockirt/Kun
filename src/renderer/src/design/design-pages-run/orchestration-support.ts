import { useChatStore } from "../../store/chat-store"
import { collectAssistantTextForTurn } from "../../store/chat-store-runtime-helpers"
import type { ChatBlock, ToolBlock } from "../../agent/types"
import type { SendMessageOverrides } from "../../store/chat-store-types"
import {
  defaultPreviewNodeSizeForDesignTarget,
  type DesignContext
} from "../design-context"
import { buildStitchDesignMarkdown, STITCH_DESIGN_MD_PATH } from "../design-md-compat"
import {
  buildDesignLogoPrompt,
  buildDesignSpecPrompt,
  buildDesignSpecStub,
  buildFoundationFollowLines,
  designSpecPath,
  findFoundationArtifact,
  type DesignFoundationRole,
  type DesignFoundationStep
} from "../design-foundation"
import {
  DESIGN_PAGES_MAX,
  buildDesignPlanPrompt,
  buildHtmlSiblingManifest,
  buildPrototypeLinksForPage,
  extractAgentDesignSummary,
  parsePagesPlan,
  type DesignPagePlanEntry
} from "../design-pages"
import { prepareDesignPreviewFile } from "../design-preview-file"
import { writeDesignWorkspaceFile } from "../design-persistence-coordinator"
import {
  buildDesignTurnPrompt,
  buildParallelDesignPagesPrompt,
  type ParallelDesignPageJob
} from "../design-turn-prompt"
import { createDesignArtifactId, defaultDesignArtifactNode, type DesignDirection } from "../design-types"
import type { ParallelDesignPageState } from "../design-workspace-store-types"
import { useDesignWorkspaceStore } from "../design-workspace-store"

export type SendMessageFn = (
  text: string,
  mode?: string,
  overrides?: SendMessageOverrides
) => Promise<boolean>

export type RunDesignPagesDeps = {
  /** One-line app idea to decompose into pages. */
  brief: string
  workspaceRoot: string
  sendMessage: SendMessageFn
  model?: string
  providerId?: string
  reasoningEffort?: string
  serviceTier?: 'priority'
  expectedThreadId?: string
  generationPrompt?: string
  designContext?: DesignContext
  /** Reports whether the first runtime send was accepted, before waiting for that turn to finish. */
  onFirstSendSettled?: (sent: boolean) => void
  /**
   * When false, skip the design.md / design-system / logo foundation and just
   * plan + generate pages (the legacy flow). Defaults to true.
   */
  foundation?: boolean
  /** Localized chat-bubble labels (English fallbacks used when omitted). */
  labels?: {
    plan?: (brief: string) => string
    page?: (title: string, index: number, total: number) => string
    /** Progress-chip title for a foundation step. */
    foundationStep?: (step: DesignFoundationStep) => string
    /** Chat-bubble display for the spec turn. */
    specDisplay?: (brief: string) => string
    /** Chat-bubble display for the design-system turn. */
    systemDisplay?: () => string
    /** Chat-bubble display for the logo turn. */
    logoDisplay?: () => string
    /** Canvas card title for the design-system artifact. */
    systemTitle?: () => string
    /** Canvas card title for the logo artifact. */
    logoTitle?: () => string
  }
}

export const PLAN_TIMEOUT_MS = 180_000

export const PAGE_TIMEOUT_MS = 300_000

export const PARALLEL_PAGES_TIMEOUT_MS = 420_000

let activeRun: { cancelled: boolean } | null = null

/** True while a multi-page run is in flight (one at a time). */
export function isDesignPagesRunActive(): boolean {
  return activeRun !== null
}

/** Cancel the in-flight run after the current page finishes. */
export function cancelDesignPagesRun(): void {
  if (activeRun) activeRun.cancelled = true
}

export function beginDesignPagesRun(signal: { cancelled: boolean }): boolean {
  if (activeRun) return false
  activeRun = signal
  return true
}

export function finishDesignPagesRun(signal: { cancelled: boolean }): void {
  if (activeRun === signal) activeRun = null
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function buildDirectionName(brief: string, plan: readonly DesignPagePlanEntry[]): string {
  const fromBrief = brief
    .trim()
    .replace(/\s+/g, ' ')
    .split(' ')
    .slice(0, 5)
    .join(' ')
  if (fromBrief) return fromBrief.length > 48 ? `${fromBrief.slice(0, 45)}...` : fromBrief
  return plan[0]?.title ? `${plan[0].title} direction` : 'Design direction'
}

export function formatPageFlowLines(
  entry: DesignPagePlanEntry,
  currentRelativePath: string,
  plannedPages: Array<{ title: string; artifactId: string; relativePath: string }>
): string[] {
  const lines: string[] = []
  if (entry.primaryAction?.trim()) {
    lines.push(`Primary prototype action for this page: ${entry.primaryAction.trim()}`)
  }
  const links = buildPrototypeLinksForPage(entry, currentRelativePath, plannedPages)
  if (links.length > 0) {
    lines.push('Planned outgoing prototype links from this page:')
    for (const link of links) {
      if (link.href) {
        lines.push(`- "${link.targetTitle}" -> href \`${link.href}\``)
      } else {
        lines.push(`- "${link.targetTitle}" -> no matching pre-created page; do not invent a file path.`)
      }
    }
    lines.push('Use these exact href values for matching targets. If a target is missing, make the control local/stateful instead of linking to a non-existent file.')
  }
  return lines
}

export function formatPageProductBriefLines(entry: DesignPagePlanEntry): string[] {
  const lines: string[] = []
  if (entry.userGoal?.trim()) {
    lines.push(`User goal for this page: ${entry.userGoal.trim()}`)
  }
  const dataExamples = entry.dataExamples?.map((item) => item.trim()).filter(Boolean) ?? []
  if (dataExamples.length > 0) {
    lines.push('Required realistic content/data to visibly include:')
    for (const item of dataExamples) lines.push(`- ${item}`)
  }
  const states = entry.states?.map((item) => item.trim()).filter(Boolean) ?? []
  if (states.length > 0) {
    lines.push('Key UI states to represent or document in the screen:')
    for (const state of states) lines.push(`- ${state}`)
  }
  if (lines.length > 0) {
    lines.push('Use the goal, data examples, and states as actual UI content or DESIGN.md handoff notes; do not leave them as invisible planning text.')
  }
  return lines
}

/** Best-effort write of a plain workspace file such as the design.md stub. */
export async function writeWorkspaceTextFile(
  workspaceRoot: string,
  path: string,
  content: string
): Promise<boolean> {
  if (typeof window === 'undefined' || typeof window.kunGui?.writeWorkspaceFile !== 'function') {
    return false
  }
  const result = await writeDesignWorkspaceFile({ path, workspaceRoot, content })
  return result.ok
}

/**
 * Resolve when the active chat turn finishes (currentTurnId non-null → null
 * edge, the same unambiguous completion signal the ShapeOps hook trusts). If a
 * turn never starts within the grace window the send is treated as settled.
 */
export async function waitForTurnComplete(
  signal: { cancelled: boolean },
  timeoutMs: number
): Promise<'complete' | 'timeout' | 'cancelled'> {
  const startedAt = Date.now()
  let sawActive = false
  // Give the send a moment to register a turn before we start judging idleness.
  const graceMs = 9000
  for (;;) {
    if (signal.cancelled) return 'cancelled'
    const turnId = useChatStore.getState().currentTurnId
    if (turnId) sawActive = true
    else if (sawActive) return 'complete'
    else if (Date.now() - startedAt > graceMs) return 'complete'
    if (Date.now() - startedAt > timeoutMs) return 'timeout'
    await delay(220)
  }
}

/** Assistant text for the most recently completed turn (the last user block). */
export function assistantTextForLastTurn(): string {
  const s = useChatStore.getState()
  let userId: string | null = null
  for (let i = s.blocks.length - 1; i >= 0; i -= 1) {
    if (s.blocks[i].kind === 'user') {
      userId = s.blocks[i].id
      break
    }
  }
  if (!userId) return s.liveAssistant.trim()
  return collectAssistantTextForTurn(s.blocks, userId, s.liveAssistant)
}

export function blocksForLastTurn(): ChatBlock[] {
  const s = useChatStore.getState()
  let userIndex = -1
  for (let i = s.blocks.length - 1; i >= 0; i -= 1) {
    if (s.blocks[i].kind === 'user') {
      userIndex = i
      break
    }
  }
  if (userIndex < 0) return []
  const out: ChatBlock[] = []
  for (let i = userIndex + 1; i < s.blocks.length; i += 1) {
    if (s.blocks[i].kind === 'user') break
    out.push(s.blocks[i])
  }
  return out
}

export function parseJsonObject(text: string | undefined): Record<string, unknown> | null {
  if (!text?.trim()) return null
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

export function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

export function artifactIdFromLabel(label: string | undefined): string | undefined {
  const trimmed = label?.trim()
  if (!trimmed?.startsWith('page:')) return undefined
  return trimmed.slice('page:'.length).trim() || undefined
}

export function artifactIdFromPrompt(prompt: string | undefined, jobs: ParallelDesignPageJob[]): string | undefined {
  if (!prompt) return undefined
  for (const job of jobs) {
    if (prompt.includes(job.artifactId) || prompt.includes(job.relativePath)) return job.artifactId
  }
  return undefined
}

export function childMetaFromBlock(block: ToolBlock): Record<string, unknown> | null {
  const child = block.meta?.child
  return child && typeof child === 'object' && !Array.isArray(child)
    ? child as Record<string, unknown>
    : null
}

export function delegateArtifactIdFromBlock(
  block: ToolBlock,
  jobs: ParallelDesignPageJob[],
  toolArtifactIds: Map<string, string>
): string | undefined {
  const known = toolArtifactIds.get(block.id)
  if (known) return known
  const detail = parseJsonObject(block.detail)
  const child = childMetaFromBlock(block)
  const id =
    artifactIdFromLabel(stringField(detail?.label)) ??
    artifactIdFromLabel(stringField(child?.childLabel)) ??
    artifactIdFromPrompt(stringField(detail?.prompt), jobs)
  if (id) toolArtifactIds.set(block.id, id)
  return id
}

export function statusFromDelegateBlock(block: ToolBlock, detail: Record<string, unknown> | null): ParallelDesignPageState['status'] {
  const rawStatus = stringField(detail?.status)
  if (rawStatus === 'completed') return 'done'
  if (rawStatus === 'failed' || rawStatus === 'aborted') return 'failed'
  if (rawStatus === 'queued') return 'queued'
  if (rawStatus === 'running') return 'running'
  if (block.status === 'success') return 'done'
  if (block.status === 'error') return 'failed'
  return 'running'
}

export function deriveParallelDesignPageStatesFromBlocks(
  blocks: ChatBlock[],
  jobs: ParallelDesignPageJob[],
  previous: Record<string, ParallelDesignPageState> = {},
  toolArtifactIds: Map<string, string> = new Map()
): ParallelDesignPageState[] {
  const jobIds = new Set(jobs.map((job) => job.artifactId))
  const next = new Map<string, ParallelDesignPageState>()
  for (const job of jobs) {
    next.set(job.artifactId, previous[job.artifactId] ?? { artifactId: job.artifactId, status: 'queued' })
  }
  for (const block of blocks) {
    if (block.kind !== 'tool') continue
    const toolName = typeof block.meta?.toolName === 'string' ? block.meta.toolName : ''
    if (toolName && toolName !== 'delegate_task') continue
    if (!toolName && !/delegate_task/i.test(block.summary)) continue
    const artifactId = delegateArtifactIdFromBlock(block, jobs, toolArtifactIds)
    if (!artifactId || !jobIds.has(artifactId)) continue
    const detail = parseJsonObject(block.detail)
    const child = childMetaFromBlock(block)
    const state: ParallelDesignPageState = {
      ...(next.get(artifactId) ?? { artifactId, status: 'queued' as const }),
      artifactId,
      status: statusFromDelegateBlock(block, detail),
      ...(stringField(detail?.childId) ?? stringField(child?.childId)
        ? { childId: stringField(detail?.childId) ?? stringField(child?.childId) }
        : {}),
      ...(stringField(detail?.summary) ? { summary: stringField(detail?.summary) } : {}),
      ...(stringField(detail?.error) ? { error: stringField(detail?.error) } : {}),
      updatedAt: new Date().toISOString()
    }
    next.set(artifactId, state)
  }
  return jobs.map((job) => next.get(job.artifactId) ?? { artifactId: job.artifactId, status: 'queued' })
}

export function syncParallelPageStates(
  jobs: ParallelDesignPageJob[],
  toolArtifactIds: Map<string, string>
): ParallelDesignPageState[] {
  const states = deriveParallelDesignPageStatesFromBlocks(
    blocksForLastTurn(),
    jobs,
    useDesignWorkspaceStore.getState().parallelPageStates,
    toolArtifactIds
  )
  useDesignWorkspaceStore.getState().setParallelPageStates(states)
  const done = states.filter((state) => state.status === 'done' || state.status === 'failed').length
  const active = states.find((state) => state.status === 'running') ?? states.find((state) => state.status === 'queued')
  const activeJob = active ? jobs.find((job) => job.artifactId === active.artifactId) : undefined
  useDesignWorkspaceStore.getState().setPagesRun({
    phase: 'generating',
    total: jobs.length,
    done,
    title: activeJob?.title ?? (done >= jobs.length ? 'Finalizing pages' : 'Parallel pages')
  })
  return states
}

/**
 * Send one design turn and wait for it to settle. Returns a coarse status so the
 * caller can set a tailored error banner. Captures the agent's end-of-turn
 * summary onto the artifact version when an `artifactId` is given.
 */
export async function runTurn(opts: {
  sendMessage: SendMessageFn
  prompt: string
  overrides: SendMessageOverrides
  signal: { cancelled: boolean }
  timeoutMs: number
  artifactId?: string
  onSendSettled?: (sent: boolean) => void
}): Promise<'complete' | 'cancelled' | 'timeout' | 'send-failed'> {
  let sent: boolean
  try {
    sent = await opts.sendMessage(opts.prompt, 'agent', opts.overrides)
  } catch (error) {
    opts.onSendSettled?.(false)
    throw error
  }
  opts.onSendSettled?.(sent)
  if (!sent) return 'send-failed'
  const result = await waitForTurnComplete(opts.signal, opts.timeoutMs)
  if (result !== 'complete') return result
  if (opts.artifactId) {
    const summary = extractAgentDesignSummary(assistantTextForLastTurn())
    if (summary) {
      useDesignWorkspaceStore.getState().setVersionSummary(opts.artifactId, `${opts.artifactId}-v1`, summary)
    }
  }
  return 'complete'
}

/** Create a foundation artifact card (HTML) and pre-create its preview file. */
export async function createFoundationCard(opts: {
  docId: string
  workspaceRoot: string
  role: DesignFoundationRole
  title: string
}): Promise<{ id: string; relativePath: string } | null> {
  const id = createDesignArtifactId()
  const relativePath = `.kun-design/${opts.docId}/${id}/v1.html`
  const createdAt = new Date().toISOString()
  const index = useDesignWorkspaceStore.getState().artifacts.length
  useDesignWorkspaceStore.getState().upsertArtifact({
    id,
    kind: 'html',
    title: opts.title,
    relativePath,
    createdAt,
    updatedAt: createdAt,
    versions: [{ id: `${id}-v1`, relativePath, createdAt, summary: '' }],
    previewStatus: 'pending',
    role: opts.role,
    node: defaultDesignArtifactNode(index)
  })
  useDesignWorkspaceStore.getState().setActiveArtifact(id)
  const prep = await prepareDesignPreviewFile(opts.workspaceRoot, relativePath)
  return prep.ok ? { id, relativePath } : null
}
