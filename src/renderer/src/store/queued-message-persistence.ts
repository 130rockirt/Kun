import { browserStorage, type BrowserStorageLike } from '../lib/browser-storage'
import type { ChatBlock } from '../agent/types'
import type { ApprovalPolicy, ApprovalReviewer, SandboxMode } from '@shared/app-settings'
import type { QueuedUserMessage } from './chat-store-types'

export type QueuedMessageDeliveryState = 'pending' | 'paused' | 'starting' | 'in_flight' | 'failed'

export type QueuedMessageRegistry = {
  version: 1
  threads: Record<string, {
    messages: QueuedUserMessage[]
    updatedAt: string
  }>
}

const QUEUED_MESSAGE_REGISTRY_KEY = 'kun.queuedMessages.v1'

export function emptyQueuedMessageRegistry(): QueuedMessageRegistry {
  return { version: 1, threads: {} }
}

function normalizedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

const APPROVAL_POLICY_VALUES: readonly string[] = [
  'always', 'on-request', 'untrusted', 'never', 'auto', 'suggest'
]
const SANDBOX_MODE_VALUES: readonly string[] = [
  'read-only', 'workspace-write', 'danger-full-access', 'external-sandbox'
]
const APPROVAL_REVIEWER_VALUES: readonly string[] = ['user', 'agent']

function isApprovalPolicy(value: unknown): value is ApprovalPolicy {
  return typeof value === 'string' && APPROVAL_POLICY_VALUES.includes(value)
}

function isSandboxMode(value: unknown): value is SandboxMode {
  return typeof value === 'string' && SANDBOX_MODE_VALUES.includes(value)
}

function isApprovalReviewer(value: unknown): value is ApprovalReviewer {
  return typeof value === 'string' && APPROVAL_REVIEWER_VALUES.includes(value)
}

function normalizeDesignImagePlacementTarget(
  value: unknown
): QueuedUserMessage['designImagePlacementTarget'] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const source = value as Record<string, unknown>
  const shapeId = normalizedString(source.shapeId)
  const expectedImageUrl = normalizedString(source.expectedImageUrl)
  const expectedHolderKind = source.expectedHolderKind === 'explicit' ? 'explicit' as const
    : source.expectedHolderKind === 'implicit-image' ? 'implicit-image' as const
      : source.expectedHolderKind === 'implicit-frame' ? 'implicit-frame' as const
        : source.expectedHolderKind === 'implicit-rect' ? 'implicit-rect' as const
          : undefined
  if (!shapeId || shapeId.length > 256 || expectedImageUrl.length > 8_192 ||
    Boolean(expectedImageUrl) === Boolean(expectedHolderKind)) return undefined
  return {
    shapeId,
    ...(expectedImageUrl ? { expectedImageUrl } : { expectedHolderKind })
  }
}

function normalizeWriteContext(
  value: unknown
): QueuedUserMessage['writeContext'] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const source = value as Record<string, unknown>
  const workspaceRoot = normalizedString(source.workspaceRoot)
  const activeFilePath = source.activeFilePath === null
    ? null
    : normalizedString(source.activeFilePath)
  const documentEpoch = source.documentEpoch
  const contentRevision = source.contentRevision
  const threadId = normalizedString(source.threadId)
  const whiteboardId = normalizedString(source.whiteboardId)
  const whiteboardRevision = source.whiteboardRevision
  const expectedSha256 = normalizedString(source.expectedSha256)
  if (
    !workspaceRoot || !threadId ||
    (activeFilePath !== null && !activeFilePath) ||
    typeof documentEpoch !== 'number' || !Number.isInteger(documentEpoch) || documentEpoch < 0 ||
    typeof contentRevision !== 'number' || !Number.isInteger(contentRevision) || contentRevision < 0 ||
    (whiteboardId && (
      typeof whiteboardRevision !== 'number' || !Number.isInteger(whiteboardRevision) || whiteboardRevision < 0
    )) ||
    (expectedSha256 && !/^[a-f0-9]{64}$/.test(expectedSha256))
  ) return undefined
  return {
    workspaceRoot,
    activeFilePath,
    documentEpoch,
    contentRevision,
    threadId,
    ...(whiteboardId ? { whiteboardId } : {}),
    ...(whiteboardId && Number.isInteger(whiteboardRevision)
      ? { whiteboardRevision: whiteboardRevision as number }
      : {}),
    ...(expectedSha256 ? { expectedSha256 } : {})
  }
}

