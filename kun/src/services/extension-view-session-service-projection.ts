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
import { type ExtensionViewSessionEvent, type ExtensionViewSessionTarget, type StoredEvent } from './extension-view-session-service-contracts.js'

export function viewSessionMatchesWorkspace(
  target: ExtensionViewSessionTarget,
  workspaceRoots: readonly string[]
): boolean {
  const normalizedRoots = new Set(workspaceRoots.map((root) => resolve(root)))
  if (target.workspaceRoot === undefined) return normalizedRoots.size === 0
  return normalizedRoots.has(resolve(target.workspaceRoot))
}

export function viewSessionMatchesWorkspaceKey(
  target: ExtensionViewSessionTarget,
  workspaceKey: string
): boolean {
  if (target.workspaceRoot === undefined) return false
  try {
    return extensionWorkspaceKey(target.workspaceRoot) === workspaceKey
  } catch {
    // A malformed legacy target must fail closed without blocking peers.
    return false
  }
}

export function digestNonce(nonce: string): Buffer {
  return createHash('sha256').update(nonce).digest()
}

export function extensionPartition(extensionId: string): string {
  const digest = createHash('sha256').update(extensionId).digest('hex').slice(0, 24)
  // No `persist:` prefix: Webview browser storage is non-persistent by default.
  return `kun-extension-${digest}`
}

export function extensionResourceUrl(extensionId: string, entry: string): string {
  return `kun-extension://${extensionId}/${entry.split('/').map(encodeURIComponent).join('/')}`
}

export function cloneTarget(target: ExtensionViewSessionTarget): ExtensionViewSessionTarget {
  return {
    ...structuredClone(target),
    grantedPermissions: [...target.grantedPermissions]
  }
}

export function stripStoredEvent(event: StoredEvent): ExtensionViewSessionEvent {
  const { bytes: _bytes, ...projection } = event
  return structuredClone(projection)
}

export function boundedInteger(value: number | undefined, fallback: number, minimum: number): number {
  if (value === undefined) return fallback
  return Math.max(minimum, Math.floor(value))
}
