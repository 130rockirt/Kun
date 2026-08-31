import { readFile, realpath } from 'node:fs/promises'
import { basename, isAbsolute, relative, resolve } from 'node:path'
import type { IdGenerator } from '../ports/id-generator.js'
import type { ProjectBoardStore } from '../ports/project-board-store.js'
import type { ThreadStore } from '../ports/thread-store.js'
import {
  PROJECT_BOARD_MAX_CARDS,
  type CreateManualProjectBoardCardRequest,
  type ManualProjectBoardCard,
  type PatchManualProjectBoardCardRequest,
  type PatchProjectBoardTodoOverlayRequest,
  type ProjectBoardCard,
  type ProjectBoardCounts,
  type ProjectBoardDocumentV1,
  type ProjectBoardSnapshotResponse,
  type ProjectBoardSummary,
  type ProjectBoardTodoOverlay
} from '../contracts/project-board.js'
import type { ThreadSummary, ThreadTodoItem } from '../contracts/threads.js'

const ORPHAN_OVERLAY_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000

export type ProjectBoardServiceOptions = {
  store: ProjectBoardStore
  threadStore: ThreadStore
  ids: IdGenerator
  nowIso: () => string
}

export class ProjectBoardService {
  constructor(private readonly options: ProjectBoardServiceOptions) {}

  async snapshot(input: {
    workspace: string
    includeArchived?: boolean
    cursor?: string
  }): Promise<ProjectBoardSnapshotResponse> {
    const workspaceRoot = await canonicalWorkspaceRoot(input.workspace)
    return this.snapshotCanonical(workspaceRoot, input)
  }

  async summaries(workspaces: readonly string[]): Promise<ProjectBoardSummary[]> {
    const canonical = await Promise.all([...new Set(workspaces)].map(canonicalWorkspaceRoot))
    const memberships = await this.boardThreadMemberships()
    return Promise.all(canonical.map(async (workspaceRoot) => {
      const document = (await this.options.store.read(workspaceRoot)).document
      const threads = memberships.filter((membership) =>
        threadMembershipMatchesProject(membership, workspaceRoot)).map(({ thread }) => thread)
      const cards = await this.allCards(workspaceRoot, document, threads)
      const counts = countCards(cards)
      const latest = cards.reduce<string | null>((current, card) =>
        !current || card.updatedAt > current ? card.updatedAt : current, null)
      return {
        workspaceRoot,
        total: counts.total,
        completed: counts.completed,
        inProgress: counts.inProgress,
        progress: counts.total === 0 ? 0 : counts.completed / counts.total,
        updatedAt: latest
      }
    }))
  }

  async createManualCard(
    request: CreateManualProjectBoardCardRequest
  ): Promise<ProjectBoardSnapshotResponse> {
    const workspaceRoot = await canonicalWorkspaceRoot(request.workspace)
    const now = this.options.nowIso()
    const id = this.options.ids.next('board')
    await this.mutate(workspaceRoot, request.expectedRevision, (document) => {
      const card: ManualProjectBoardCard = {
        id,
        title: request.title,
        description: request.description,
        status: request.status,
        category: request.category,
        priority: request.priority,
        archived: false,
        createdAt: now,
        updatedAt: now
      }
      document.manualCards[id] = card
      return document
    })
    return this.snapshotCanonical(workspaceRoot, {})
  }

  async patchManualCard(
    cardId: string,
    request: PatchManualProjectBoardCardRequest
  ): Promise<ProjectBoardSnapshotResponse> {
    const workspaceRoot = await canonicalWorkspaceRoot(request.workspace)
    const now = this.options.nowIso()
    await this.mutate(workspaceRoot, request.expectedRevision, (document) => {
      const current = document.manualCards[cardId]
      if (!current) throw new ProjectBoardNotFoundError(`manual board card not found: ${cardId}`)
      document.manualCards[cardId] = {
        ...current,
        ...(request.title !== undefined ? { title: request.title } : {}),
        ...(request.description !== undefined ? { description: request.description } : {}),
        ...(request.status !== undefined ? { status: request.status } : {}),
        ...(request.category !== undefined ? { category: request.category } : {}),
        ...(request.priority !== undefined ? { priority: request.priority } : {}),
        ...(request.archived !== undefined ? { archived: request.archived } : {}),
        updatedAt: now
      }
      return document
    })
    return this.snapshotCanonical(workspaceRoot, {})
  }