function normalizeQueuedMessage(value: unknown): QueuedUserMessage | null {
  if (!value || typeof value !== 'object') return null
  const source = value as Record<string, unknown>
  const id = normalizedString(source.id)
  const text = normalizedString(source.text)
  if (!id || !text) return null
  const hasWriteContext = source.writeContext !== undefined
  const writeContext = normalizeWriteContext(source.writeContext)
  if (hasWriteContext && !writeContext) return null

  const deliveryState: QueuedMessageDeliveryState =
    source.deliveryState === 'paused' || source.deliveryState === 'starting' || source.deliveryState === 'in_flight' || source.deliveryState === 'failed'
    ? source.deliveryState
    : 'pending'
  const deliveryTurnId = normalizedString(source.deliveryTurnId)
  const deliveryUserMessageItemId = normalizedString(source.deliveryUserMessageItemId)
  const normalized: QueuedUserMessage = {
    ...(source as QueuedUserMessage),
    id,
    text,
    deliveryState
  }
  if (deliveryTurnId && deliveryState !== 'pending') normalized.deliveryTurnId = deliveryTurnId
  else delete normalized.deliveryTurnId
  if (deliveryUserMessageItemId && deliveryState !== 'pending') {
    normalized.deliveryUserMessageItemId = deliveryUserMessageItemId
  } else {
    delete normalized.deliveryUserMessageItemId
  }
  if (source.serviceTier === 'priority') normalized.serviceTier = 'priority'
  else delete normalized.serviceTier
  if (source.messageSource === 'design_continuation') {
    normalized.messageSource = 'design_continuation'
  } else {
    delete normalized.messageSource
  }
  const backgroundRuntimeText = typeof source.backgroundRuntimeText === 'string'
    ? source.backgroundRuntimeText
    : ''
  if (backgroundRuntimeText) normalized.backgroundRuntimeText = backgroundRuntimeText
  else delete normalized.backgroundRuntimeText
  const backgroundCheckpointRequestId = normalizedString(source.backgroundCheckpointRequestId)
  if (backgroundCheckpointRequestId) normalized.backgroundCheckpointRequestId = backgroundCheckpointRequestId
  else delete normalized.backgroundCheckpointRequestId
  const clientRequestId = normalizedString(source.clientRequestId)
  if (clientRequestId) normalized.clientRequestId = clientRequestId
  else delete normalized.clientRequestId
  if (source.waitForRuntimeAdmission === true) normalized.waitForRuntimeAdmission = true
  else delete normalized.waitForRuntimeAdmission
  if (isApprovalPolicy(source.approvalPolicy)) normalized.approvalPolicy = source.approvalPolicy
  else delete normalized.approvalPolicy
  if (isSandboxMode(source.sandboxMode)) normalized.sandboxMode = source.sandboxMode
  else delete normalized.sandboxMode
  if (isApprovalReviewer(source.approvalReviewer)) normalized.approvalReviewer = source.approvalReviewer
  else delete normalized.approvalReviewer
  if (writeContext) normalized.writeContext = writeContext
  else delete normalized.writeContext
  const placementTarget = normalizeDesignImagePlacementTarget(source.designImagePlacementTarget)
  if (placementTarget) normalized.designImagePlacementTarget = placementTarget
  else delete normalized.designImagePlacementTarget
  const expectedThreadId = normalizedString(source.expectedThreadId)
  if (expectedThreadId) normalized.expectedThreadId = expectedThreadId
  else delete normalized.expectedThreadId
  const resume = source.subagentResume
  if (resume && typeof resume === 'object' && !Array.isArray(resume)) {
    const childId = normalizedString((resume as Record<string, unknown>).childId)
    const expectedResumeCount = (resume as Record<string, unknown>).expectedResumeCount
    if (
      childId &&
      typeof expectedResumeCount === 'number' &&
      Number.isInteger(expectedResumeCount) &&
      expectedResumeCount >= 0
    ) {
      normalized.subagentResume = { childId, expectedResumeCount }
    } else {
      delete normalized.subagentResume
    }
  } else {
    delete normalized.subagentResume
  }
  return normalized
}

