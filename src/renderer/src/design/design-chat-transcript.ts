import type { ChatBlock } from '../agent/types'
import { getProvider } from '../agent/registry'
import {
  designDocKey,
  designDocRefForThreadId,
  normalizeDesignThreadRegistry,
  readDesignThreadRegistry,
  saveDesignThreadRegistry,
  type DesignThreadWorkspaceRecord
} from './design-thread-registry'
import {
  normalizeDesignPersistenceWorkspaceRoot,
  writeDesignWorkspaceFile
} from './design-persistence-coordinator'

/**
 * Mirrors Design Assistant conversations into the owning design document dir:
 * `.kun-design/<docId>/chat/<threadId>.md` plus `chat/meta.json`.
 *
 * The runtime remains the live source of truth. These files make a design
 * document self-contained for review, backup, and physical deletion.
 */

const TRANSCRIPT_THREAD_ID_PATTERN = /^[A-Za-z0-9._-]+$/

export type DesignChatMeta = {
  version: 1
  activeThreadId: string
  threads: Array<{ id: string; updatedAt?: string }>
}

type ChatStateLike = {
  activeThreadId: string | null
  blocks: ChatBlock[]
}

export type DesignChatHistoryMutationToken = {
  key: string
  epoch: number
}

type DesignChatHistoryMutationState = {
  epoch: number
  suspended: boolean
}

const chatHistoryMutationStates = new Map<string, DesignChatHistoryMutationState>()

function chatHistoryMutationKey(workspaceRoot: string, docId: string): string {
  return `${normalizeDesignPersistenceWorkspaceRoot(workspaceRoot)}\0${docId.trim()}`
}

/**
 * Fence transcript/meta hydration while a drawing's history is being removed.
 * Incrementing the epoch also invalidates reads which began before the clear.
 */
export function beginDesignChatHistoryMutation(
  workspaceRoot: string,
  docId: string
): DesignChatHistoryMutationToken | null {
  const key = chatHistoryMutationKey(workspaceRoot, docId)
  if (!normalizeDesignPersistenceWorkspaceRoot(workspaceRoot) || !docId.trim()) return null
  const current = chatHistoryMutationStates.get(key) ?? { epoch: 0, suspended: false }
  if (current.suspended) return null
  const next = { epoch: current.epoch + 1, suspended: true }
  chatHistoryMutationStates.set(key, next)
  return { key, epoch: next.epoch }
}

export function endDesignChatHistoryMutation(token: DesignChatHistoryMutationToken): void {
  const current = chatHistoryMutationStates.get(token.key)
  if (!current || current.epoch !== token.epoch) return
  chatHistoryMutationStates.set(token.key, { ...current, suspended: false })
}

function captureDesignChatHistoryEpoch(workspaceRoot: string, docId: string): number | null {
  const state = chatHistoryMutationStates.get(chatHistoryMutationKey(workspaceRoot, docId))
  return state?.suspended ? null : state?.epoch ?? 0
}

function designChatHistoryAccessIsCurrent(input: {
  workspaceRoot: string
  docId: string
}, epoch: number, mutationToken?: DesignChatHistoryMutationToken): boolean {
  const key = chatHistoryMutationKey(input.workspaceRoot, input.docId)
  const state = chatHistoryMutationStates.get(key) ?? { epoch: 0, suspended: false }
  if (mutationToken) {
    return mutationToken.key === key && mutationToken.epoch === state.epoch && state.suspended
  }
  return !state.suspended && state.epoch === epoch
}

export function clearDesignChatHistoryMutationsForTests(): void {
  chatHistoryMutationStates.clear()
}

function safePathSegment(value: string): string {
  const trimmed = value.trim()
  if (!trimmed || trimmed === '.' || trimmed === '..') return ''
  if (trimmed.includes('/') || trimmed.includes('\\')) return ''
  return trimmed
}

export function designChatDir(docId: string): string | null {
  const safeDocId = safePathSegment(docId)
  return safeDocId ? `.kun-design/${safeDocId}/chat` : null
}

export function designChatMetaPath(docId: string): string | null {
  const dir = designChatDir(docId)
  return dir ? `${dir}/meta.json` : null
}

