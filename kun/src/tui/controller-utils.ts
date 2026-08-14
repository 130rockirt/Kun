import type {
  AttachmentMetadata,
  GraphOrchestrationStrategy,
  GraphRunV1,
  ThreadGoalStatus,
  ThreadSummary,
  ThreadTodoItem,
  ThreadTodoStatus
} from '../contracts/index.js'
import {
  kunToolPermissionModeFromSettings,
  type ApprovalPolicy,
  type ApprovalReviewer,
  type SandboxMode
} from '../contracts/policy.js'
import {
  isModelConnectionProfileUsable,
  type ModelConnectionProfile,
  type ModelConnectionSnapshot
} from '../contracts/model-connections.js'
import type { ModelReasoningEffort, ModelReasoningCapabilityMetadata } from '../contracts/capabilities.js'
import { redactSecretText } from '../config/secret-redaction.js'
import {
  cp,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename as renameFile,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { UserInputAnswer } from './client.js'
import { execFile as execFileCallback } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import {
  KunTuiClient,
  TuiClientError,
  type TuiConnection
} from './client.js'
import type { TuiOptions } from './options.js'
import {
  applyRuntimeEvent,
  hydrateProjectedChildRuns,
  matchingRequestContextSnapshot,
  projectThreadSnapshot,
  setProjectionRunningTurn,
  type ThreadProjection
} from './state.js'
import {
  emptyTuiPersistentState,
  modelStateKey,
  readTuiPersistentState,
  writeTuiPersistentState,
  type TuiPersistentState,
  type TuiRecentModel
} from './persistence.js'
import { modelCapabilitiesForProviderModel } from '../loop/model-context-profile.js'
import { setVisualTheme, type TuiThemeName } from './visual-system.js'
import {
  KunProjectConfigSchema,
  loadKunProjectConfig,
  writeKunProjectConfig
} from '../config/project-config.js'
import { readRuntimeDiscovery } from '../server/runtime-discovery.js'
import { parsePastedFilePaths } from './pasted-paths.js'
import type { ClipboardImage } from './clipboard-image.js'
import {
  isTerminalGraphRun,
  latestTuiGraphRun,
  summarizeTuiGraphRun
} from './graph-mode.js'
import { parseTuiFileMentions } from './file-mentions.js'
const execFile = promisify(execFileCallback)

export function safeMessage(error: unknown): string {
  return redactSecretText(error instanceof Error ? error.message : String(error))
}

export function modelConnectionUnavailableMessage(
  profile: Pick<ModelConnectionProfile, 'name' | 'credentialStatus'> | undefined,
  providerId: string | undefined
): string {
  const label = profile?.name ?? providerId ?? 'The selected provider'
  const detail = profile?.credentialStatus === 'missing'
    ? 'credential is missing'
    : profile?.credentialStatus === 'unreadable'
      ? 'credential cannot be read'
      : 'connection is not configured'
  return `${label} ${detail}. Use /connect to reconnect it before starting a turn.`
}

export function isRefreshConflict(error: unknown): boolean {
  return error instanceof TuiClientError && (error.status === 404 || error.status === 409)
}

export function isMissingThread(error: unknown): boolean {
  return error instanceof TuiClientError && (error.status === 404 || error.status === 410)
}

export function replaceGraphRun(
  runs: readonly GraphRunV1[],
  run: GraphRunV1
): GraphRunV1[] {
  return [run, ...runs.filter((candidate) => candidate.id !== run.id)]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
}

export function splitWords(value: string): string[] {
  return value.trim().split(/\s+/u).filter(Boolean)
}

export function extensionGrantArguments(arguments_: string[]): string[] {
  const grant = arguments_.find((argument) => argument.startsWith('--grant='))
  if (!grant) return []
  return [...new Set(grant.slice('--grant='.length).split(',')
    .map((permission) => permission.trim())
    .filter(Boolean))]
}

export function todoInput(todo: ThreadTodoItem): {
  id: string
  content: string
  status: ThreadTodoStatus
  source?: ThreadTodoItem['source']
} {
  return {
    id: todo.id,
    content: todo.content,
    status: todo.status,
    ...(todo.source ? { source: todo.source } : {})
  }
}

export function resolveTodo(items: ThreadTodoItem[], target: string): ThreadTodoItem | undefined {
  const ordinal = Number(target)
  if (Number.isSafeInteger(ordinal) && ordinal > 0) return items[ordinal - 1]
  return items.find((item) => item.id === target)
}

export function attachmentIdsFromProjection(projection: ThreadProjection): string[] {
  return [...new Set([
    ...projection.thread.turns.flatMap((turn) => turn.attachmentIds),
    ...projection.items.flatMap((item) => item.kind === 'user_message' ? item.attachmentIds ?? [] : [])
  ])]
}

export function mergeAttachmentMetadata(
  current: Readonly<Record<string, AttachmentMetadata>>,
  attachments: readonly AttachmentMetadata[]
): Record<string, AttachmentMetadata> {
  if (attachments.length === 0) return { ...current }
  const next = { ...current }
  for (const attachment of attachments) next[attachment.id] = attachment
  return next
}

export function attachmentMimeType(path: string, data?: Buffer): string {
  switch (extname(path).toLowerCase()) {
    case '.png': return 'image/png'
    case '.jpg':
    case '.jpeg': return 'image/jpeg'
    case '.webp': return 'image/webp'
    case '.pdf': return 'application/pdf'
    case '.json': return 'application/json'
    case '.md': return 'text/markdown'
    case '.txt':
    case '.log': return 'text/plain'
    case '.csv': return 'text/csv'
    default: return data && isLikelyUtf8Text(data) ? 'text/plain' : 'application/octet-stream'
  }
}

export function isLikelyUtf8Text(data: Buffer): boolean {
  if (data.includes(0)) return false
  return !data.toString('utf8').includes('\uFFFD')
}

export function isVideoPath(path: string): boolean {
  return new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi']).has(extname(path).toLowerCase())
}

export function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(1)} KiB`
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MiB`
}

