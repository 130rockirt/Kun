import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { resolve } from 'node:path'
import {
  HostMessageSchema,
  LocaleSchema,
  NotificationOptionsSchema,
  ThemeSchema,
  type HostMessage,
  type JsonValue,
  type Locale,
  type NotificationOptions,
  type Theme
} from '@kun/extension-api'
import type { ExtensionPrincipal } from './extension-agent-service.js'
import { extensionWorkspaceKey } from '../extensions/paths.js'

export const DEFAULT_EXTENSION_VIEW_SESSION_TTL_MS = 2 * 60 * 60_000

export const DEFAULT_EXTENSION_VIEW_EVENT_LIMIT = 256

export const DEFAULT_EXTENSION_VIEW_EVENT_BYTES = 512 * 1024

export const DEFAULT_EXTENSION_VIEW_MESSAGE_RATE = 120

export const DEFAULT_EXTENSION_VIEW_IN_FLIGHT_LIMIT = 16

export const DEFAULT_EXTENSION_NOTIFICATION_TTL_MS = 45_000

export const DEFAULT_EXTENSION_NOTIFICATION_LIMIT = 64

export const DEFAULT_EXTENSION_NOTIFICATION_PER_EXTENSION_LIMIT = 8

export const DEFAULT_EXTENSION_WORKBENCH_LEASE_MS = 15_000

export const MAX_SINGLE_EVENT_BYTES = 256 * 1024

export type ExtensionViewSessionTarget = {
  extensionId: string
  extensionVersion: string
  contributionId: string
  localContributionId: string
  entry: string
  activationEvent: string
  workspaceRoot?: string
  grantedPermissions: readonly string[]
  workspaceTrusted: boolean
}

export type ExtensionViewSessionProjection = {
  sessionId: string
  contributionId: string
  extensionId: string
  extensionVersion: string
  src: string
  partition: string
  workspaceRoot?: string
  createdAt: string
  expiresAt: string
}

export type CreatedExtensionViewSession = ExtensionViewSessionProjection & {
  /** Returned once to trusted Electron Main; the service stores only its digest. */
  nonce: string
}

export type ExtensionViewSessionLifecycleEvent = {
  state: 'created' | 'disposed'
  session: ExtensionViewSessionProjection
}

export type ExtensionViewSessionEvent = {
  sequence: number
  timestamp: string
  type: 'session' | 'message' | 'notification' | 'bridge' | 'overflow'
  payload: JsonValue
}

export type ExtensionViewSessionReplay = {
  events: ExtensionViewSessionEvent[]
  nextCursor: number
  hasMore: boolean
  cursorExpired: boolean
  oldestAvailableCursor: number
}

export type StoredEvent = ExtensionViewSessionEvent & { bytes: number }

export type StoredSession = {
  projection: ExtensionViewSessionProjection
  target: ExtensionViewSessionTarget
  nonceDigest: Buffer
  nextSequence: number
  events: StoredEvent[]
  retainedBytes: number
  listeners: Set<(event: ExtensionViewSessionEvent) => void>
  requestWindowStartedAt: number
  requestCount: number
  inFlight: number
  operations: Map<string, AbortController>
  disposed: boolean
}

export type ExtensionWorkbenchNotification = {
  notificationId: string
  extensionId: string
  extensionVersion: string
  sourceId: string
  title: string
  message: string
  severity: 'info' | 'warning' | 'error'
  actions: Array<{ id: string; title: string }>
  createdAt: string
  expiresAt: string
}

export type PendingWorkbenchNotification = {
  projection: ExtensionWorkbenchNotification
  workspaceIds: readonly string[]
  resolve: (actionId: string | undefined) => void
  timer: NodeJS.Timeout
  signal?: AbortSignal
  abortListener?: () => void
}

export type ExtensionViewPublishScope =
  | { workspaceRoots: readonly string[] }
  | { workspaceKey: string }

export type ExtensionViewSessionServiceOptions = {
  now?: () => Date
  ttlMs?: number
  maxSessions?: number
  maxEvents?: number
  maxEventBytes?: number
  maxRequestsPerMinute?: number
  maxInFlight?: number
  notificationTtlMs?: number
  maxNotifications?: number
  maxNotificationsPerExtension?: number
  workbenchLeaseMs?: number
}

export class ExtensionViewSessionError extends Error {
  constructor(
    readonly code:
      | 'not_found'
      | 'unauthorized'
      | 'rate_limited'
      | 'session_limit'
      | 'payload_too_large',
    message: string
  ) {
    super(message)
  }
}