export function normalizeQueuedMessageRegistry(raw: unknown): QueuedMessageRegistry {
  if (!raw || typeof raw !== 'object') return emptyQueuedMessageRegistry()
  const source = raw as { threads?: unknown }
  if (!source.threads || typeof source.threads !== 'object') return emptyQueuedMessageRegistry()

  const entries: Array<[string, QueuedMessageRegistry['threads'][string]]> = []
  for (const [threadIdKey, value] of Object.entries(source.threads as Record<string, unknown>)) {
    const threadId = normalizedString(threadIdKey)
    if (!threadId || !value || typeof value !== 'object') continue
    const record = value as { messages?: unknown; updatedAt?: unknown }
    if (!Array.isArray(record.messages)) continue
    const seenIds = new Set<string>()
    const messages = record.messages.flatMap((message) => {
      const normalized = normalizeQueuedMessage(message)
      if (normalized?.writeContext && normalized.writeContext.threadId !== threadId) {
        return []
      }
      if (!normalized || seenIds.has(normalized.id)) return []
      seenIds.add(normalized.id)
      return [normalized]
    })
    if (messages.length === 0) continue
    entries.push([
      threadId,
      {
        messages,
        updatedAt: normalizedString(record.updatedAt) || new Date(0).toISOString()
      }
    ])
  }

  return {
    version: 1,
    threads: Object.fromEntries(entries)
  }
}

export function readQueuedMessageRegistry(
  storage: BrowserStorageLike | null = browserStorage()
): QueuedMessageRegistry {
  if (!storage) return emptyQueuedMessageRegistry()
  try {
    const raw = storage.getItem(QUEUED_MESSAGE_REGISTRY_KEY)
    return normalizeQueuedMessageRegistry(raw ? JSON.parse(raw) : null)
  } catch {
    return emptyQueuedMessageRegistry()
  }
}

export function saveQueuedMessageRegistry(
  registry: QueuedMessageRegistry,
  storage: BrowserStorageLike | null = browserStorage()
): void {
  if (!storage) return
  try {
    storage.setItem(
      QUEUED_MESSAGE_REGISTRY_KEY,
      JSON.stringify(normalizeQueuedMessageRegistry(registry))
    )
  } catch {
    /* Ignore storage failures; the live in-memory queue remains intact. */
  }
}

export function queuedMessagesForThread(
  threadId: string,
  storage: BrowserStorageLike | null = browserStorage()
): QueuedUserMessage[] {
  const id = normalizedString(threadId)
  if (!id) return []
  return readQueuedMessageRegistry(storage).threads[id]?.messages ?? []
}

export function saveQueuedMessagesForThread(
  threadId: string,
  messages: readonly QueuedUserMessage[],
  storage: BrowserStorageLike | null = browserStorage()
): void {
  const id = normalizedString(threadId)
  if (!id || !storage) return
  const registry = readQueuedMessageRegistry(storage)
  const threads = { ...registry.threads }
  const normalizedMessages = messages.flatMap((message) => {
    const normalized = normalizeQueuedMessage(message)
    return normalized ? [normalized] : []
  })
  if (normalizedMessages.length === 0) {
    delete threads[id]
  } else {
    delete threads[id]
    threads[id] = {
      messages: normalizedMessages,
      updatedAt: new Date().toISOString()
    }
  }
  saveQueuedMessageRegistry({ version: 1, threads }, storage)
}

export function forgetQueuedMessagesForThread(
  threadId: string,
  storage: BrowserStorageLike | null = browserStorage()
): void {
  const id = normalizedString(threadId)
  if (!id || !storage) return
  const registry = readQueuedMessageRegistry(storage)
  if (!registry.threads[id]) return
  const threads = { ...registry.threads }
  delete threads[id]
  saveQueuedMessageRegistry({ version: 1, threads }, storage)
}