  async deleteManualCard(
    cardId: string,
    request: { workspace: string; expectedRevision: number }
  ): Promise<ProjectBoardSnapshotResponse> {
    const workspaceRoot = await canonicalWorkspaceRoot(request.workspace)
    await this.mutate(workspaceRoot, request.expectedRevision, (document) => {
      if (!document.manualCards[cardId]) {
        throw new ProjectBoardNotFoundError(`manual board card not found: ${cardId}`)
      }
      delete document.manualCards[cardId]
      return document
    })
    return this.snapshotCanonical(workspaceRoot, {})
  }

  async patchTodoOverlay(
    threadId: string,
    todoId: string,
    request: PatchProjectBoardTodoOverlayRequest
  ): Promise<ProjectBoardSnapshotResponse> {
    const workspaceRoot = await canonicalWorkspaceRoot(request.workspace)
    const threads = await this.boardThreads(workspaceRoot)
    const thread = threads.find((candidate) => candidate.id === threadId)
    const todo = thread?.todos?.items.find((candidate) =>
      candidate.id === todoId && candidate.source?.kind === 'plan')
    if (!todo) throw new ProjectBoardNotFoundError(`project board todo not found: ${threadId}/${todoId}`)
    const now = this.options.nowIso()
    const key = projectBoardTodoOverlayKey(threadId, todoId)
    await this.mutate(workspaceRoot, request.expectedRevision, (document) => {
      const current = document.todoOverlays[key] ?? emptyOverlay(threadId, todoId, now)
      document.todoOverlays[key] = {
        ...current,
        ...(request.category !== undefined ? { category: request.category } : {}),
        ...(request.priority !== undefined ? { priority: request.priority } : {}),
        ...(request.description !== undefined ? { description: request.description } : {}),
        ...(request.archived !== undefined ? { archived: request.archived } : {}),
        updatedAt: now
      }
      return document
    }, threads)
    return this.snapshotCanonical(workspaceRoot, {})
  }

  async cardForThreadTodo(threadId: string, todoId: string): Promise<ProjectBoardCard | undefined> {
    const thread = await this.options.threadStore.get(threadId)
    if (!thread) return undefined
    const snapshot = await this.snapshot({ workspace: thread.workspace, includeArchived: true })
    return snapshot.cards.find((card) => card.kind === 'thread_todo' &&
      card.source.threadId === threadId && card.source.todoId === todoId)
  }

  private async mutate(
    workspaceRoot: string,
    expectedRevision: number,
    update: (document: ProjectBoardDocumentV1) => ProjectBoardDocumentV1,
    knownThreads?: ThreadSummary[]
  ): Promise<void> {
    const threads = knownThreads ?? await this.boardThreads(workspaceRoot)
    const activeOverlayKeys = todoOverlayKeys(threads)
    const cutoff = Date.now() - ORPHAN_OVERLAY_RETENTION_MS
    await this.options.store.mutate(workspaceRoot, expectedRevision, (document) => {
      for (const [key, overlay] of Object.entries(document.todoOverlays)) {
        if (!activeOverlayKeys.has(key) && Date.parse(overlay.updatedAt) < cutoff) {
          delete document.todoOverlays[key]
        }
      }
      return update(document)
    })
  }

  private async snapshotCanonical(
    workspaceRoot: string,
    input: { includeArchived?: boolean; cursor?: string }
  ): Promise<ProjectBoardSnapshotResponse> {
    const read = await this.options.store.read(workspaceRoot)
    const allCards = await this.allCards(workspaceRoot, read.document)
    const counts = countCards(allCards)
    const visible = input.includeArchived ? allCards : allCards.filter((card) => !card.archived)
    const offset = decodeCursor(input.cursor)
    const cards = visible.slice(offset, offset + PROJECT_BOARD_MAX_CARDS)
    const nextOffset = offset + cards.length
    const truncated = nextOffset < visible.length
    return {
      workspaceRoot,
      revision: read.document.revision,
      cards,
      counts,
      truncated,
      ...(truncated ? { nextCursor: encodeCursor(nextOffset) } : {}),
      ...(read.warning ? { warning: read.warning } : {})
    }
  }