export function designChatTranscriptRelativePath(docId: string, threadId: string): string | null {
  const dir = designChatDir(docId)
  const trimmed = threadId.trim()
  if (!dir || !trimmed || !TRANSCRIPT_THREAD_ID_PATTERN.test(trimmed)) return null
  return `${dir}/${trimmed}.md`
}

export function serializeDesignChatTranscript(
  blocks: ChatBlock[],
  options: { threadId: string; docId?: string; generatedAt?: string }
): string {
  const lines: string[] = [
    '# 设计 Agent 对话记录',
    '',
    ...(options.docId ? [`- 绘画目录: ${options.docId}`] : []),
    `- 线程: ${options.threadId}`,
    `- 更新时间: ${options.generatedAt ?? new Date().toISOString()}`
  ]
  for (const block of blocks) {
    if (block.kind === 'user') {
      const text = (block.meta?.displayText ?? block.text).trim()
      if (!text) continue
      lines.push('', '---', '', '## 用户', '', text)
      continue
    }
    if (block.kind === 'assistant') {
      const text = block.text.trim()
      if (!text) continue
      lines.push('', '## 设计 Agent', '', text)
      continue
    }
    if (block.kind === 'tool' || block.kind === 'compaction') {
      const status = block.status === 'success' ? '' : `（${block.status}）`
      lines.push('', `> [工具] ${block.summary}${status}`)
      continue
    }
    if (block.kind === 'approval') {
      lines.push('', `> [审批] ${block.summary}（${block.status}）`)
      continue
    }
    if (block.kind === 'review') {
      lines.push('', `> [评审] ${block.title}（${block.status}）`)
    }
  }
  return `${lines.join('\n')}\n`
}

export function firstUserPromptFromDesignTranscript(raw: string): string {
  const match = raw.match(/(?:^|\n)## 用户\s*\n+([\s\S]*?)(?=\n(?:---\s*\n|##\s)|$)/)
  return match?.[1]?.trim() ?? ''
}

function threadStillBelongsToDoc(input: {
  workspaceRoot: string
  docId: string
  threadId: string
}): boolean {
  const ref = designDocRefForThreadId(input.threadId)
  return Boolean(
    ref &&
    normalizeDesignPersistenceWorkspaceRoot(ref.workspaceRoot) ===
      normalizeDesignPersistenceWorkspaceRoot(input.workspaceRoot) &&
    ref.docId === input.docId
  )
}

function missingEntryMessage(message: string): boolean {
  return /(?:enoent|no such file|not found)/i.test(message)
}

async function deleteDesignChatEntry(input: {
  workspaceRoot: string
  path: string
}): Promise<boolean> {
  if (typeof window.kunGui?.deleteWorkspaceEntry !== 'function') return false
  try {
    const result = await window.kunGui.deleteWorkspaceEntry(input)
    return result.ok || missingEntryMessage(result.message)
  } catch (error) {
    return missingEntryMessage(error instanceof Error ? error.message : String(error))
  }
}

export async function deleteDesignChatTranscriptForThread(input: {
  workspaceRoot: string
  docId: string
  threadId: string
}): Promise<boolean> {
  const path = designChatTranscriptRelativePath(input.docId, input.threadId)
  if (!path) return false
  return deleteDesignChatEntry({
    workspaceRoot: input.workspaceRoot,
    path
  })
}

export async function deleteDesignChatDirForDoc(input: {
  workspaceRoot: string
  docId: string
}): Promise<boolean> {
  const path = designChatDir(input.docId)
  if (!path) return false
  return deleteDesignChatEntry({
    workspaceRoot: input.workspaceRoot,
    path
  })
}

export async function readFirstDesignPromptFromMirrors(input: {
  workspaceRoot: string
  docId: string
  threadIds: readonly string[]
}): Promise<string> {
  if (typeof window.kunGui?.readWorkspaceFile !== 'function') return ''
  for (const threadId of input.threadIds) {
    const path = designChatTranscriptRelativePath(input.docId, threadId)
    if (!path) continue
    const read = await window.kunGui.readWorkspaceFile({
      workspaceRoot: input.workspaceRoot,
      path
    }).catch(() => null)
    if (!read?.ok) continue
    const prompt = firstUserPromptFromDesignTranscript(read.content)
    if (prompt) return prompt
  }
  return ''
}

export function parseDesignChatMeta(raw: string): DesignChatMeta | null {
  try {
    const parsed = JSON.parse(raw) as Partial<DesignChatMeta>
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.threads)) return null
    return {
      version: 1,
      activeThreadId: typeof parsed.activeThreadId === 'string' ? parsed.activeThreadId : '',
      threads: parsed.threads
        .filter((entry): entry is { id: string; updatedAt?: string } =>
          Boolean(entry) && typeof (entry as { id?: unknown }).id === 'string'
        )
        .map((entry) => ({
          id: entry.id,
          ...(typeof entry.updatedAt === 'string' ? { updatedAt: entry.updatedAt } : {})
        }))
    }
  } catch {
    return null
  }
}