export function isPendingQueuedMessage(message: QueuedUserMessage): boolean {
  return !message.deliveryState || message.deliveryState === 'pending'
}

/**
 * Reconcile durable delivery markers against the runtime's current thread state.
 * A settled in-flight item is removed; an interrupted pre-send item is returned
 * to pending so it cannot be silently lost after an app restart.
 */
export function reconcileQueuedMessages(
  messages: readonly QueuedUserMessage[],
  runtime: { busy: boolean; turnId?: string | null; blocks?: readonly ChatBlock[] }
): QueuedUserMessage[] {
  const activeTurnId = normalizedString(runtime.turnId)
  const reconciled: QueuedUserMessage[] = []
  for (const message of messages) {
    const state = message.deliveryState ?? 'pending'
    // A terminal failure stays failed across reconciliation; only an explicit
    // user retry or removal moves it.
    if (state === 'failed') {
      reconciled.push({
        ...message,
        deliveryState: 'failed'
      })
      continue
    }
    if (state === 'pending' || state === 'paused') {
      if (
        message.deliveryState === state &&
        !message.deliveryTurnId &&
        !message.deliveryUserMessageItemId
      ) {
        reconciled.push(message)
      } else {
        const retained = { ...message, deliveryState: state }
        delete retained.deliveryTurnId
        delete retained.deliveryUserMessageItemId
        reconciled.push(retained)
      }
      continue
    }
    if (state === 'starting') {
      if (!runtime.busy) {
        const pending = { ...message, deliveryState: 'pending' as const }
        delete pending.deliveryTurnId
        delete pending.deliveryUserMessageItemId
        reconciled.push(pending)
        continue
      }
      reconciled.push({
        ...message,
        deliveryState: 'in_flight',
        ...(activeTurnId ? { deliveryTurnId: activeTurnId } : {})
      })
      continue
    }
    if (!runtime.busy) {
      if (
        message.deliveryState === 'in_flight' &&
        message.deliveryTurnId &&
        message.deliveryTurnId !== activeTurnId &&
        message.clientRequestId
      ) {
        // Runtime-queue ownership (clientRequestId marks an enqueueIfBusy
        // admission): the server drains this entry, so a local reset to
        // pending would double-send. Entries without the marker keep the
        // historical evidence-based settlement below.
        reconciled.push(message)
        continue
      }
      const deliveryTurnId = normalizedString(message.deliveryTurnId)
      const deliveryUserMessageItemId = normalizedString(message.deliveryUserMessageItemId)
      const wasAccepted = runtime.blocks?.some((block) =>
        (deliveryUserMessageItemId && block.kind === 'user' && block.id === deliveryUserMessageItemId) ||
        (deliveryTurnId && 'turnId' in block && block.turnId === deliveryTurnId) ||
        (deliveryTurnId && block.kind === 'user' && block.meta?.turnId === deliveryTurnId)
      ) === true
      if (wasAccepted) continue
      const pending = { ...message, deliveryState: 'pending' as const }
      delete pending.deliveryTurnId
      delete pending.deliveryUserMessageItemId
      reconciled.push(pending)
      continue
    }
    const deliveryTurnId = normalizedString(message.deliveryTurnId)
    if (deliveryTurnId && activeTurnId && deliveryTurnId !== activeTurnId) {
      // Parked runtime-queue entry: the active turn belongs to an earlier
      // message, this one still waits in the server-side queue.
      reconciled.push(message)
      continue
    }
    const resolvedTurnId = deliveryTurnId || activeTurnId
    if (message.deliveryState === 'in_flight' && message.deliveryTurnId === resolvedTurnId) {
      reconciled.push(message)
      continue
    }
    reconciled.push({
      ...message,
      deliveryState: 'in_flight',
      ...(resolvedTurnId
        ? { deliveryTurnId: resolvedTurnId }
        : {})
    })
  }
  return reconciled
}