  private async allCards(
    workspaceRoot: string,
    document: ProjectBoardDocumentV1,
    knownThreads?: ThreadSummary[]
  ): Promise<ProjectBoardCard[]> {
    const threads = knownThreads ?? await this.boardThreads(workspaceRoot)
    const cards: ProjectBoardCard[] = Object.values(document.manualCards).map((card) => ({
      id: `manual:${card.id}`,
      kind: 'manual',
      workspaceRoot,
      title: card.title,
      description: card.description,
      status: card.status,
      category: card.category,
      priority: card.priority,
      archived: card.archived,
      updatedAt: card.updatedAt,
      source: { label: 'Manual' }
    }))
    const planCache = new Map<string, Map<number, PlanTaskMetadata>>()
    for (const thread of threads) {
      for (const todo of thread.todos?.items ?? []) {
        if (todo.source?.kind !== 'plan') continue
        const key = projectBoardTodoOverlayKey(thread.id, todo.id)
        const overlay = document.todoOverlays[key]
        const metadata = await planMetadata(workspaceRoot, todo, planCache)
        cards.push({
          id: `todo:${thread.id}:${todo.id}`,
          kind: 'thread_todo',
          workspaceRoot,
          title: todo.content,
          description: overlay?.description || metadata.description,
          status: todo.status,
          category: overlay?.category ?? 'plan',
          priority: overlay?.priority ?? null,
          archived: overlay?.archived ?? false,
          updatedAt: overlay && overlay.updatedAt > todo.updatedAt ? overlay.updatedAt : todo.updatedAt,
          source: {
            label: 'Plan',
            threadId: thread.id,
            todoId: todo.id,
            threadTitle: thread.title,
            planId: todo.source.planId,
            planRelativePath: todo.source.relativePath,
            ...(metadata.sectionTitle ? { sectionTitle: metadata.sectionTitle } : {}),
            ordinal: todo.source.ordinal
          }
        })
      }
    }
    return cards.sort(compareCards)
  }

  private async boardThreads(workspaceRoot: string): Promise<ThreadSummary[]> {
    return (await this.boardThreadMemberships())
      .filter((membership) => threadMembershipMatchesProject(membership, workspaceRoot))
      .map(({ thread }) => thread)
  }

  private async boardThreadMemberships(): Promise<BoardThreadMembership[]> {
    const threads = await this.options.threadStore.list({ includeArchived: false, includeSide: false })
    const candidates = threads.filter((thread) =>
      thread.status !== 'archived' &&
      thread.status !== 'deleted' &&
      thread.relation !== 'side' &&
      thread.agentSurface !== 'write')
    return Promise.all(candidates.map(async (thread) => {
      const rawWorkspace = thread.workspace ?? ''
      const workspace = await realpath(resolve(rawWorkspace)).catch(() => resolve(rawWorkspace))
      return { thread, workspace, gitProjectRoot: await gitProjectRootForWorktree(workspace) }
    }))
  }
}

export class ProjectBoardNotFoundError extends Error {
  override name = 'ProjectBoardNotFoundError'
}

export function projectBoardTodoOverlayKey(threadId: string, todoId: string): string {
  return Buffer.from(`${threadId}\0${todoId}`, 'utf8').toString('base64url')
}

async function canonicalWorkspaceRoot(workspace: string): Promise<string> {
  const trimmed = workspace.trim()
  if (!isAbsolute(trimmed)) throw new Error('project board workspace must be an absolute path')
  return realpath(resolve(trimmed))
}

function workspaceBelongsToProject(threadWorkspace: string, projectRoot: string): boolean {
  const normalized = resolve(threadWorkspace)
  if (pathIdentity(normalized) === pathIdentity(projectRoot)) return true
  const forward = normalized.replaceAll('\\', '/')
  const managed = forward.match(/\/\.kun\/worktrees\/(?:[0-9a-f]{4}|[0-9a-f-]{36})\/([^/]+)$/i)
  return Boolean(managed?.[1] && managed[1] === basename(projectRoot))
}

type BoardThreadMembership = {
  thread: ThreadSummary
  workspace: string
  gitProjectRoot: string | null
}

function threadMembershipMatchesProject(
  membership: BoardThreadMembership,
  projectRoot: string
): boolean {
  return workspaceBelongsToProject(membership.workspace, projectRoot) ||
    (membership.gitProjectRoot !== null &&
      pathIdentity(membership.gitProjectRoot) === pathIdentity(projectRoot))
}

function pathIdentity(path: string): string {
  return process.platform === 'win32' || process.platform === 'darwin'
    ? path.toLocaleLowerCase()
    : path
}