function recordForDesignDoc(
  workspaceRoot: string,
  docId: string
): DesignThreadWorkspaceRecord | null {
  const registry = readDesignThreadRegistry()
  return registry.workspaces[designDocKey(workspaceRoot, docId)] ?? null
}

function validThreadIds(ids: Array<{ id: string }>): string[] {
  const ordered = new Set<string>()
  for (const entry of ids) {
    const id = entry.id.trim()
    if (id && TRANSCRIPT_THREAD_ID_PATTERN.test(id)) ordered.add(id)
  }
  return [...ordered]
}

function snapshotDesignThreadRecord(
  record: Readonly<DesignThreadWorkspaceRecord>
): DesignThreadWorkspaceRecord | null {
  const threadIds = validThreadIds(record.threadIds.map((id) => ({ id })))
  if (threadIds.length === 0) return null
  const requestedActiveThreadId = record.activeThreadId.trim()
  return {
    activeThreadId: threadIds.includes(requestedActiveThreadId)
      ? requestedActiveThreadId
      : threadIds[0],
    threadIds
  }
}

export async function hydrateDesignChatMetaForDoc(input: {
  workspaceRoot: string
  docId: string
}): Promise<boolean> {
  const historyEpoch = captureDesignChatHistoryEpoch(input.workspaceRoot, input.docId)
  if (historyEpoch === null) return false
  const metaPath = designChatMetaPath(input.docId)
  if (!metaPath || typeof window.kunGui?.readWorkspaceFile !== 'function') return false
  try {
    const read = await window.kunGui.readWorkspaceFile({
      workspaceRoot: input.workspaceRoot,
      path: metaPath
    })
    if (!read.ok) return false
    const meta = parseDesignChatMeta(read.content)
    const metaThreadIds = meta ? validThreadIds(meta.threads) : []
    if (!meta || metaThreadIds.length === 0) return false
    if (!designChatHistoryAccessIsCurrent(input, historyEpoch)) return false

    const registry = readDesignThreadRegistry()
    const key = designDocKey(input.workspaceRoot, input.docId)
    const current = registry.workspaces[key]
    const threadIds = current
      ? [...current.threadIds, ...metaThreadIds.filter((id) => !current.threadIds.includes(id))]
      : metaThreadIds
    const activeThreadId =
      current?.activeThreadId && threadIds.includes(current.activeThreadId)
        ? current.activeThreadId
        : threadIds.includes(meta.activeThreadId)
          ? meta.activeThreadId
          : threadIds[0]
    if (!designChatHistoryAccessIsCurrent(input, historyEpoch)) return false
    saveDesignThreadRegistry(
      normalizeDesignThreadRegistry({
        ...registry,
        workspaces: {
          ...registry.workspaces,
          [key]: { activeThreadId, threadIds }
        }
      })
    )
    return true
  } catch {
    return false
  }
}

