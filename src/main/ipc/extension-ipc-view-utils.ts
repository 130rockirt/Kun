import {
  LocaleSchema,
  ThemeSchema
} from '@kun/extension-api'
import {
  webContents,
  type WebContents
} from 'electron'
import {
  resolve
} from 'node:path'
import type {
  ExtensionViewEventPayload
} from '../../shared/extension-ipc'
import {
  extensionIdSchema,
  extensionSessionIdSchema
} from './app-ipc-schemas/extensions'
import type {
  ExtensionViewSessionRegistry
} from '../extensions/extension-view-sessions'
import type {
  ExtensionWorkbenchEnvironment,
  RegisterExtensionIpcHandlersOptions
} from './extension-ipc-handler-options'
import { isRecord, runtimeFailure, safeJsonParse } from './extension-ipc-common'

export function parseRuntimeViewSession(body: string): {
  sessionId: string
  nonce: string
  contributionId: string
  extensionId: string
  extensionVersion: string
} | undefined {
  const parsed = safeJsonParse(body)
  if (!isRecord(parsed)) return undefined
  const record = isRecord(parsed.session) ? parsed.session : parsed
  const sessionId = extensionSessionIdSchema.safeParse(record.sessionId)
  if (
    !sessionId.success ||
    typeof record.nonce !== 'string' ||
    record.nonce.length < 32 ||
    record.nonce.length > 256 ||
    typeof record.contributionId !== 'string' ||
    typeof record.extensionId !== 'string' ||
    typeof record.extensionVersion !== 'string'
  ) return undefined
  return {
    sessionId: sessionId.data,
    nonce: record.nonce,
    contributionId: record.contributionId,
    extensionId: record.extensionId,
    extensionVersion: record.extensionVersion
  }
}

export function parseQualifiedContributionId(value: string): { extensionId: string; localId: string } {
  const match = /^extension:([^/]+)\/([^/]+)$/.exec(value)
  if (!match) throw new Error('Extension contribution ID is invalid.')
  return { extensionId: extensionIdSchema.parse(match[1]), localId: match[2]! }
}

export function localContributionId(value: string, extensionId: string): string {
  const parsed = parseQualifiedContributionId(value)
  if (parsed.extensionId !== extensionId) throw new Error('Content script identity mismatch.')
  return parsed.localId
}

export function extensionSessionHeaders(record: { runtimeSessionId: string; nonce: string }): Record<string, string> {
  return {
    'x-kun-extension-session-id': record.runtimeSessionId,
    'x-kun-extension-session-nonce': record.nonce
  }
}

export function requireWorkbenchOwnedSession(
  options: RegisterExtensionIpcHandlersOptions,
  sender: WebContents,
  sessionId: string
) {
  const record = options.viewSessions.get(sessionId)
  if (!record || record.parentWebContentsId !== sender.id || record.state === 'disposed') {
    throw new Error('Extension View Session is not owned by this workbench.')
  }
  return record
}

export function dispatchViewEvents(
  sessionId: string,
  guestWebContentsId: number | undefined,
  body: string,
  workbench: WebContents,
  viewSessions: ExtensionViewSessionRegistry
): void {
  const payload = safeJsonParse(body)
  if (!isRecord(payload) || !Array.isArray(payload.events)) return
  const eventPayload: ExtensionViewEventPayload = {
    sessionId,
    cursor: typeof payload.nextCursor === 'number'
      ? payload.nextCursor
      : typeof payload.cursor === 'number' ? payload.cursor : undefined,
    events: payload.events
  }
  workbench.send('extension:view-event', eventPayload)
  for (const event of payload.events) {
    if (!isRecord(event)) continue
    const guest = guestWebContentsId === undefined ? undefined : webContents.fromId(guestWebContentsId)
    if (event.type === 'message' && isRecord(event.payload)) {
      guest?.send('extension:view:notification', {
        sessionId,
        method: 'ui.message',
        params: event.payload
      })
    } else if (event.type === 'notification') {
      guest?.send('extension:view:notification', {
        sessionId,
        method: 'ui.notification',
        params: event.payload
      })
    } else if (
      event.type === 'bridge' &&
      isRecord(event.payload) &&
      typeof event.payload.method === 'string' &&
      isAllowedExtensionViewNotification(event.payload.method)
    ) {
      viewSessions.sendToGuest(
        sessionId,
        event.payload.method,
        event.payload.params
      )
    }
  }
}