async function gitProjectRootForWorktree(workspace: string): Promise<string | null> {
  let dotGit: string
  try {
    dotGit = await readFile(resolve(workspace, '.git'), 'utf8')
  } catch {
    return null
  }
  const match = dotGit.match(/^gitdir:\s*(.+?)\s*$/im)
  if (!match?.[1]) return null
  const gitDir = resolve(workspace, match[1])
  const normalized = gitDir.replaceAll('\\', '/')
  const marker = normalized.toLocaleLowerCase().lastIndexOf('/.git/worktrees/')
  if (marker < 0) return null
  const root = normalized.slice(0, marker)
  return realpath(root).catch(() => resolve(root))
}

function emptyOverlay(threadId: string, todoId: string, now: string): ProjectBoardTodoOverlay {
  return { threadId, todoId, category: null, priority: null, description: '', archived: false, updatedAt: now }
}

function todoOverlayKeys(threads: readonly ThreadSummary[]): Set<string> {
  const keys = new Set<string>()
  for (const thread of threads) {
    for (const todo of thread.todos?.items ?? []) {
      if (todo.source?.kind === 'plan') keys.add(projectBoardTodoOverlayKey(thread.id, todo.id))
    }
  }
  return keys
}

function countCards(cards: readonly ProjectBoardCard[]): ProjectBoardCounts {
  const active = cards.filter((card) => !card.archived)
  return {
    pending: active.filter((card) => card.status === 'pending').length,
    inProgress: active.filter((card) => card.status === 'in_progress').length,
    completed: active.filter((card) => card.status === 'completed').length,
    archived: cards.length - active.length,
    total: active.length
  }
}

const PRIORITY_ORDER = new Map([['P0', 0], ['P1', 1], ['P2', 2]])
function compareCards(left: ProjectBoardCard, right: ProjectBoardCard): number {
  const byPriority = (PRIORITY_ORDER.get(left.priority ?? '') ?? 3) -
    (PRIORITY_ORDER.get(right.priority ?? '') ?? 3)
  if (byPriority !== 0) return byPriority
  const byUpdatedAt = right.updatedAt.localeCompare(left.updatedAt)
  return byUpdatedAt !== 0 ? byUpdatedAt : left.id.localeCompare(right.id)
}

function encodeCursor(offset: number): string {
  return Buffer.from(String(offset), 'utf8').toString('base64url')
}

function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0
  const parsed = Number(Buffer.from(cursor, 'base64url').toString('utf8'))
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error('invalid project board cursor')
  return parsed
}

type PlanTaskMetadata = { sectionTitle: string; description: string }

async function planMetadata(
  workspaceRoot: string,
  todo: ThreadTodoItem,
  cache: Map<string, Map<number, PlanTaskMetadata>>
): Promise<PlanTaskMetadata> {
  const source = todo.source
  if (!source) return { sectionTitle: '', description: '' }
  const absolutePath = resolve(workspaceRoot, source.relativePath)
  const rel = relative(workspaceRoot, absolutePath)
  if (rel.startsWith('..') || isAbsolute(rel)) return { sectionTitle: '', description: '' }
  let entries = cache.get(absolutePath)
  if (!entries) {
    entries = await readPlanTaskMetadata(absolutePath)
    cache.set(absolutePath, entries)
  }
  return entries.get(source.ordinal) ?? { sectionTitle: '', description: '' }
}

async function readPlanTaskMetadata(path: string): Promise<Map<number, PlanTaskMetadata>> {
  let markdown: string
  try {
    markdown = await readFile(path, 'utf8')
  } catch {
    return new Map()
  }
  const result = new Map<number, PlanTaskMetadata>()
  const lines = markdown.split(/\r?\n/)
  let sectionTitle = ''
  let ordinal = 0
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const heading = line.match(/^#{2,3}\s+(.+?)\s*$/)
    if (heading) sectionTitle = heading[1]?.trim() ?? ''
    if (!/^\s*[-*+]\s+\[[ xX]\]\s+/.test(line)) continue
    let description = ''
    const taskIndent = line.match(/^\s*/)?.[0].length ?? 0
    for (let child = index + 1; child < lines.length; child += 1) {
      const candidate = lines[child] ?? ''
      if (!candidate.trim()) continue
      const indent = candidate.match(/^\s*/)?.[0].length ?? 0
      if (indent <= taskIndent || /^\s*[-*+]\s+\[[ xX]\]\s+/.test(candidate)) break
      description = candidate.trim().replace(/^[-*+]\s+/, '')
      break
    }
    result.set(ordinal, { sectionTitle, description })
    ordinal += 1
  }
  return result
}
