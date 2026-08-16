import {
  readManagerRuntime,
  type ServiceManagerConnection
} from '../../../kun/src/manager/manager-client.js'
import type { StorageRelocationActiveWork } from '../../shared/storage-relocation'
import { reconcileDeadManagerRuntimeRegistrations } from './service-manager-runtime-reconciliation'

const MANAGED_RUNTIME_FLAVORS = ['production', 'development'] as const

/**
 * Read active Runtime work after reconciling Manager slots whose owner PID is
 * proven dead. A live owner that cannot be inspected remains an external
 * writer, preserving the migration fail-closed boundary.
 */
export async function listServiceManagerRuntimeActiveWork(
  manager: ServiceManagerConnection,
  options: { fetch?: typeof fetch } = {}
): Promise<StorageRelocationActiveWork[]> {
  const fetchImpl = options.fetch ?? fetch
  await reconcileDeadManagerRuntimeRegistrations(manager, { fetch: fetchImpl })
  const work: StorageRelocationActiveWork[] = []
  for (const flavor of MANAGED_RUNTIME_FLAVORS) {
    const registration = await readManagerRuntime(manager, flavor, fetchImpl)
    if (!registration) continue
    const response = await fetchImpl(`${registration.baseUrl}/v1/threads?limit=500&include=side`, {
      headers: { authorization: `Bearer ${registration.runtimeToken}` },
      signal: AbortSignal.timeout(5_000)
    }).catch(() => null)
    if (!response?.ok) {
      work.push({
        kind: 'external-writer',
        id: `runtime:${flavor}:${registration.instanceId}`,
        label: `${flavor} Runtime could not be inspected`,
        interruptible: false
      })
      continue
    }
    const payload = await response.json().catch(() => null) as { threads?: unknown } | null
    for (const thread of Array.isArray(payload?.threads) ? payload.threads : []) {
      if (!thread || typeof thread !== 'object') continue
      const value = thread as { id?: unknown; title?: unknown; status?: unknown; turns?: unknown }
      const threadId = typeof value.id === 'string' ? value.id : ''
      const threadActive = value.status === 'queued' || value.status === 'in_progress' ||
        value.status === 'started' || value.status === 'running'
      let turns = Array.isArray(value.turns) ? value.turns : []
      if (threadActive && turns.length === 0 && threadId) {
        const detailResponse = await fetchImpl(
          `${registration.baseUrl}/v1/threads/${encodeURIComponent(threadId)}`,
          {
            headers: { authorization: `Bearer ${registration.runtimeToken}` },
            signal: AbortSignal.timeout(5_000)
          }
        ).catch(() => null)
        const detail = detailResponse?.ok
          ? await detailResponse.json().catch(() => null) as { turns?: unknown } | null
          : null
        turns = Array.isArray(detail?.turns) ? detail.turns : []
      }
      const activeTurn = turns.find((turn) => {
        const status = turn && typeof turn === 'object' ? (turn as { status?: unknown }).status : undefined
        return status === 'queued' || status === 'in_progress' || status === 'started' || status === 'running'
      }) as { id?: unknown; turnId?: unknown } | undefined
      if (!threadActive && !activeTurn) continue
      const turnId = typeof activeTurn?.id === 'string'
        ? activeTurn.id
        : typeof activeTurn?.turnId === 'string' ? activeTurn.turnId : ''
      work.push({
        kind: 'turn',
        id: `${flavor}:${threadId}:${turnId}`,
        label: typeof value.title === 'string' && value.title.trim()
          ? value.title.trim()
          : `${flavor} thread ${threadId || 'unknown'}`,
        interruptible: Boolean(threadId && turnId)
      })
    }
  }
  return work
}