export async function pumpExtensionViewEvents(
  options: RegisterExtensionIpcHandlersOptions,
  sessionId: string,
  signal: AbortSignal
): Promise<void> {
  let cursor = 0
  let consecutiveFailures = 0
  while (!signal.aborted) {
    const record = options.viewSessions.get(sessionId)
    if (!record || record.state === 'disposed') return
    if (record.state !== 'active') {
      await abortableDelay(50, signal)
      continue
    }
    const result = await options.runtimeRequest(
      `/v1/extensions/view-sessions/${encodeURIComponent(record.runtimeSessionId)}/events?cursor=${cursor}&limit=100`,
      'GET',
      undefined,
      extensionSessionHeaders(record)
    ).catch((error) => runtimeFailure(
      'EXTENSION_VIEW_EVENT_FETCH_FAILED',
      error instanceof Error ? error.message : 'View event fetch failed.',
      0
    ))
    if (signal.aborted) return
    if (result.ok) {
      consecutiveFailures = 0
      const payload = safeJsonParse(result.body)
      if (isRecord(payload)) {
        const nextCursor = payload.nextCursor
        if (typeof nextCursor === 'number' && Number.isSafeInteger(nextCursor) && nextCursor >= cursor) {
          cursor = nextCursor
        }
        const workbench = options.getMainWindow()?.webContents
        if (workbench && !workbench.isDestroyed()) {
          dispatchViewEvents(
            sessionId,
            record.guestWebContentsId,
            result.body,
            workbench,
            options.viewSessions
          )
        }
        if (payload.hasMore === true) continue
      }
    } else {
      consecutiveFailures += 1
      if (result.status === 409) {
        const failure = safeJsonParse(result.body)
        if (
          isRecord(failure) &&
          typeof failure.oldestAvailableCursor === 'number' &&
          Number.isSafeInteger(failure.oldestAvailableCursor) &&
          failure.oldestAvailableCursor >= 0
        ) {
          options.viewSessions.sendToGuest(sessionId, 'ui.message', {
            channel: 'kun.extension.view.overflow',
            payload: {
              code: 'cursor_expired',
              oldestAvailableCursor: failure.oldestAvailableCursor
            }
          })
          cursor = failure.oldestAvailableCursor
          continue
        }
      }
      if (result.status === 401 || result.status === 403 || result.status === 404) {
        options.viewSessions.dispose(sessionId)
        return
      }
    }
    await abortableDelay(Math.min(5_000, 350 * Math.max(1, consecutiveFailures)), signal)
  }
}

const EXTENSION_VIEW_NOTIFICATION_METHODS = new Set([
  'agent.event',
  'jobs.event',
  'modelProviders.statusChanged',
  'ui.localeChanged',
  'ui.themeChanged'
])

function isAllowedExtensionViewNotification(method: string): boolean {
  return EXTENSION_VIEW_NOTIFICATION_METHODS.has(method)
}

export async function loadWorkbenchEnvironment(
  options: RegisterExtensionIpcHandlersOptions
): Promise<ExtensionWorkbenchEnvironment> {
  const environment = await options.getWorkbenchEnvironment()
  return {
    theme: ThemeSchema.parse(environment.theme),
    locale: LocaleSchema.parse(environment.locale)
  }
}

type WorkbenchEnvironmentSyncBatch = {
  notifyGuests: boolean
  promise: Promise<void>
}

export function createWorkbenchEnvironmentSyncQueue(
  options: RegisterExtensionIpcHandlersOptions,
  notifyGuests: (environment: ExtensionWorkbenchEnvironment) => void
): {
    syncToRuntime(): Promise<void>
    publishChanged(): Promise<void>
    dispose(): void
  } {
  let disposed = false
  let tail = Promise.resolve()
  let pendingBatch: WorkbenchEnvironmentSyncBatch | undefined

  const schedule = (shouldNotifyGuests: boolean): Promise<void> => {
    if (disposed) return Promise.resolve()
    if (pendingBatch) {
      pendingBatch.notifyGuests ||= shouldNotifyGuests
      return pendingBatch.promise
    }

    const batch: WorkbenchEnvironmentSyncBatch = {
      notifyGuests: shouldNotifyGuests,
      promise: Promise.resolve()
    }
    const run = tail.then(async () => {
      if (pendingBatch === batch) pendingBatch = undefined
      if (disposed) return

      // Read the authoritative Host state only after every older PUT has settled.
      // This keeps queued calls coalesced and makes the last requested state win.
      const environment = await loadWorkbenchEnvironment(options)
      await syncWorkbenchEnvironmentToRuntime(options, environment)
      if (batch.notifyGuests && pendingBatch?.notifyGuests !== true && !disposed) {
        notifyGuests(environment)
      }
    })
    batch.promise = run
    pendingBatch = batch
    tail = run.catch(() => undefined)
    return run
  }

  return {
    syncToRuntime: () => schedule(false),
    publishChanged: () => schedule(true),
    dispose: () => {
      disposed = true
      pendingBatch = undefined
    }
  }
}

async function syncWorkbenchEnvironmentToRuntime(
  options: RegisterExtensionIpcHandlersOptions,
  environment: ExtensionWorkbenchEnvironment
): Promise<void> {
  try {
    const result = await options.runtimeRequest(
      '/v1/extensions/workbench/environment',
      'PUT',
      JSON.stringify(environment)
    )
    if (!result.ok) {
      options.logError?.('extension-workbench', 'Kun rejected the workbench environment update.', {
        status: result.status
      })
    }
  } catch (error) {
    options.logError?.('extension-workbench', 'Failed to synchronize the workbench environment.', {
      message: error instanceof Error ? error.message : String(error)
    })
  }
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const finish = (): void => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    timer.unref?.()
    const onAbort = (): void => {
      clearTimeout(timer)
      finish()
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