export function normalizeSkillId(value: string): string {
  const replaced = value.trim().toLowerCase().replace(/[^a-z0-9-]+/gu, '-')
  let start = 0
  let end = replaced.length
  while (start < end && replaced.charCodeAt(start) === 45) start += 1
  while (end > start && replaced.charCodeAt(end - 1) === 45) end -= 1
  const normalized = replaced.slice(start, end)
  return normalized.length > 0 && normalized.length <= 64 ? normalized : ''
}

export function skillTemplate(id: string, description: string): string {
  return [
    '---',
    `name: ${id}`,
    `description: ${description.replaceAll('\n', ' ').trim()}`,
    '---',
    '',
    `# ${id}`,
    '',
    'Describe when this skill should be used and the exact workflow Kun should follow.',
    ''
  ].join('\n')
}

export async function assertPathMissing(path: string): Promise<void> {
  try {
    await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  throw new Error(`Path already exists: ${path}`)
}

export async function writeTextAtomically(path: string, content: string): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`)
  await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600 })
  await renameFile(temporary, path)
}

export function isPathInside(parent: string, target: string): boolean {
  const value = relative(parent, target)
  return value === '' || (value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value))
}

export async function validateSkillImportTree(root: string): Promise<void> {
  let files = 0
  let bytes = 0
  const visit = async (path: string): Promise<void> => {
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink()) throw new Error('Skill imports may not contain symbolic links.')
    if (metadata.isFile()) {
      files += 1
      bytes += metadata.size
      if (files > 256 || bytes > 10 * 1024 * 1024) {
        throw new Error('Skill import exceeds the 256 file / 10 MiB safety limit.')
      }
      return
    }
    if (!metadata.isDirectory()) throw new Error('Skill imports may contain only regular files and directories.')
    for (const entry of await readdir(path)) {
      if (entry === '.git') continue
      await visit(join(path, entry))
    }
  }
  await visit(root)
}