export async function persistDesignChatMetaForDoc(input: {
  workspaceRoot: string
  docId: string
  stampThreadId?: string
  mutationToken?: DesignChatHistoryMutationToken
  /**
   * Stable binding captured by the caller before asynchronous disk access.
   * Initial drawing creation uses this so a transient renderer-registry loss
   * cannot prevent the document directory from recording its owning thread.
   */
  record?: Readonly<DesignThreadWorkspaceRecord>
}): Promise<boolean> {
  const explicitRecord = input.record ? snapshotDesignThreadRecord(input.record) : null
  if (input.record && !explicitRecord) return false
  const historyEpoch = input.mutationToken?.epoch ??
    captureDesignChatHistoryEpoch(input.workspaceRoot, input.docId)
  if (historyEpoch === null) return false
  const metaPath = designChatMetaPath(input.docId)
  if (
    !metaPath ||
    !designChatHistoryAccessIsCurrent(input, historyEpoch, input.mutationToken)
  ) return false
  if (
    typeof window.kunGui?.writeWorkspaceFile !== 'function' ||
    typeof window.kunGui?.readWorkspaceFile !== 'function'
  ) {
    return false
  }

  let previous: DesignChatMeta | null = null
  try {
    const existing = await window.kunGui.readWorkspaceFile({
      workspaceRoot: input.workspaceRoot,
      path: metaPath
    })
    if (existing.ok) previous = parseDesignChatMeta(existing.content)
  } catch {
    // Missing or unreadable meta is regenerated from the current registry.
  }

  if (!designChatHistoryAccessIsCurrent(input, historyEpoch, input.mutationToken)) return false
  // Normal history updates re-read after the asynchronous disk read so a
  // cleared/reduced registry cannot be resurrected. Initial creation instead
  // supplies an explicit immutable snapshot and is protected by the same
  // history-mutation epoch fence above.
  const record = explicitRecord ?? recordForDesignDoc(input.workspaceRoot, input.docId)
  if (!record) return false
  const previousById = new Map((previous?.threads ?? []).map((entry) => [entry.id, entry]))
  const now = new Date().toISOString()
  const meta: DesignChatMeta = {
    version: 1,
    activeThreadId: record.activeThreadId,
    threads: record.threadIds.map((id) => {
      const carried = previousById.get(id)
      const updatedAt = id === input.stampThreadId ? now : carried?.updatedAt
      return { id, ...(updatedAt ? { updatedAt } : {}) }
    })
  }

  try {
    if (!designChatHistoryAccessIsCurrent(input, historyEpoch, input.mutationToken)) return false
    const written = await writeDesignWorkspaceFile({
      workspaceRoot: input.workspaceRoot,
      path: metaPath,
      content: `${JSON.stringify(meta, null, 2)}\n`
    })
    return written.ok
  } catch {
    return false
  }
}

export async function writeDesignChatTranscriptForThread(input: {
  workspaceRoot: string
  docId: string
  threadId: string
  blocks: ChatBlock[]
}): Promise<boolean> {
  if (typeof window.kunGui?.writeWorkspaceFile !== 'function') return false
  if (!threadStillBelongsToDoc(input)) return false
  const transcriptPath = designChatTranscriptRelativePath(input.docId, input.threadId)
  if (!transcriptPath) return false
  try {
    const written = await writeDesignWorkspaceFile({
      workspaceRoot: input.workspaceRoot,
      path: transcriptPath,
      content: serializeDesignChatTranscript(input.blocks, {
        docId: input.docId,
        threadId: input.threadId
      })
    })
    if (!written.ok) return false
    if (!threadStillBelongsToDoc(input)) return false
    await persistDesignChatMetaForDoc({
      workspaceRoot: input.workspaceRoot,
      docId: input.docId,
      stampThreadId: input.threadId
    })
    return true
  } catch {
    return false
  }
}

export function notifyDesignChatTranscriptMirror(get: () => ChatStateLike): void {
  const state = get()
  const threadId = state.activeThreadId
  if (!threadId) return
  const ref = designDocRefForThreadId(threadId)
  if (!ref) return
  void writeDesignChatTranscriptForThread({
    workspaceRoot: ref.workspaceRoot,
    docId: ref.docId,
    threadId,
    blocks: state.blocks
  }).catch(() => undefined)
}

export async function refreshDesignChatTranscriptFromProvider(input: {
  workspaceRoot: string
  docId: string
}): Promise<void> {
  const record = recordForDesignDoc(input.workspaceRoot, input.docId)
  const threadId = record?.activeThreadId
  if (!threadId) return
  try {
    const detail = await getProvider().getThreadDetail(threadId)
    if (!threadStillBelongsToDoc({ ...input, threadId })) return
    await writeDesignChatTranscriptForThread({
      workspaceRoot: input.workspaceRoot,
      docId: input.docId,
      threadId,
      blocks: detail.blocks
    })
  } catch {
    // The runtime thread may be gone; the existing transcript stays in place.
  }
}
